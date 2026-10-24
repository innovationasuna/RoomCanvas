// Optional browser acceptance tool. No build step or benchmark dependency in the editor.
// node web/scripts/check_lighting.mjs --output /tmp/roomcanvas-lighting --playwright /path/to/node_modules/playwright
import {parseArgs} from 'node:util';
import {createRequire} from 'node:module';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

const {values} = parseArgs({options: {url: {type:'string', default:'http://127.0.0.1:7880/web/'},
  output: {type:'string'}, playwright: {type:'string'}, browser: {type:'string'}, rooms: {type:'string', default:'room3,office'},
  variants: {type:'string', default:'original,initial,balanced,balanced-no-ao,balanced-n8ao'}, frames: {type:'string', default:'90'}}});
if (!values.output) throw new Error('请指定 --output 到仓库外的结果目录（含私人房间截图）');
const output = resolve(values.output), repo = fileURLToPath(new URL('../../', import.meta.url));
if (output === repo || output.startsWith(repo + '/')) throw new Error('基线结果请写到仓库外，不提交私人截图');
const {chromium} = createRequire(import.meta.url)(values.playwright ? resolve(values.playwright) : 'playwright');
const manifest = JSON.parse(await readFile(new URL('../rooms.json', import.meta.url)));
const variants = {
  original: 'lighting=off', initial: 'lighting=initial', balanced: 'lighting=balanced',
  'balanced-no-ao': 'lighting=balanced&ao=off', 'balanced-n8ao': 'lighting=balanced&ao=n8ao',
  'balanced-original-shadows': 'lighting=balanced&ao=off&shadows=original',
};
const names = values.variants.split(',');
for (const name of names) if (!(name in variants)) throw new Error('未知对照档位 ' + name);
const frameCount = Number(values.frames);
if (!Number.isInteger(frameCount) || frameCount < 10 || frameCount > 1200) throw new Error('--frames 应为 10–1200');
await mkdir(output, {recursive:true});
const browser = await chromium.launch({headless:true, ...(values.browser ? {executablePath: values.browser} : {})});
const report = {version:1, recordedAt:new Date().toISOString(), userAgent:null, conditions:{viewport:[1440,1000],dpr:1,handTracking:false,frameCount}, rooms:[]};
try {
  for (const id of values.rooms.split(',')) {
    const entry = manifest.rooms.find(room => room.id === id);
    if (!entry) throw new Error('未知房间 ' + id);
    const modelPath = new URL(entry.dir.replace(/\/$/,'') + '/Room.glb', new URL('../rooms.json',import.meta.url));
    const modelSha256 = createHash('sha256').update(await readFile(modelPath)).digest('hex');
    const room = {id,modelSha256,state:null,variants:[]}; report.rooms.push(room);
    for (const name of names) {
      console.log(`检查 ${id}: ${name}`);
      const page = await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1});
      const errors = [];
      page.on('pageerror',error => errors.push(String(error)));
      page.on('console',message => {if (message.type()==='error') errors.push(message.text());});
      // Lighting acceptance is independent of the reconstruction server and object catalog.
      await page.route('**/viewforge/**',route => route.fulfill({status:200,contentType:'application/json',body:'{"runs":[]}'}));
      const loadStarted = performance.now();
      await page.goto(new URL(`editor/?room=${encodeURIComponent(id)}&lightingLab=1&time=balanced&indoor=off&${variants[name]}`,values.url).href,{waitUntil:'domcontentloaded'});
      const settled = async () => {
        await page.waitForFunction(() => {
          if (window.roomEditorError) throw new Error(window.roomEditorError);
          const light = window.roomEditor?.snapshot().lighting;
          return light && !['waiting','loading'].includes(light.state) && light.environment.state !== 'loading';
        },null,{timeout:180000});
        const light = await page.evaluate(() => roomEditor.snapshot().lighting);
        assert.ok(!['error','unsupported'].includes(light.state),JSON.stringify(light));
        assert.ok(!['error','unsupported'].includes(light.environment.state),JSON.stringify(light));
      };
      await settled();
      const loadToSettledMs = performance.now() - loadStarted;
      const initialization = await page.evaluate(() => roomLightingLab.metrics());
      if (!room.state) {
        room.state = await page.evaluate(() => roomLightingLab.captureState());
        await writeFile(join(output,`${id}-state.json`),JSON.stringify({modelSha256,state:room.state},null,2));
      }
      await page.evaluate(state => roomLightingLab.restoreState(state),room.state);
      await page.waitForTimeout(450); await settled();
      const state = await page.evaluate(() => roomLightingLab.captureState());
      assert.deepEqual(state.layout,room.state.layout);
      for (const key of ['position','quaternion','target']) state.camera[key].forEach((v,i) => assert.ok(Math.abs(v-room.state.camera[key][i])<1e-6));
      report.userAgent ||= await page.evaluate(() => navigator.userAgent);
      const result = {name,loadToSettledMs,initialization,device:await page.evaluate(() => roomLightingLab.device()),lighting:await page.evaluate(() => roomEditor.snapshot().lighting),
        materials:await page.evaluate(() => roomLightingLab.materials()),errors};
      const capture = async suffix => {
        const data = await page.evaluate(() => roomEditor.captureFrame());
        await writeFile(join(output,`${id}-${name}-${suffix}.png`),Buffer.from(data.split(',')[1],'base64'));
      };
      await capture('overview');
      await page.evaluate(zoom => roomLightingLab.zoom(zoom*1.6),room.state.camera.zoom);
      await page.waitForTimeout(450); await settled(); await capture('detail');
      await page.evaluate(state => roomLightingLab.restoreState(state),room.state);
      await page.waitForTimeout(450); await settled();
      await page.evaluate(() => roomLightingLab.resetMetrics());
      await page.waitForTimeout(650);
      assert.equal((await page.evaluate(() => roomLightingLab.metrics())).frames.length,0,'静止时仍在渲染');
      result.idleFrames = 0;
      result.rafIntervalsMs = await page.evaluate(async ({state,count}) => {
        const intervals = []; let previous = null;
        for (let i=0;i<count;i++) {
          const time = await new Promise(resolve => requestAnimationFrame(resolve));
          if (previous !== null) intervals.push(time-previous); previous=time;
          roomLightingLab.orbit(state,.35*Math.sin(i/(count-1)*Math.PI*2));
        }
        await new Promise(resolve => requestAnimationFrame(resolve));
        return intervals;
      },{state:room.state,count:frameCount});
      await page.waitForTimeout(450); await settled();
      // Repeated finite static submissions give a distribution; never run a permanent idle loop.
      for (let sample=0;sample<4;sample++) {
        await page.evaluate(({state,angle}) => roomLightingLab.orbit(state,angle),{state:room.state,angle:sample%2 ? 0 : .02});
        await page.waitForTimeout(450); await settled();
      }
      const start = Date.now();
      while ((await page.evaluate(() => roomLightingLab.metrics())).pendingQueries && Date.now()-start<5000) await page.waitForTimeout(20);
      result.performance = await page.evaluate(() => roomLightingLab.metrics());
      assert.deepEqual(errors,[]);
      room.variants.push(result);
      await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));
      await page.close();
    }
  }
} finally {await browser.close();}
console.log(`通过：${report.rooms.length} 个房间；报告与截图：${output}`);
