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
  'asset-edits': {type:'boolean', default:false}, 'editor-queries': {type:'boolean', default:false}, variants: {type:'string', default:'original,initial,balanced,balanced-no-ao,balanced-n8ao'}, frames: {type:'string', default:'90'}}});
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
const chair = values['asset-edits'] ? await readFile(new URL('../../gesture/public/models/furniture/chair.glb', import.meta.url)) : null;
await mkdir(output, {recursive:true});
const browser = await chromium.launch({headless:true, ...(values.browser ? {executablePath: values.browser} : {})});
const report = {version:1, recordedAt:new Date().toISOString(), userAgent:null, conditions:{viewport:[1440,1000],dpr:1,handTracking:false,frameCount,assetEditModelSha256:chair ? createHash('sha256').update(chair).digest('hex') : null}, rooms:[]};
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
      // Capture startup as well as interaction without enabling observers in the shipped editor.
      await page.addInitScript(() => {
        const pageStates = [], longTasks = [];
        const recordState = () => pageStates.push({atMs: performance.now(),
          visibility: document.visibilityState, focused: document.hasFocus()});
        recordState();
        document.addEventListener('visibilitychange', recordState);
        window.addEventListener('focus', recordState);
        window.addEventListener('blur', recordState);
        const collect = entries => {
          for (const entry of entries) longTasks.push({atMs: entry.startTime, durationMs: entry.duration});
        };
        const observer = PerformanceObserver.supportedEntryTypes.includes('longtask')
          ? new PerformanceObserver(list => collect(list.getEntries())) : null;
        observer?.observe({type: 'longtask', buffered: true});
        window.readBenchmarkActivity = () => {
          if (observer) collect(observer.takeRecords());
          return {pageStates, longTasks: observer ? longTasks : null};
        };
      });
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
      // Exercise asset edits after collecting lighting frames so the workloads can be compared separately.
      const supportsStages = await page.evaluate(() => typeof roomLightingLab.stageTimings === 'function');
      if (chair && supportsStages) {
        await page.route('**/viewforge/assets/benchmark-chair/*.glb', route => route.fulfill({body: chair, contentType: 'model/gltf-binary'}));
        await page.evaluate(async () => {
          const base = {bounds: {min: [-.3275, 0, -.32], max: [.3275, 1.015, .31]},
            transform: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]};
          await roomLightingLab.importObject('benchmark-chair', base, 1);
          const remove = document.querySelector('.rc-remove-object');
          if (!remove) throw new Error('导入后未出现删除按钮');
          remove.click();
          if (remove.isConnected) throw new Error('删除后仍有物品卡片');
        });
      }
      result.editorStages = supportsStages ? await page.evaluate(() => roomLightingLab.stageTimings()) : null;
      if (result.editorStages) {
        const has = (operation, stage) => result.editorStages.some(row =>
          row.operation === operation && row.stage === stage && Number.isFinite(row.durationMs) && row.durationMs >= 0);
        for (const stage of ['modelReadAndParse','placement','collisionGeometry','collisionMainBuild','collisionWorkerSubmit','thumbnails'])
          assert.ok(has('initial', stage), '缺少初次加载计时 ' + stage);
        if (chair) for (const [operation, stage] of [['import','rebuild'], ['import','floorSearch'], ['delete','rebuild']])
          assert.ok(has(operation, stage), '缺少资产编辑计时 ' + operation + '/' + stage);
      }
      if (values['editor-queries']) {
        result.editorQueries = await page.evaluate(() => roomLightingLab.queryBenchmark());
        assert.equal(result.editorQueries.baseline.mismatches, 0, '原始姿态射线与 Three.js 不一致');
        assert.equal(result.editorQueries.articulated.mismatches, 0, '开合部件射线与 Three.js 不一致');
        await page.waitForFunction(() => roomLightingLab.geometryStatus().workerReady, null, {timeout: 60000});
        result.collisionProbe = await page.evaluate(async () => {
          const objects = roomEditor.snapshot().objects;
          const object = objects.find((row) => /piano/i.test(row.id)) || objects.find((row) => /table|desk/i.test(row.id)) || objects[0];
          return {id: object.id, ...await roomLightingLab.collisionProbe(object.id, {y: .12})};
        });
        assert.ok(result.collisionProbe.worker, 'Worker 请求被意外取消');
        assert.deepEqual(result.collisionProbe.worker.contact, result.collisionProbe.main.contact);
        assert.deepEqual(result.collisionProbe.worker.sweep, result.collisionProbe.main.sweep);
        await page.locator('[data-mode="preview"]').click();
        await page.locator('[data-mode="walk"]').click();
        await page.waitForFunction(() => roomEditor.snapshot().walk.active);
        result.walkStart = await page.evaluate(() => roomEditor.snapshot().walk);
        await page.keyboard.down('KeyW');
        try {
          result.walkRafIntervalsMs = await page.evaluate(async () => {
            const intervals = []; let last = await new Promise(requestAnimationFrame);
            for (let i = 0; i < 30; i++) {const time = await new Promise(requestAnimationFrame); intervals.push(time - last); last = time;}
            return intervals;
          });
        } finally {await page.keyboard.up('KeyW');}
        result.walkEnd = await page.evaluate(() => roomEditor.snapshot().walk);
        assert.ok([...result.walkStart.position, ...result.walkEnd.position].every(Number.isFinite));
        await capture('walk');
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !roomEditor.snapshot().walk.active);
      }
      result.activity = await page.evaluate(() => window.readBenchmarkActivity());
      assert.deepEqual(errors,[]);
      room.variants.push(result);
      await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));
      await page.close();
    }
  }
} finally {await browser.close();}
console.log(`通过：${report.rooms.length} 个房间；报告与截图：${output}`);
