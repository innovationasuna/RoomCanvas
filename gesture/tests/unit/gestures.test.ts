import {describe,it,expect} from 'vitest';
import {GestureEngine,PinchLatch} from '../../src/gestures/engine';
import {features} from '../../src/gestures/features';
import {hand,fist} from '../fixtures/hands';
const frame=(timestamp:number,hands= [hand()])=>({timestamp,hands,inferenceMs:10});
describe('手势时序与安全恢复',()=>{
 it('捏合确认、迟滞与释放确认',()=>{
  const latch=new PinchLatch();expect(latch.update(.1,0).started).toBe(false);expect(latch.update(.1,99).started).toBe(false);expect(latch.update(.1,100).started).toBe(true);
  expect(latch.update(.28,120).pinching).toBe(true);expect(latch.update(.31,130).ended).toBe(false);expect(latch.update(.31,169).ended).toBe(false);expect(latch.update(.31,170).ended).toBe(true);
  expect(latch.update(.31,210).ended).toBe(false);
 });
 it('不足 40ms 的张开抖动不会释放，重新张开需重新计时',()=>{
  const latch=new PinchLatch();latch.update(.1,0);latch.update(.1,100);
  latch.update(.31,110);expect(latch.update(.28,140).pinching).toBe(true);
  latch.update(.31,150);expect(latch.update(.31,180).ended).toBe(false);expect(latch.update(.31,190).ended).toBe(true);
 });
 it('左右手均使用快速释放，抓取仍需 100ms',()=>{
  const engine=new GestureEngine();const hands=(pinch:boolean)=>[hand('Right',pinch,.3),hand('Left',pinch,.8)];
  engine.process(frame(0,hands(false)));engine.process(frame(10,hands(true)));
  const began=engine.process(frame(110,hands(true)));expect(began.operator?.started).toBe(true);expect(began.helper?.started).toBe(true);
  const opened=hands(true).map(h=>{const ratio=features(h).pinchRatio;h.landmarks[4].x=h.landmarks[8].x+.01*.32/ratio;return h;});
  engine.process(frame(120,opened));const pending=engine.process(frame(159,opened));expect(pending.operator?.pinching).toBe(true);expect(pending.helper?.pinching).toBe(true);
  const ended=engine.process(frame(160,opened));expect(ended.operator?.ended).toBe(true);expect(ended.helper?.ended).toBe(true);
 });
 it('中断后握住不重新激活，必须松手再抓取',()=>{
  const engine=new GestureEngine();engine.process(frame(0));engine.process(frame(10,[hand('Right',true)]));expect(engine.process(frame(111,[hand('Right',true)])).operator?.started).toBe(true);
  expect(engine.process(frame(150,[])).interrupted).toBe(false);expect(engine.process(frame(351,[])).interrupted).toBe(true);
  expect(engine.process(frame(400,[hand('Right',true)])).operator?.pinching).toBe(false);
  engine.process(frame(450));engine.process(frame(500,[hand('Right',true)]));expect(engine.process(frame(601,[hand('Right',true)])).operator?.started).toBe(true);
 });
 it('标签变为左手时立即冻结，不以几何距离绕过右手限制',()=>{
  const engine=new GestureEngine();engine.process(frame(0));engine.process(frame(10,[hand('Right',true)]));engine.process(frame(111,[hand('Right',true)]));
  expect(engine.process(frame(150,[hand('Left',true)])).operator).toBeUndefined();
  expect(engine.process(frame(351,[hand('Left',true)])).interrupted).toBe(true);
  expect(engine.process(frame(400,[hand('Right',true)])).operator?.pinching).toBe(false);
 });
 it('只有左手时不接管右手物体指针，释放后仍允许张掌菜单',()=>{
  const engine=new GestureEngine();engine.process(frame(0,[hand('Left',true)]));
  expect(engine.process(frame(150,[hand('Left',true)])).operator).toBeUndefined();
  engine.process(frame(300,[hand('Left')]));engine.process(frame(401,[hand('Left')]));const result=engine.process(frame(1002,[hand('Left')]));
  expect(result.operator).toBeUndefined();expect(result.menuRequested).toBe(true);
 });
 it('仅左手持续捏合超过 200ms，右手缺席不会重置左手会话',()=>{
  const engine=new GestureEngine();engine.process(frame(0,[hand('Left',false,.8)]));engine.process(frame(10,[hand('Left',true,.8)]));
  expect(engine.process(frame(111,[hand('Left',true,.8)])).helper?.started).toBe(true);
  const result=engine.process(frame(300,[hand('Left',true,.8)]));expect(result.interrupted).toBe(true);expect(result.helper?.pinching).toBe(true);
  expect(engine.process(frame(650,[hand('Left',true,.8)])).helper?.pinching).toBe(true);
 });
 it('左手视角身份锁定不会被附近右手或低置信度左手接管',()=>{
  const engine=new GestureEngine();engine.process(frame(0,[hand('Left',false,.8)]));engine.process(frame(10,[hand('Left',true,.8)]));engine.process(frame(111,[hand('Left',true,.8)]));
  expect(engine.process(frame(150,[hand('Right',true,.81)])).helper).toBeUndefined();
  expect(engine.process(frame(170,[{...hand('Left',true,.8),score:.7}])).helper).toBeUndefined();
 });
 it('两手同时入画时始终由右手输出指针，左手只作辅助',()=>{
  const engine=new GestureEngine();const right=hand('Right',false,.25),left=hand('Left',false,.8);
  const result=engine.process(frame(0,[left,right]));
  expect(result.operator?.pointer).toEqual(features(right).pointer);expect(result.helper?.pointer).toEqual(features(left).pointer);
 });
 it('右手丢失时附近的左手不能接管正在抓取的物体',()=>{
  const engine=new GestureEngine();engine.process(frame(0));engine.process(frame(10,[hand('Right',true)]));engine.process(frame(111,[hand('Right',true)]));
  expect(engine.process(frame(150,[hand('Left',true,.51)])).operator).toBeUndefined();
 });
 it('左右手分类置信度不足时不控制',()=>{
  const engine=new GestureEngine();const uncertain={...hand('Right'),score:.7};
  expect(engine.process(frame(0,[uncertain])).operator).toBeUndefined();
 });
 it('两个候选都标为右手时冻结，避免任意接管',()=>{
  const engine=new GestureEngine();const result=engine.process(frame(0,[hand('Right',false,.3),hand('Right',false,.8)]));
  expect(result.operator).toBeUndefined();expect(result.ambiguous).toBe(true);
 });
 it('辅助手握住后失踪超过 200ms，恢复需释放再捏合',()=>{
  const engine=new GestureEngine();engine.process(frame(0,[hand(),hand('Left',false,.8)]));
  engine.process(frame(10,[hand(),hand('Left',true,.8)]));expect(engine.process(frame(111,[hand(),hand('Left',true,.8)])).helper?.pinching).toBe(true);
  engine.process(frame(150));const loss=engine.process(frame(351));expect(loss.helperInterrupted).toBe(true);expect(loss.interrupted).toBe(false);
  expect(engine.process(frame(400,[hand(),hand('Left',true,.8)])).helper?.pinching).toBe(false);
 });
 it('双手在锁定位置附近重叠时冻结，不接管',()=>{
  const engine=new GestureEngine();engine.process(frame(0));engine.process(frame(10,[hand('Right',true)]));engine.process(frame(111,[hand('Right',true)]));
  const result=engine.process(frame(150,[hand('Right',true,.51),hand('Left',true,.49)]));expect(result.ambiguous).toBe(true);expect(result.operator).toBeUndefined();
 });
 it('张掌保持 600ms 打开一次菜单，抓取时不会打开',()=>{
  const engine=new GestureEngine();engine.process(frame(0,[hand(),hand('Left',false,.8)]));
  expect(engine.process(frame(601,[hand(),hand('Left',false,.8)])).menuRequested).toBe(true);
  expect(engine.process(frame(900,[hand(),hand('Left',false,.8)])).menuRequested).toBe(false);
 });
 it('关键点按掌部尺度识别捏合，镜像指针方向',()=>{
  expect(features(hand('Right',true)).pinchRatio).toBeLessThan(.25);expect(features(hand()).openPalm).toBe(true);
  expect(features(hand('Right',true,.65)).pointer.x).toBeLessThan(features(hand('Right',true,.5)).pointer.x);
 });
});

describe('张掌打开、握拳关闭菜单',()=>{
 it('四指收拢才是握拳，张掌和普通捏合不是',()=>{
  expect(features(fist()).closedFist).toBe(true);expect(features(fist()).openPalm).toBe(false);
  expect(features(hand('Left')).closedFist).toBe(false);expect(features(hand('Left',true)).closedFist).toBe(false);
  const partial=fist();partial.landmarks[20]=hand('Left',false,.8).landmarks[20];expect(features(partial).closedFist).toBe(false);
 });
 it('左手握拳保持 200ms 仅请求关闭一次，重新张开后可再次关闭',()=>{
  const engine=new GestureEngine();engine.process(frame(0,[fist()]));
  expect(engine.process(frame(199,[fist()])).menuCloseRequested).toBe(false);
  expect(engine.process(frame(200,[fist()])).menuCloseRequested).toBe(true);
  expect(engine.process(frame(500,[fist()])).menuCloseRequested).toBe(false);
  engine.process(frame(600,[hand('Left',false,.8)]));engine.process(frame(700,[fist()]));
  expect(engine.process(frame(900,[fist()])).menuCloseRequested).toBe(true);
 });
 it('右手握拳和左手捏合不关闭，左手丢失会中断握拳确认',()=>{
  const engine=new GestureEngine();engine.process(frame(0,[fist('Right')]));expect(engine.process(frame(300,[fist('Right')])).menuCloseRequested).toBe(false);
  engine.process(frame(400,[hand('Left',true,.8)]));expect(engine.process(frame(700,[hand('Left',true,.8)])).menuCloseRequested).toBe(false);
  engine.process(frame(800,[fist()]));engine.process(frame(900,[]));engine.process(frame(950,[fist()]));
  expect(engine.process(frame(1100,[fist()])).menuCloseRequested).toBe(false);expect(engine.process(frame(1150,[fist()])).menuCloseRequested).toBe(true);
 });
});

describe('松手位置锁定',()=>{
 it('松开第一帧到确认帧锁定两手中点与掌尺度，短暂张开后可继续控制',()=>{
  const engine=new GestureEngine();const hands=(pinch:boolean)=>[hand('Right',pinch,.3),hand('Left',pinch,.8)];
  engine.process(frame(0,hands(false)));engine.process(frame(10,hands(true)));engine.process(frame(110,hands(true)));const stable=engine.process(frame(140,hands(true)));
  const opened=hands(true).map(h=>{h.landmarks[4].y-=.25;return h;});
  for(const t of [150,180,190]){
   const g=engine.process(frame(t,opened));
   for(const role of ['operator','helper']as const){expect(g[role]?.releasing).toBe(true);expect(g[role]?.pointer).toEqual(stable[role]?.pointer);expect(g[role]?.palmScale).toBe(stable[role]?.palmScale);expect(g[role]?.ended).toBe(t===190);}
  }
  const hover=engine.process(frame(230,opened));expect(hover.operator?.pinching).toBe(false);expect(hover.operator?.pointer.y).toBeLessThan(stable.operator!.pointer.y);
 });
 it('张开噪声不污染位置滤波，恢复捏合可继续移动',()=>{
  const engine=new GestureEngine(),reference=new GestureEngine();for(const e of [engine,reference]){e.process(frame(0));e.process(frame(10,[hand('Right',true)]));e.process(frame(110,[hand('Right',true)]));}
  const opened=hand('Right',true);opened.landmarks[4].y-=.25;expect(engine.process(frame(120,[opened])).operator?.releasing).toBe(true);
  const resumed=engine.process(frame(140,[hand('Right',true)]));expect(resumed.operator?.pinching).toBe(true);expect(resumed.operator?.releasing).toBe(false);expect(resumed.operator?.pointer).toEqual(reference.process(frame(140,[hand('Right',true)])).operator?.pointer);
  const moved=engine.process(frame(180,[hand('Right',true,.55)]));expect(moved.operator?.pointer.x).not.toBe(resumed.operator?.pointer.x);
 });
});
