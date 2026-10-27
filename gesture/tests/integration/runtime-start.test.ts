import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {GestureRuntime} from '../../src/integration/runtime';

vi.mock('../../src/tracking/tracker',()=>({Tracker:class {set onFrame(_:unknown){} async start(){} stop(){} detect(){}}}));
vi.mock('../../src/camera/camera',()=>({CameraSource:class {async start(){return true;}stop(){}}}));

beforeEach(()=>{
 vi.stubGlobal('navigator',{mediaDevices:{getUserMedia:vi.fn()}});
 vi.stubGlobal('document',{hidden:false});
 vi.stubGlobal('requestAnimationFrame',()=>1);vi.stubGlobal('cancelAnimationFrame',()=>{});
});
afterEach(()=>{vi.unstubAllGlobals();});

it('开启摄像头不取消鼠标拖出的预览；关闭正在运行的摄像头才取消',async()=>{
 const cancels:boolean[]=[];
 const runtime=new GestureRuntime({videoWidth:640,videoHeight:480} as HTMLVideoElement,{
  frame(){},canSwitch:()=>true,confirmationTarget:()=>({previewId:null,allowed:false}),
  interrupted(cancelPending){cancels.push(cancelPending);},error(message){throw new Error(message);},
 });
 expect(await runtime.start()).toBe(true);
 expect(cancels).not.toContain(true);
 runtime.stop();
 expect(cancels.at(-1)).toBe(true);
 runtime.stop();  // 已经关了，再关不再发取消
 expect(cancels.filter(Boolean)).toHaveLength(1);
});
