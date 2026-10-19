import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRenderMetrics,summarizeFrames} from '../render-metrics.mjs';

function fixture({disjoint=false,gpu=false}={}) {
  let deleted=0,started=0,ended=0,time=0;
  const extension={TIME_ELAPSED_EXT:1,GPU_DISJOINT_EXT:2};
  const gl={CURRENT_QUERY:3,QUERY_RESULT_AVAILABLE:4,QUERY_RESULT:5,
    getExtension:() => gpu?extension:null, getParameter:() => disjoint, getQuery:() => null,
    createQuery:() => ({}), beginQuery:() => started++, endQuery:() => ended++,
    getQueryParameter:(_query,p) => p===4?true:2500000, deleteQuery:() => deleted++};
  const info={autoReset:true,render:{calls:0,triangles:0},memory:{textures:3,geometries:4},
    reset(){this.render.calls=this.render.triangles=0;}};
  const renderer={info,getContext:() => gl};
  const metrics=createRenderMetrics(renderer,{gpu,clock:{now:() => time++ * 2}});
  return {info,metrics,get deleted(){return deleted;},get started(){return started;},get ended(){return ended;}};
}

test('one measured frame counts all render passes, including the final composition', () => {
  const f=fixture(); assert.equal(f.info.autoReset,false);
  f.metrics.measure('static-ao',() => {f.info.render.calls+=10;f.info.render.triangles+=100;f.info.render.calls+=12;f.info.render.triangles+=120;});
  assert.equal(f.metrics.last.calls,22); assert.equal(f.metrics.last.triangles,220);
  assert.equal(f.metrics.last.cpuSubmitMs,2);assert.equal(f.metrics.last.gpuMs,null);
  f.metrics.measure('interactive',() => {f.info.render.calls=8;});assert.equal(f.metrics.last.calls,8);
  assert.equal(f.metrics.snapshot().summary['static-ao'].calls,22);
  f.metrics.dispose();assert.equal(f.info.autoReset,true);
});

test('GPU results are asynchronous, distinguish unsupported timing, and release queries', async () => {
  const f=fixture({gpu:true});f.metrics.measure('interactive',() => {});
  assert.equal(f.metrics.last.gpuMs,null); assert.equal(f.started,1);assert.equal(f.ended,1);
  await new Promise(resolve => setTimeout(resolve,40));
  assert.equal(f.metrics.last.gpuMs,2.5);assert.equal(f.metrics.last.gpuStatus,'valid');assert.equal(f.deleted,1);
  f.metrics.dispose();
});

test('disjoint GPU results are excluded from performance summaries', async () => {
  const f=fixture({gpu:true,disjoint:true});f.metrics.measure('interactive',() => {});
  await new Promise(resolve => setTimeout(resolve,40));
  assert.equal(f.metrics.last.gpuMs,null);assert.equal(f.metrics.last.gpuStatus,'disjoint');
  assert.equal(f.metrics.snapshot().summary.interactive.gpuSamples,0);f.metrics.dispose();
});

test('CPU and GPU percentiles stay separate and missing GPU samples are not treated as zero', () => {
  const frames=Array.from({length:20},(_,i) => ({label:'interactive',cpuSubmitMs:i+1,gpuMs:i===0?3:null,calls:2,triangles:10}));
  const s=summarizeFrames(frames).interactive;
  assert.deepEqual(s.cpuSubmitMs,{p50:10,p95:19});assert.deepEqual(s.gpuMs,{p50:3,p95:3});assert.equal(s.gpuSamples,1);
});
