import {describe,it,expect} from 'vitest';
import {Controller} from '../../src/controls/controller';
import type {ScenePort,SceneId,CameraPose,Point,Pointer,Transform,GestureFrame,HandSignal} from '../../src/shared/types';
class FakeScene implements ScenePort{
 active:SceneId='furniture';values:Record<string,Transform>={sofa:{position:{x:0,y:0,z:0},rotation:0,scale:1},cursor:{position:{x:0,y:1,z:0},rotation:0,scale:1}};camera:CameraPose={theta:0,phi:1,radius:8};
 pick(){return this.active==='xyz'?'cursor':'sofa';}floorPoint(p:Pointer){return {x:p.x*4,y:0,z:p.y*4};}
 info(id:string){return {id,label:id,size:{x:2,y:1,z:1},transform:structuredClone(this.values[id])};}
 apply(id:string,t:Transform){this.values[id]=structuredClone(t);}highlight(){}getCamera(){return {...this.camera};}setCamera(p:CameraPose){this.camera=p;}
 cameraAxes(){return {right:{x:1,y:0,z:0},up:{x:0,y:1,z:0},forward:{x:0,y:0,z:-1}};}
 switchScene(s:SceneId){this.active=s;}snapshot(){return {[this.active==='xyz'?'cursor':'sofa']:structuredClone(this.values[this.active==='xyz'?'cursor':'sofa'])};}
 restore(snapshot:Record<string,Transform>){for(const [id,t]of Object.entries(snapshot))this.apply(id,t);}reset(){this.values.sofa={position:{x:0,y:0,z:0},rotation:0,scale:1};}
}
const signal=(x=.5,overrides:Partial<HandSignal>={}):HandSignal=>({pointer:{x,y:.5},wrist:{x,y:.5},palmScale:.2,frontFacing:true,pinching:true,started:false,ended:false,openPalm:false,...overrides});
const frame=(operator?:HandSignal,extra:Partial<GestureFrame>={}):GestureFrame=>({timestamp:100,operator,menuRequested:false,interrupted:false,ambiguous:false,...extra});
describe('识别事件到场景变换',()=>{
 it('保留抓取偏移，释放后可撤销',()=>{
  const scene=new FakeScene(),control=new Controller(scene);control.input(frame(signal(.5,{started:true})));control.input(frame(signal(.6)));
  expect(scene.values.sofa.position.x).toBeCloseTo(.4);control.input(frame(signal(.6,{pinching:false,ended:true})));expect(control.undoCount).toBe(1);control.action('undo');expect(scene.values.sofa.position.x).toBe(0);
 });
 it('失踪冻结且不提交；恢复松手后才能开始',()=>{
  const scene=new FakeScene(),control=new Controller(scene);control.input(frame(signal(.5,{started:true})));control.input(frame(signal(.6)));const position=structuredClone(scene.values.sofa.position);
  control.input(frame(undefined,{interrupted:true}));expect(control.undoCount).toBe(0);control.input(frame(signal(.9,{started:true})));expect(scene.values.sofa.position).toEqual(position);
  control.input(frame(signal(.9,{pinching:false})));control.input(frame(signal(.9,{started:true})));expect(control.grabbing).toBe(true);
 });
 it('深度在转掌时冻结，转回不跳变',()=>{
  const scene=new FakeScene();scene.active='xyz';const control=new Controller(scene);
  control.input(frame(signal(.5,{started:true})));control.input(frame(signal(.5,{palmScale:.24})));const z=scene.values.cursor.position.z;
  control.input(frame(signal(.5,{palmScale:.12,frontFacing:false})));expect(scene.values.cursor.position.z).toBe(z);
  control.input(frame(signal(.5,{palmScale:.2})));expect(scene.values.cursor.position.z).toBe(z);
 });
 it('复位有撤销记录，且真实家具拒绝缩放',()=>{
  const scene=new FakeScene(),control=new Controller(scene);scene.values.sofa.position.x=1;control.action('confirm-reset');expect(control.undoCount).toBe(1);control.action('undo');expect(scene.values.sofa.position.x).toBe(1);
  control.action('scale');expect(control.mode).toBe('move');
 });
 it('中断预览可撤销，且跨场景不会混用快照',()=>{
  const scene=new FakeScene(),control=new Controller(scene);control.input(frame(signal(.5,{started:true})));control.input(frame(signal(.7)));control.interrupt();
  control.action('xyz');control.needsRelease=false;control.input(frame(signal(.5,{started:true})));control.input(frame(signal(.6)));control.input(frame(signal(.6,{pinching:false,ended:true})));
  expect(control.undoCount).toBe(1);control.action('undo');expect(scene.values.cursor.position.x).toBe(0);expect(scene.values.sofa.position.x).toBeCloseTo(.8);
  control.action('furniture');control.action('undo');expect(scene.values.sofa.position.x).toBe(0);
 });
 it('双手缩放结束需松手，不退回单手导致跳变',()=>{
  const scene=new FakeScene(),control=new Controller(scene);control.mode='observe';
  control.input(frame(signal(.3),{helper:signal(.7)}));control.input(frame(signal(.2),{helper:signal(.8)}));expect(scene.camera.radius).toBeCloseTo(8*.4/.6);
  control.input(frame(signal(.2),{helper:signal(.8,{pinching:false,ended:true})}));expect(control.needsRelease).toBe(true);expect(control.grabbing).toBe(false);
  control.input(frame(signal(.2,{pinching:false}),{helper:signal(.8)}));expect(control.needsRelease).toBe(true);
  control.input(frame(signal(.2,{pinching:false}),{helper:signal(.8,{pinching:false})}));expect(control.needsRelease).toBe(false);
 });
 it('双手缩放时辅助手失踪不提交，长中断后可撤销预览',()=>{
  const scene=new FakeScene();scene.active='xyz';const control=new Controller(scene);control.mode='scale';
  control.input(frame(signal(.3),{helper:signal(.7)}));control.input(frame(signal(.2),{helper:signal(.8)}));
  const scale=scene.values.cursor.scale;control.input(frame(signal(.1)));expect(scene.values.cursor.scale).toBe(scale);expect(control.undoCount).toBe(0);
  control.input(frame(signal(.1),{helperInterrupted:true}));expect(control.grabbing).toBe(false);control.action('undo');expect(scene.values.cursor.scale).toBe(1);
 });
 it('辅助手中断不会打断无关的单手家具操作',()=>{
  const scene=new FakeScene(),control=new Controller(scene);control.input(frame(signal(.5,{started:true})));
  control.input(frame(signal(.6),{helperInterrupted:true}));expect(control.grabbing).toBe(true);expect(scene.values.sofa.position.x).toBeCloseTo(.4);
 });
 it('左手单独捏合可在移动模式环绕视角，不改物体或历史',()=>{
  const scene=new FakeScene(),control=new Controller(scene),before=scene.snapshot();
  control.input(frame(undefined,{helper:signal(.3,{started:true})}));control.input(frame(undefined,{helper:signal(.4,{pointer:{x:.4,y:.6}})}));
  expect(scene.camera.theta).toBeCloseTo(-.2*Math.PI);expect(scene.camera.phi).toBeCloseTo(1-.1*Math.PI);
  expect(scene.snapshot()).toEqual(before);expect(control.undoCount).toBe(0);expect(control.viewing).toBe(true);
  control.input(frame(undefined,{helper:signal(.4,{pinching:false,ended:true})}));expect(control.viewing).toBe(false);
 });
 it('右手缺席中断事件不会打断独立左手环绕',()=>{
  const scene=new FakeScene(),control=new Controller(scene);control.input(frame(undefined,{helper:signal(.3,{started:true})}));
  control.input(frame(undefined,{helper:signal(.4),interrupted:true}));expect(control.viewing).toBe(true);expect(scene.camera.theta).toBeCloseTo(-.2*Math.PI);
 });
 it('右手抓取期间左手可环绕，松开左手不结束物体抓取',()=>{
  const scene=new FakeScene(),control=new Controller(scene);control.input(frame(signal(.5,{started:true})));
  control.input(frame(signal(.6),{helper:signal(.8,{started:true})}));control.input(frame(signal(.7),{helper:signal(.9)}));
  expect(scene.camera.theta).toBeCloseTo(-.2*Math.PI);expect(scene.values.sofa.position.x).toBeCloseTo(.8);
  control.input(frame(signal(.8),{helper:signal(.9,{pinching:false,ended:true})}));expect(control.grabbing).toBe(true);expect(control.viewing).toBe(false);expect(scene.values.sofa.position.x).toBeCloseTo(1.2);
  control.input(frame(signal(.8,{pinching:false,ended:true})));expect(control.undoCount).toBe(1);control.action('undo');expect(scene.values.sofa.position.x).toBe(0);
 });
 it('左手先环绕也可开始右手抓取，松右手后左手继续',()=>{
  const scene=new FakeScene(),control=new Controller(scene);control.input(frame(undefined,{helper:signal(.3,{started:true})}));
  control.input(frame(signal(.5,{started:true}),{helper:signal(.4)}));control.input(frame(signal(.6),{helper:signal(.5)}));expect(scene.values.sofa.position.x).toBeCloseTo(.4);
  control.input(frame(signal(.6,{pinching:false,ended:true}),{helper:signal(.6)}));expect(control.viewing).toBe(true);expect(scene.camera.theta).toBeCloseTo(-.6*Math.PI);expect(control.undoCount).toBe(1);
 });
 it('地板投影随相机改变时，静止右手不拖走家具，移动仍生效',()=>{
  const scene=new FakeScene();scene.floorPoint=p=>({x:p.x*4+scene.camera.theta,y:0,z:p.y*4});const control=new Controller(scene);
  control.input(frame(signal(.5,{started:true}),{helper:signal(.3,{started:true})}));control.input(frame(signal(.5),{helper:signal(.4)}));expect(scene.values.sofa.position.x).toBeCloseTo(0);
  control.input(frame(signal(.6),{helper:signal(.5)}));expect(scene.values.sofa.position.x).toBeCloseTo(.4);
 });
 it('XYZ 环绕重建相机平面映射，静止光标保持位置',()=>{
  const scene=new FakeScene();scene.active='xyz';scene.cameraAxes=()=>({right:{x:Math.cos(scene.camera.theta),y:0,z:Math.sin(scene.camera.theta)},up:{x:0,y:1,z:0},forward:{x:-Math.sin(scene.camera.theta),y:0,z:Math.cos(scene.camera.theta)}});
  const control=new Controller(scene);control.input(frame(signal(.5,{started:true}),{helper:signal(.3,{started:true})}));control.input(frame(signal(.6),{helper:signal(.3)}));const before=structuredClone(scene.values.cursor);
  control.input(frame(signal(.6),{helper:signal(.4)}));expect(scene.values.cursor).toEqual(before);control.input(frame(signal(.7),{helper:signal(.4)}));expect(scene.values.cursor.position.z).not.toBe(before.position.z);
 });
 it('左右手分别中断，不停止另一只手会话',()=>{
  const scene=new FakeScene(),control=new Controller(scene);control.input(frame(signal(.5,{started:true}),{helper:signal(.3,{started:true})}));
  control.input(frame(signal(.6),{helperInterrupted:true}));expect(scene.values.sofa.position.x).toBeCloseTo(.4);expect(control.viewing).toBe(false);
  control.input(frame(signal(.7),{helper:signal(.3,{pinching:false})}));control.input(frame(signal(.7),{helper:signal(.3,{started:true})}));
  control.input(frame(undefined,{interrupted:true,helper:signal(.4)}));expect(control.viewing).toBe(true);expect(scene.camera.theta).toBeCloseTo(-.2*Math.PI);expect(control.undoCount).toBe(0);
 });
 it('左手丢失即冻结，长中断后握住恢复不会旋转跳变',()=>{
  const scene=new FakeScene(),control=new Controller(scene);control.input(frame(undefined,{helper:signal(.3,{started:true})}));control.input(frame(undefined,{helper:signal(.4)}));const theta=scene.camera.theta;
  control.input(frame());expect(scene.camera.theta).toBe(theta);control.input(frame(undefined,{helperInterrupted:true}));expect(control.grabbing).toBe(false);
  control.input(frame(undefined,{helper:signal(.9,{started:true})}));expect(scene.camera.theta).toBe(theta);
  control.input(frame(undefined,{helper:signal(.9,{pinching:false})}));control.input(frame(undefined,{helper:signal(.9,{started:true})}));expect(scene.camera.theta).toBe(theta);
 });
 it('暂停和菜单中断阻止左手继续转动，左手单独释放可解除门控',()=>{
  const scene=new FakeScene(),control=new Controller(scene);control.input(frame(undefined,{helper:signal(.3,{started:true})}));control.action('pause');
  control.input(frame(undefined,{helper:signal(.4)}));expect(scene.camera.theta).toBe(0);
  control.input(frame(undefined,{helper:signal(.4,{pinching:false})}));control.input(frame(undefined,{helper:signal(.5,{started:true})}));expect(scene.camera.theta).toBe(0);
  control.action('resume');control.input(frame(undefined,{helper:signal(.5,{pinching:false})}));control.input(frame(undefined,{helper:signal(.5,{started:true})}));control.input(frame(undefined,{helper:signal(.6)}));expect(scene.camera.theta).toBeCloseTo(-.2*Math.PI);
 });
 it('观察模式双手捏合优先缩放，结束后不自动回到左手环绕',()=>{
  const scene=new FakeScene(),control=new Controller(scene);control.mode='observe';control.input(frame(undefined,{helper:signal(.7,{started:true})}));
  control.input(frame(signal(.3,{started:true}),{helper:signal(.7)}));control.input(frame(signal(.2),{helper:signal(.8)}));expect(scene.camera.radius).toBeCloseTo(8*.4/.6);expect(scene.camera.theta).toBe(0);
  control.input(frame(signal(.2,{pinching:false,ended:true}),{helper:signal(.8)}));control.input(frame(undefined,{helper:signal(.9)}));expect(scene.camera.theta).toBe(0);expect(control.needsRelease).toBe(true);
 });
});

describe('释放时冻结控制、提交稳定结果',()=>{
 it('升高物体与左手视角在释放待确认时均忽略突然上移',()=>{
  const scene=new FakeScene(),control=new Controller(scene);control.mode='height';
  control.input(frame(signal(.5,{started:true}),{helper:signal(.8,{started:true})}));
  control.input(frame(signal(.5,{pointer:{x:.5,y:.45}}),{helper:signal(.82,{pointer:{x:.82,y:.45}})}));const stable=scene.snapshot(),camera=scene.getCamera();
  control.input(frame(signal(.5,{pointer:{x:.5,y:.2},releasing:true}),{helper:signal(.82,{pointer:{x:.82,y:.2},releasing:true})}));
  expect(scene.snapshot()).toEqual(stable);expect(scene.getCamera()).toEqual(camera);expect(control.undoCount).toBe(0);
  control.input(frame(signal(.5,{pinching:false,ended:true,releasing:true}),{helper:signal(.82,{pinching:false,ended:true,releasing:true})}));
  expect(scene.snapshot()).toEqual(stable);expect(scene.getCamera()).toEqual(camera);expect(control.grabbing).toBe(false);expect(control.undoCount).toBe(1);
 });
 it('右手释放时左手仍可环绕，左手释放时右手仍可移动',()=>{
  const scene=new FakeScene(),control=new Controller(scene);control.input(frame(signal(.5,{started:true}),{helper:signal(.8,{started:true})}));
  control.input(frame(signal(.7,{releasing:true}),{helper:signal(.9)}));expect(scene.values.sofa.position.x).toBe(0);expect(scene.camera.theta).not.toBe(0);const camera=scene.getCamera();
  control.input(frame(signal(.6),{helper:signal(.95,{releasing:true})}));expect(scene.values.sofa.position.x).toBeCloseTo(.4);expect(scene.getCamera()).toEqual(camera);
 });
 it('双手缩放在任一手张开时冻结，确认后只提交一次',()=>{
  const scene=new FakeScene();scene.active='xyz';const control=new Controller(scene);control.mode='scale';
  control.input(frame(signal(.3),{helper:signal(.7)}));control.input(frame(signal(.2),{helper:signal(.8)}));const scale=scene.values.cursor.scale;
  control.input(frame(signal(.1,{releasing:true}),{helper:signal(.9)}));expect(scene.values.cursor.scale).toBe(scale);
  control.input(frame(signal(.1,{pinching:false,ended:true,releasing:true}),{helper:signal(.9)}));expect(scene.values.cursor.scale).toBe(scale);expect(control.undoCount).toBe(1);
 });
});
