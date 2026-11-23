// Chrome acceptance: fresh browser context, same-context reload and wheel-to-render latency.
import {parseArgs} from 'node:util';
import {createRequire} from 'node:module';
import {writeFile, readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

const {values} = parseArgs({options: {url: {type:'string', default:'http://127.0.0.1:7880/web/'},
  output: {type:'string'}, playwright: {type:'string'}, browser: {type:'string'}}});
if (!values.output) throw new Error('--output is required');
const {chromium} = createRequire(import.meta.url)(values.playwright ? resolve(values.playwright) : 'playwright');
const browser = await chromium.launch({headless:true, ...(values.browser ? {executablePath:values.browser} : {})});
const report = {recordedAt:new Date().toISOString(), conditions:{viewport:[1440,1000],dpr:1,rounds:5,
  lighting:'balanced-no-ao',handTracking:false,latency:'wheel event received to first WebGL drawing RAF callback completion; excludes OS input and compositor presentation'}, rooms:[]};
const manifest = JSON.parse(await readFile(new URL('../rooms.json',import.meta.url)));
try {
  for (const id of ['office','room3']) {
    const entry = manifest.rooms.find(room => room.id === id);
    const model = await readFile(new URL(entry.dir.replace(/\/$/,'')+'/Room.glb',new URL('../rooms.json',import.meta.url)));
    const result = {id,modelSha256:createHash('sha256').update(model).digest('hex'),rounds:[]}; report.rooms.push(result);
    for (let round=0;round<5;round++) {
      const context = await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:1});
      const page = await context.newPage(), errors=[];
      page.on('pageerror', error => errors.push(String(error)));
      await page.addInitScript(() => {
        const state = window.inputBenchmark = {samples:[],pending:null,draws:0};
        for (const name of ['drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced']) {
          const original = WebGL2RenderingContext.prototype[name];
          WebGL2RenderingContext.prototype[name] = function(...args) {state.draws++; return original.apply(this,args);};
        }
        const raf = window.requestAnimationFrame.bind(window);
        window.requestAnimationFrame = callback => raf(time => {
          const before = state.draws;
          try { return callback(time); }
          finally { if (state.draws>before && state.pending!==null) {
            state.samples.push({ms:performance.now()-state.pending,visible:document.visibilityState,focused:document.hasFocus()});
            state.pending=null;
          } }
        });
        document.addEventListener('wheel', () => {state.pending=performance.now();}, {capture:true,passive:true});
      });
      const row = {round};
      for (const phase of ['cold','warm']) {
        const start = performance.now();
        if (phase==='cold') await page.goto(new URL(`editor/?room=${id}&lightingLab=1&time=balanced&indoor=off&lighting=balanced&ao=off`,values.url).href);
        else await page.reload();
        await page.waitForFunction(() => {
          if (window.roomEditorError) throw new Error(window.roomEditorError);
          const light=window.roomEditor?.snapshot().lighting;
          return light && !['waiting','loading'].includes(light.state) && light.environment.state!=='loading';
        },null,{timeout:180000});
        row[phase] = {loadToSettledMs:performance.now()-start,...await page.evaluate(() => ({
          lighting:roomEditor.snapshot().lighting,device:roomLightingLab.device(),
          modelRequests:performance.getEntriesByType('resource').filter(r=>r.name.includes('/Room.glb')).map(r=>({transferSize:r.transferSize,encodedBodySize:r.encodedBodySize,duration:r.duration})),
          visible:document.visibilityState,focused:document.hasFocus()}))};
        assert.ok(!['error','unsupported'].includes(row[phase].lighting.state));
        assert.equal(row[phase].visible,'visible'); assert.equal(row[phase].focused,true);
      }
      await page.waitForTimeout(650);
      const before = await page.evaluate(() => roomLightingLab.captureState().camera.position);
      const box = await page.locator('canvas').first().boundingBox();
      await page.mouse.move(box.x+box.width*.5,box.y+box.height*.5);
      for (let sample=0;sample<10;sample++) {
        await page.mouse.wheel(0,sample%2 ? -80 : 120);
        await page.waitForFunction(n=>inputBenchmark.samples.length>n,sample,{timeout:10000});
        await page.waitForTimeout(100);
      }
      row.inputs = await page.evaluate(() => inputBenchmark.samples);
      row.cameraPosition = [before,await page.evaluate(() => roomLightingLab.captureState().camera.position)];
      assert.notDeepEqual(...row.cameraPosition,'wheel must change the actual camera');
      assert.ok(row.inputs.every(s=>s.visible==='visible' && s.focused)); assert.deepEqual(errors,[]);
      result.rounds.push(row); console.log(id,round,Math.round(row.cold.loadToSettledMs),Math.round(row.warm.loadToSettledMs));
      await context.close();
      await writeFile(values.output,JSON.stringify(report,null,2)+'\n');
    }
  }
} finally {await browser.close();}
