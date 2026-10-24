import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {Hand, TrackingFrame} from '../../src/shared/types';
import {GestureRuntime} from '../../src/integration/runtime';
import {gesturePayload} from '../../src/integration/protocol';
import {NUMBER_MODES} from '../../src/gestures/number-mode';
import {circleThree, hand} from '../fixtures/hands';
// @ts-expect-error 房间接收端是原生 JavaScript，测试直接复用真实的手势路由。
import {GestureInput} from '../../../web/editor/gesture-bridge.mjs';

const tracking=vi.hoisted(()=>({receive:undefined as ((frame:TrackingFrame)=>void)|undefined}));
vi.mock('../../src/tracking/tracker',()=>({Tracker:class {
 set onFrame(fn:(frame:TrackingFrame)=>void){tracking.receive=fn;}
 async start(){} stop(){} detect(){}
}}));
vi.mock('../../src/camera/camera',()=>({CameraSource:class {async start(){return true;}stop(){}}}));

let runtime:GestureRuntime, now=0;
beforeEach(()=>{
 now=0;
 vi.stubGlobal('navigator',{mediaDevices:{getUserMedia:vi.fn()}});
 vi.stubGlobal('document',{hidden:false});
 vi.stubGlobal('requestAnimationFrame',()=>1);vi.stubGlobal('cancelAnimationFrame',()=>{});
 vi.spyOn(performance,'now').mockImplementation(()=>now);
});
afterEach(()=>{runtime?.stop();vi.restoreAllMocks();vi.unstubAllGlobals();});

async function setup(){
 let mode:string='move', zoom=1, baseline={zoom:1,distance:1};
 const calls:string[]=[], selected:number[]=[];
 type Point={u:number;v:number};
 const input=new GestureInput({
  mode:()=>mode,blocked:()=>false,pointer(){},cancel(){},
  begin(){calls.push('grab');return true;},move(){calls.push('move');},release(){calls.push('release');},
  observe:{begin(){calls.push('orbit');return true;},update(){calls.push('orbit-update');},finish(){}},
  scale:{begin(a:Point,b:Point){baseline={zoom,distance:Math.hypot(a.u-b.u,a.v-b.v)};calls.push('scale');return true;},
   update(a:Point,b:Point){zoom=baseline.zoom*Math.hypot(a.u-b.u,a.v-b.v)/baseline.distance;},finish(){}},
 });
 runtime=new GestureRuntime({videoWidth:640,videoHeight:480} as HTMLVideoElement,{
  canSwitch:()=>!input.active&&!input.leftActive&&!input.dual,
  confirmationTarget:()=>({previewId:null,allowed:false}),
  interrupted(){input.interrupt();},error(message){throw new Error(message);},
  frame(frame){
   if(frame.modeSelection && mode!==NUMBER_MODES[frame.modeSelection]){
    selected.push(frame.modeSelection);
    runtime.interrupt(false,true);input.reset();mode=NUMBER_MODES[frame.modeSelection];
   }
   input.input(gesturePayload(frame),now);
  },
 });
 await runtime.start();
 const emit=(hands:Hand[],count=1)=>{for(let i=0;i<count;i++){now+=50;tracking.receive!({timestamp:now,hands,inferenceMs:5});}};
 return {emit,calls,selected,get mode(){return mode;},get zoom(){return zoom;}};
}

describe('真实识别、数字选择与房间手势路由',()=>{
 it('成圈的 3 优先切换缩放，松手后双手捏合改变视图而不移动家具',async()=>{
  const run=await setup();
  run.emit([hand('Left',false,.75),hand('Right',false,.35)],4);
  run.emit([circleThree(.75),hand('Right',false,.35)],12);
  expect(run.selected).toEqual([3]);expect(run.mode).toBe('scale');
  expect(run.calls).toEqual([]);
  run.emit([hand('Left',false,.75),hand('Right',false,.35)],4);
  run.emit([circleThree(.75),hand('Right',true,.35)],4);
  run.emit([circleThree(.85),hand('Right',true,.25)],5);
  expect(run.zoom).toBeGreaterThan(1.1);
  expect(run.calls).toContain('scale');
  expect(run.calls).not.toContain('move');expect(run.calls).not.toContain('grab');
  expect(run.selected).toEqual([3]);
 });
 it('右手正在移动家具时，左手成圈不能抢走当前操作',async()=>{
  const run=await setup();
  run.emit([hand('Left',false,.75),hand('Right',false,.35)],4);
  run.emit([hand('Left',false,.75),hand('Right',true,.35)],4);
  run.emit([circleThree(.75),hand('Right',true,.30)],12);
  expect(run.selected).toEqual([]);expect(run.mode).toBe('move');
  expect(run.calls).toContain('move');expect(run.calls).not.toContain('scale');
  expect(run.calls).not.toContain('release');
 });
 it('普通捏合仍可环绕；短暂的三指姿势不会切换',async()=>{
  const run=await setup();
  run.emit([hand('Left',false,.75)],4);
  run.emit([circleThree(.75)],3);
  expect(run.selected).toEqual([]);expect(run.calls).toEqual([]);
  run.emit([hand('Left',false,.75)],4);
  run.emit([hand('Left',true,.75)],4);
  expect(run.calls).toContain('orbit');expect(run.selected).toEqual([]);
 });
});
