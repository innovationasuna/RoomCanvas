import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
await mkdir(new URL('../.test-build/', import.meta.url), { recursive: true });
await build({ stdin: { contents: 'export * from "./src/layout-manipulation.ts"; export * from "./src/layout-gesture.ts"; export * from "./src/layout-observe.ts";',
  resolveDir: new URL('../', import.meta.url).pathname }, outfile: new URL('../.test-build/gesture.mjs', import.meta.url).pathname,
  bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' });
const { Manipulation, GestureInput, parseGestureMessage, GESTURE_PROTOCOL, CameraObservation, observationPose } = await import('../.test-build/gesture.mjs');
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
function transaction(validate = async op => op.candidate) {
  const events = [];
  const controller = new Manipulation({ preview: op => events.push(['preview',op.candidate.x]), validate,
    accept: item => events.push(['accept',item.x]), restore: item => events.push(['restore',item.x]),
    finish: context => events.push(['finish',context.source]), error: error => events.push(['error',error.message]) });
  return {controller,events};
}
test('mouse and gesture share a transaction; preview does not mutate the committed pose', async () => {
  for (const source of ['mouse','gesture']) {
    const {controller:c,events}=transaction(); const original={id:'i',x:1};
    assert.ok(c.begin(original,{source})); c.update(op=>{op.candidate.x=2;});
    assert.equal(original.x,1); assert.equal(c.phase,'preview');
    await c.commit(); assert.deepEqual(events,[['preview',2],['accept',2],['finish',source]]);
  }
});
test('validation locks updates and duplicate release; success finishes only once', async () => {
  const d=deferred(); let calls=0;const {controller:c,events}=transaction(()=>{calls++;return d.promise;});
  c.begin({x:1},{source:'gesture'});c.update(o=>{o.candidate.x=2;});const pending=c.commit();
  assert.equal(c.phase,'validating');assert.equal(c.begin({x:9},{}),false);c.update(o=>{o.candidate.x=99;});await c.commit();
  d.resolve({x:3});await pending;assert.equal(calls,1);assert.equal(c.phase,'idle');
  assert.deepEqual(events,[['preview',2],['accept',3],['finish','gesture']]);
});
test('collision rejection restores the original pose and reports the reason', async () => {
  const {controller:c,events}=transaction(async()=>{throw Error('碰撞');});
  c.begin({x:1},{source:'gesture'});c.update(o=>{o.candidate.x=2;});await c.commit();
  assert.deepEqual(events,[['preview',2],['restore',1],['error','碰撞'],['finish','gesture']]);
});
test('cancelled validation cannot apply stale success or error to a new operation', async () => {
  for (const fails of [false,true]) {
    const d=deferred();const {controller:c,events}=transaction(()=>d.promise);
    c.begin({x:1},{source:'gesture'});c.update(o=>{o.candidate.x=2;});const pending=c.commit();
    assert.ok(c.cancel());c.begin({x:10},{source:'mouse'});
    if(fails)d.reject(Error('old'));else d.resolve({x:99});await pending;
    assert.equal(c.phase,'preview');assert.equal(c.current.original.x,10);
    assert.deepEqual(events,[['preview',2],['restore',1],['finish','gesture']]);
  }
});
test('selection without motion does not contact the validation server', async () => {
  let calls=0;const {controller:c}=transaction(async()=>{calls++;});c.begin({x:1},{});await c.commit();assert.equal(calls,0);
});
function inputFixture(mode='move') {
  const events=[];let blocked=false;const input=new GestureInput({blocked:()=>blocked,mode:()=>mode,
    begin:(p,m)=>{events.push(['begin',p.u,m]);return true;},move:p=>events.push(['move',p.u]),rotate:d=>events.push(['rotate',d]),
    commit:async()=>{events.push(['commit']);},cancel:()=>events.push(['cancel']),pointer:()=>{}});
  const hand=(u,flags={})=>({operator:{u,v:.5,pinching:true,started:false,ended:false,releasing:false,...flags},interrupted:false,ambiguous:false});
  const open=()=>input.input(hand(.4,{pinching:false}),0);
  const begin=()=>input.input(hand(.4,{started:true}),100);
  return {input,events,hand,open,begin,block:value=>{blocked=value;}};
}
test('initial held pinch cannot grab; explicit release and new start are required',()=>{
  const f=inputFixture();f.begin();assert.deepEqual(f.events,[]);f.open();f.begin();assert.equal(f.events[0][0],'begin');
});
test('release first frame freezes; confirmed release commits once and requires regrab',()=>{
  const f=inputFixture();f.open();f.begin();f.input.input(f.hand(.6),120);
  f.input.input(f.hand(.9,{releasing:true}),130);f.input.input(f.hand(.9,{pinching:false,ended:true,releasing:true}),170);
  f.input.input(f.hand(.9,{pinching:false,ended:true}),180);f.input.input(f.hand(.8,{started:true}),190);
  assert.deepEqual(f.events,[['begin',.4,'move'],['move',.6],['commit']]);
});
test('rotation uses continuous radians without 15-degree snapping',()=>{
  const f=inputFixture('rotate');f.open();f.begin();f.input.input(f.hand(.423),120);
  assert.ok(Math.abs(f.events[1][1]-.023*Math.PI)<1e-12);
});
test('lost or ambiguous hand freezes, then cancels without committing',()=>{
  for(const ambiguous of [false,true]){
    const f=inputFixture();f.open();f.begin();f.input.input({interrupted:false,ambiguous},120);
    assert.equal(f.events.length,1);f.input.input({interrupted:false,ambiguous},321);
    assert.deepEqual(f.events,[['begin',.4,'move'],['cancel']]);
    f.begin();assert.equal(f.events.length,2);
  }
});
test('long missing interval on recovery cannot submit a release from before the gap',()=>{
  const f=inputFixture();f.open();f.begin();f.input.input({interrupted:false,ambiguous:false},120);
  f.input.input(f.hand(.6,{ended:true,pinching:false}),400);assert.equal(f.events.at(-1)[0],'cancel');
});
test('busy or mouse ownership blocks new gesture grabs and does not queue them',()=>{
  const f=inputFixture();f.open();f.block(true);f.begin();f.block(false);f.begin();assert.deepEqual(f.events,[]);
  f.open();f.begin();assert.equal(f.events.length,1);
});
test('unsupported observe mode cannot manipulate a model',()=>{
  const f=inputFixture('view');f.open();f.begin();assert.deepEqual(f.events,[]);
});
test('hand loss after confirmed release preserves pending validation; explicit cancel still cancels it',()=>{
  const f=inputFixture();f.open();f.begin();f.input.input(f.hand(.6),120);
  f.input.input(f.hand(.6,{ended:true,pinching:false,releasing:true}),160);
  f.input.input({interrupted:true,ambiguous:false},400);
  assert.deepEqual(f.events,[['begin',.4,'move'],['move',.6],['commit']]);
  f.input.reset();assert.equal(f.events.at(-1)[0],'cancel');
});
test('protocol rejects unsupported modes, bad coordinates, inconsistent flags and malformed envelopes',()=>{
  const base={protocol:GESTURE_PROTOCOL,session:'s',sequence:1};const f=inputFixture();
  const valid={...base,type:'frame',sampleTime:42,frame:f.hand(.4)};
  assert.deepEqual(parseGestureMessage(valid),valid);
  for(const change of [{protocol:'other'},{sequence:NaN},{type:'mode',mode:'height'},{sampleTime:Infinity},
    {frame:{...valid.frame,operator:{...valid.frame.operator,u:1.2}}},
    {frame:{...valid.frame,operator:{...valid.frame.operator,started:true,pinching:false}}}])assert.equal(parseGestureMessage({...valid,...change}),null);
});
const cameraBase=()=>({alpha:1,beta:.6,radius:10,target:[2,1,3],right:[1,0,0],up:[0,1,0],fov:Math.PI/2,aspect:2,lowerBeta:.1,upperBeta:1.4});
test('orbit changes camera angles only and respects pitch limits',()=>{
 const base=cameraBase(),next=observationPose(base,{u:.5,v:.5},{u:.6,v:.6},'orbit');
 assert.ok(Math.abs(next.alpha-(1+.2*Math.PI))<1e-12);assert.deepEqual(next.target,base.target);assert.equal(next.radius,10);
 assert.equal(observationPose(base,{u:.5,v:.5},{u:.5,v:1},'orbit').beta,.1);
 assert.equal(observationPose(base,{u:.5,v:.5},{u:.5,v:0},'orbit').beta,1.4);
});
test('pan follows the captured screen basis and scales with view distance',()=>{
 const base=cameraBase(),next=observationPose(base,{u:.5,v:.5},{u:.6,v:.6},'pan');
 assert.ok(Math.abs(next.target[0]+2)<1e-12);assert.ok(Math.abs(next.target[1]-3)<1e-12);
 assert.equal(next.alpha,base.alpha);assert.equal(next.beta,base.beta);assert.equal(next.radius,base.radius);assert.deepEqual(base.target,[2,1,3]);
});
test('camera release keeps the last pose; explicit cancel restores the original once',()=>{
 let pose=cameraBase();let ends=0;
 const c=new CameraObservation({read:()=>pose,apply:value=>{pose=value;},begin:()=>{},end:()=>{ends++;}});
 c.begin({u:.4,v:.4},'pan');c.update({u:.5,v:.5});const last=structuredClone(pose);c.finish();assert.deepEqual(pose,last);
 c.begin({u:.4,v:.4},'orbit');assert.equal(c.begin({u:.3,v:.3},'pan'),false);c.update({u:.5,v:.5});c.finish(true);c.finish(true);
 assert.deepEqual(pose,last);assert.equal(ends,2);
});
test('observation does not pick models or commit layouts, and release freezes at the first frame',()=>{
 const events=[];
 const input=new GestureInput({blocked:()=>false,mode:()=> 'view',begin:()=>{throw Error('model pick');},move:()=>{throw Error('model move');},rotate:()=>{throw Error('model rotate');},commit:async()=>{throw Error('server commit');},cancel:()=>{},pointer:()=>{},observe:{begin:(p,action)=>{events.push(['begin',action]);return true;},update:p=>events.push(['update',p.u]),finish:cancel=>events.push(['finish',cancel])}});
 const h=(u,flags={})=>({operator:{u,v:.5,observation:'pan',pinching:true,started:false,ended:false,releasing:false,...flags},interrupted:false,ambiguous:false});
 input.input(h(.4,{pinching:false}),0);input.input(h(.4,{started:true}),100);input.input(h(.6),120);
 input.input(h(.9,{releasing:true}),130);input.input(h(.9,{pinching:false,ended:true,releasing:true}),170);
 assert.deepEqual(events,[['begin','pan'],['update',.6],['finish',false]]);
});
test('lost observation keeps last view; explicit cancellation restores start view',()=>{
 for(const explicit of [false,true]){
  const events=[];const input=new GestureInput({blocked:()=>false,mode:()=> 'view',begin:()=>false,move:()=>{},rotate:()=>{},commit:async()=>{},cancel:()=>{},pointer:()=>{},observe:{begin:()=>true,update:()=>{},finish:c=>events.push(c)}});
  const h={u:.5,v:.5,observation:'orbit',pinching:false,started:false,ended:false,releasing:false};
  input.input({operator:h,interrupted:false,ambiguous:false},0);input.input({operator:{...h,pinching:true,started:true},interrupted:false,ambiguous:false},100);
  if(explicit)input.reset();else input.input({interrupted:true,ambiguous:false},400);
  assert.deepEqual(events,[explicit]);
 }
});
test('observation protocol rejects unknown actions and accepts the optional camera action',()=>{
 const message={protocol:GESTURE_PROTOCOL,session:'s',sequence:1,type:'frame',sampleTime:10,frame:{interrupted:false,ambiguous:false,operator:{u:.5,v:.5,pinching:false,started:false,ended:false,releasing:false,observation:'pan'}}};
 assert.ok(parseGestureMessage(message));message.frame.operator.observation='zoom';assert.equal(parseGestureMessage(message),null);
});
test('left display cursor survives right-hand absence and cannot manipulate a model',()=>{
 const events=[];const f=inputFixture();
 const input=new GestureInput({blocked:()=>false,mode:()=> 'move',begin:()=>{throw Error('left must not pick');},move:()=>{},rotate:()=>{},commit:async()=>{},cancel:()=>{},pointer:()=>{},helperPointer:p=>events.push(p)});
 input.input({helper:{u:.2,v:.3},interrupted:true,ambiguous:false},0);
 assert.deepEqual(events.at(-1),{u:.2,v:.3});
 input.input({helper:{u:.4,v:.5},interrupted:false,ambiguous:false},100);
 input.input({helper:{u:.4,v:.5},interrupted:false,ambiguous:false},310);
 assert.deepEqual(events.at(-1),{u:.4,v:.5});input.interrupt();assert.equal(events.at(-1),null);
});
test('left display coordinates are validated independently of right-hand input',()=>{
 const message={protocol:GESTURE_PROTOCOL,session:'s',sequence:1,type:'frame',sampleTime:10,frame:{interrupted:false,ambiguous:false,helper:{u:.2,v:.3}}};
 assert.ok(parseGestureMessage(message));message.frame.helper.u=-.1;assert.equal(parseGestureMessage(message),null);
});
