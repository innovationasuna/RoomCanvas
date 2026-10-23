import test from 'node:test';
import assert from 'node:assert/strict';
import {parseMessage, GestureInput, observationPose, sceneURLSession, connectGestureBridge, PROTOCOL, ROTATION_PER_SWEEP} from '../gesture-bridge.mjs';
import {PlacementSession} from '../placement-session.mjs';
import {initialLayout, History} from '../layout.mjs';
import {predictDrop} from '../drop-placement.mjs';

const hand = (u, v, state = {}) => ({u, v, pinching: false, started: false, ended: false, releasing: false, ...state});
const frame = (operator, extra = {}) => ({operator, interrupted: false, ambiguous: false, ...extra});
function recorder(mode = 'move', {blocked = false, accept = true} = {}) {
  const calls = [];
  const port = {
    blocked: () => blocked, mode: () => mode,
    begin: (p, kind) => {calls.push(['begin', kind, p.u]); return accept;},
    move: (p) => calls.push(['move', p.u]), rotate: (a) => calls.push(['rotate', a]),
    release: () => calls.push(['release']), cancel: () => calls.push(['cancel']), pointer: () => {},
    observe: {begin: (p, a) => {calls.push(['observe', a]); return true;}, update: (p) => calls.push(['view', p.u]), finish: (c) => calls.push(['finish', c])},
  };
  return {port, calls, set mode(value) {mode = value;}};
}

test('a pinch grabs only after an open hand, drags, and pauses the preview on release', () => {
  const r = recorder('move'), input = new GestureInput(r.port);
  input.input(frame(hand(.5, .5, {pinching: true, started: true})), 0);
  assert.deepEqual(r.calls, [], 'a hand that arrives pinched must open first');
  input.input(frame(hand(.5, .5)), 10);
  input.input(frame(hand(.5, .5, {pinching: true, started: true})), 20);
  input.input(frame(hand(.6, .5, {pinching: true})), 30);
  input.input(frame(hand(.6, .5, {ended: true})), 40);
  assert.deepEqual(r.calls, [['begin', 'move', .5], ['move', .6], ['release']]);
  input.input(frame(hand(.6, .5, {pinching: true, started: true})), 50);
  assert.equal(r.calls.length, 3, 'after a release the hand opens again before the next grab');
});

test('rotation follows the sideways hand movement, 1080 degrees per sweep', () => {
  const r = recorder('rotate'), input = new GestureInput(r.port);
  input.input(frame(hand(.2, .5)), 0);
  input.input(frame(hand(.2, .5, {pinching: true, started: true})), 10);
  input.input(frame(hand(.45, .5, {pinching: true})), 20);
  assert.deepEqual(r.calls[0], ['begin', 'rotate', .2]);
  assert.equal(r.calls[1][0], 'rotate');
  assert.ok(Math.abs(r.calls[1][1] - .25 * ROTATION_PER_SWEEP) < 1e-12);
  assert.equal(ROTATION_PER_SWEEP, 6 * Math.PI);
});

test('losing the hand for 200 ms cancels a drag; a blocked scene or a missed grab waits for release', () => {
  const r = recorder('move'), input = new GestureInput(r.port);
  input.input(frame(hand(.5, .5)), 0);
  input.input(frame(hand(.5, .5, {pinching: true, started: true})), 10);
  input.input(frame(undefined), 20);
  input.input(frame(undefined), 120);
  assert.deepEqual(r.calls.at(-1), ['begin', 'move', .5]);
  input.input(frame(undefined), 230);
  assert.deepEqual(r.calls.at(-1), ['cancel']);
  const missed = recorder('move', {accept: false}), again = new GestureInput(missed.port);
  again.input(frame(hand(.5, .5)), 0);
  again.input(frame(hand(.5, .5, {pinching: true, started: true})), 10);
  again.input(frame(hand(.5, .5, {pinching: true})), 20);
  assert.deepEqual(missed.calls, [['begin', 'move', .5]]);
  const busy = recorder('move', {blocked: true}), waiting = new GestureInput(busy.port);
  waiting.input(frame(hand(.5, .5)), 0);
  waiting.input(frame(hand(.5, .5, {pinching: true, started: true})), 10);
  assert.deepEqual(busy.calls, []);
});

test('view mode orbits or pans the camera and an interrupted observation keeps its pose', () => {
  const r = recorder('view'), input = new GestureInput(r.port);
  input.input(frame(hand(.5, .5)), 0);
  input.input(frame(hand(.5, .5, {pinching: true, started: true, observation: 'orbit'})), 10);
  input.input(frame(hand(.7, .5, {pinching: true, observation: 'orbit'})), 20);
  input.input(frame(hand(.7, .5), {interrupted: true}), 30);
  assert.deepEqual(r.calls, [['observe', 'orbit'], ['view', .7], ['finish', false]]);
  input.input(frame(hand(.5, .5)), 40);
  input.input(frame(hand(.5, .5, {pinching: true, started: true, observation: 'pan'})), 50);
  input.reset();
  assert.deepEqual(r.calls.slice(3), [['observe', 'pan'], ['finish', true], ['cancel']]);
});

test('camera poses: a sweep orbits a full turn, tilt is clamped, pan moves by the visible size', () => {
  const base = {theta: 1, phi: .8, radius: 10, minPhi: .1, maxPhi: 1.5, target: [0, 0, 0], right: [1, 0, 0], up: [0, 1, 0], width: 8, height: 6};
  const orbit = observationPose(base, {u: .5, v: .5}, {u: .75, v: 1}, 'orbit');
  assert.ok(Math.abs(orbit.theta - (1 - Math.PI / 2)) < 1e-12);
  assert.equal(orbit.phi, .1);
  const pan = observationPose(base, {u: .5, v: .5}, {u: .75, v: .25}, 'pan');
  assert.deepEqual(pan.target, [-2, -1.5, 0]);
  assert.deepEqual(base.target, [0, 0, 0], 'the starting pose is not changed');
});

test('messages are checked field by field', () => {
  const ok = {protocol: PROTOCOL, session: 's', sequence: 1, type: 'frame', sampleTime: 5, frame: frame(hand(.5, .5, {pinching: true, started: true}))};
  assert.equal(parseMessage(ok), ok);
  assert.equal(parseMessage({...ok, frame: frame(hand(1.2, .5))}), null);
  assert.equal(parseMessage({...ok, frame: frame(hand(.5, .5, {started: true}))}), null, 'a start without a pinch');
  assert.equal(parseMessage({...ok, sequence: 0}), null);
  assert.equal(parseMessage({protocol: PROTOCOL, session: 's', sequence: 2, type: 'mode', mode: 'fly'}), null);
  assert.ok(parseMessage({protocol: PROTOCOL, session: 's', sequence: 2, type: 'mode', mode: 'rotate'}));
});

test('only a gesture page on this computer can connect', () => {
  assert.deepEqual(sceneURLSession('?gesture_origin=http://127.0.0.1:8800&gesture_session=a'), {origin: 'http://127.0.0.1:8800', session: 'a'});
  assert.equal(sceneURLSession('?gesture_origin=https://example.com&gesture_session=a'), null);
  assert.equal(sceneURLSession('?gesture_origin=http://127.0.0.1:8800/x&gesture_session=a'), null);
  assert.equal(sceneURLSession('?scene=../../samples/room3'), null);
});

test('the bridge answers hello with state, switches modes and ignores old or foreign messages', () => {
  const listeners = {}, posted = [];
  const parent = {postMessage: (data, origin) => posted.push([data, origin])};
  const win = {parent, location: {search: '?gesture_origin=http://127.0.0.1:8800&gesture_session=s1'},
    addEventListener: (type, fn) => {listeners[type] = fn;}, setInterval: () => 1, clearInterval() {}};
  const doc = {hidden: false, addEventListener() {}};
  let mode = 'view', resets = 0, stops = 0;
  const port = {input: {reset: () => resets++, interrupt() {}, input() {}}, setMode: (m) => {mode = m; return true;}, stop: () => stops++,
    state: () => ({busy: false, mode, selectedId: null, layoutReady: true, phase: 'idle', message: '', capabilities: ['observe-pinch-v1']})};
  assert.ok(connectGestureBridge(port, {win, doc, clock: {timeOrigin: 0, now: () => 0}}));
  const send = (data, origin = 'http://127.0.0.1:8800', source = parent) => listeners.message({data: {protocol: PROTOCOL, session: 's1', ...data}, origin, source});
  send({sequence: 1, type: 'mode', mode: 'move'});
  assert.equal(mode, 'view', 'nothing before hello');
  send({sequence: 2, type: 'hello'});
  assert.equal(posted.at(-1)[1], 'http://127.0.0.1:8800');
  assert.deepEqual({...posted.at(-1)[0], capabilities: undefined}, {protocol: PROTOCOL, session: 's1', type: 'state', sequence: 2, busy: false, mode: 'view', selectedId: null, layoutReady: true, phase: 'idle', message: '', capabilities: undefined});
  send({sequence: 3, type: 'mode', mode: 'move'});
  assert.equal(mode, 'move');
  send({sequence: 3, type: 'mode', mode: 'rotate'});
  send({sequence: 4, type: 'mode', mode: 'rotate'}, 'http://evil.test');
  assert.equal(mode, 'move');
  assert.equal(resets, 2);
  send({sequence: 5, type: 'stop'});
  assert.equal(stops, 1, 'the gesture page cancelling reaches the editor');
});

test('frames that arrive late because the editor was busy still apply; a busy tick does not drop the hand', () => {
  const listeners = {}, posted = [];
  let tick = null, now = 0;
  const parent = {postMessage: (data) => posted.push(data)};
  const win = {parent, location: {search: '?gesture_origin=http://127.0.0.1:8800&gesture_session=s'},
    addEventListener: (type, fn) => {listeners[type] = fn;}, setInterval: (fn) => {tick = fn; return 1;}, clearInterval() {}};
  const calls = [];
  const port = {input: {reset() {}, interrupt: () => calls.push('interrupt'), input: (f) => calls.push('input')}, setMode: () => true,
    state: () => ({busy: false, mode: 'move', selectedId: null, layoutReady: true, phase: 'idle', message: ''})};
  connectGestureBridge(port, {win, doc: {hidden: false, addEventListener() {}}, clock: {timeOrigin: 0, now: () => now}});
  const send = (data) => listeners.message({data: {protocol: PROTOCOL, session: 's', ...data}, origin: 'http://127.0.0.1:8800', source: parent});
  const frame = {interrupted: false, ambiguous: false, operator: hand(.5, .5, {pinching: true})};
  send({sequence: 1, type: 'hello'});
  now = 1000; send({sequence: 2, type: 'frame', sampleTime: 400, frame});
  assert.deepEqual(calls, ['input'], 'a frame 600 ms late is applied');
  now = 1700; tick();
  assert.deepEqual(calls, ['input'], 'the first tick after a 700 ms stall waits for queued frames');
  now = 1800; tick();
  assert.deepEqual(calls, ['input', 'interrupt'], 'no frame after that: the hand is gone');
  now = 5000; send({sequence: 3, type: 'frame', sampleTime: 2500, frame});
  assert.equal(calls.at(-1), 'interrupt', 'a frame 2.5 s old is not current');
});

test('left orbit and right furniture manipulation run independently; losing one hand never releases the other', () => {
  const r=recorder(), input=new GestureInput(r.port);
  input.input(frame(hand(.5,.5),{helper:hand(.2,.5)}),0);
  input.input(frame(hand(.5,.5,{pinching:true,started:true}),{helper:hand(.2,.5,{pinching:true,started:true})}),10);
  input.input(frame(hand(.6,.5,{pinching:true}),{helper:hand(.3,.5,{pinching:true})}),20);
  assert.ok(r.calls.some(c=>c[0]==='move')); assert.ok(r.calls.some(c=>c[0]==='view'));
  input.input(frame(undefined,{interrupted:true,helper:hand(.4,.5,{pinching:true})}),30);
  assert.equal(r.calls.filter(c=>c[0]==='cancel').length,1);
  assert.equal(r.calls.filter(c=>c[0]==='release').length,0);
  assert.deepEqual(r.calls.at(-1),['view',.4]);
  input.input(frame(hand(.8,.5,{pinching:true,started:true}),{helper:hand(.5,.5,{pinching:true})}),40);
  assert.equal(r.calls.filter(c=>c[0]==='begin').length,1,'right must release before regrabbing');
  input.input(frame(hand(.8,.5),{helper:hand(.5,.5,{ended:true})}),50);
  input.input(frame(hand(.8,.5,{pinching:true,started:true})),60);
  input.input(frame(hand(.9,.5,{pinching:true}),{helperInterrupted:true}),70);
  input.input(frame(hand(.9,.5,{ended:true})),80);
  assert.equal(r.calls.filter(c=>c[0]==='release').length,1);
});

test('height mode freezes on the first release frame and releases once after the recogniser confirms opening',()=>{
  const r=recorder('height'), input=new GestureInput(r.port);
  r.port.height=p=>r.calls.push(['height',p.v]);
  input.input(frame(hand(.5,.5)),0);
  input.input(frame(hand(.5,.5,{pinching:true,started:true})),10);
  input.input(frame(hand(.5,.4,{pinching:true})),20);
  input.input(frame(hand(.5,.1,{pinching:true,releasing:true})),30);
  input.input(frame(hand(.5,.1,{ended:true,releasing:true})),80);
  input.input(frame(hand(.5,.1,{ended:true,releasing:true})),90);
  assert.deepEqual(r.calls,[['begin','height',.5],['height',.4],['release']]);
});

function scalingPort() {
  const r=recorder('scale'); let camera={theta:0,zoom:1}, orbit=null, scale=null;
  r.port.observe={begin(p){orbit={u:p.u,theta:camera.theta};r.calls.push(['orbit-start']);return true;},
    update(p){camera.theta=orbit.theta-(p.u-orbit.u)*2*Math.PI;r.calls.push(['orbit']);},
    finish(){orbit=null;r.calls.push(['orbit-end']);}};
  r.port.scale={begin(a,b){scale={distance:Math.abs(a.u-b.u),zoom:camera.zoom};r.calls.push(['scale-start']);return true;},
    update(a,b){camera.zoom=scale.zoom*Math.abs(a.u-b.u)/scale.distance;r.calls.push(['scale']);},
    finish(lost){scale=null;r.calls.push(['scale-end',lost]);}};
  return {...r,camera};
}
test('lift, release, switch mode and drag retain airborne preview until explicit placement, with one undo',()=>{
  const before=initialLayout(['chair']), session=new PlacementSession(before,'chair'), history=new History();
  let layout=structuredClone(before), mode='height', start;
  const placement={settle(id,next){next[id].y=0;return {ok:true,surface:{label:'地面'}};},
    carry(){return {ok:true,moved:['chair']};}, assess(){return {state:'stable',height:0,label:'已放稳 · 地面'};}};
  let blocked=false;
  const collision={checkPlacement(){return {ok:true};},limit(){return {blocked,fraction:0,other:{name:'椅背'}};}};
  const release=()=>{session.pause();const drop=predictDrop('chair',layout,placement,collision);session.update(layout,drop.ok,drop.message);};
  const input=new GestureInput({blocked:()=>false,mode:()=>mode,pointer(){},
    begin(p){start={...p,pose:{...layout.chair}};return true;},
    height(p){layout.chair.y=start.pose.y+(start.v-p.v)*3;session.update(layout,false,'正在调整');},
    move(p){layout.chair.x=start.pose.x+(p.u-start.u)*3;session.update(layout,false,'正在调整');},
    release,cancel:()=>session.pause()});
  input.input(frame(hand(.5,.6)),0);
  input.input(frame(hand(.5,.6,{pinching:true,started:true})),10);
  input.input(frame(hand(.5,.2,{pinching:true})),20);
  const height=layout.chair.y;assert.ok(height>1);
  input.input(frame(hand(.5,.1,{ended:true})),60);
  assert.equal(layout.chair.y,height);assert.equal(session.candidate.chair.y,height);
  assert.deepEqual(session.committed(),before);assert.equal(history.past.length,0);
  input.reset();mode='move';
  input.input(frame(hand(.5,.2)),70);
  input.input(frame(hand(.5,.2,{pinching:true,started:true})),80);
  input.input(frame(hand(.7,.4,{pinching:true})),90);
  input.input(frame(hand(.7,.4,{ended:true})),130);
  assert.equal(layout.chair.y,height);assert.ok(layout.chair.x>.5);
  assert.equal(session.locked,true);assert.equal(session.placeWhenChecked,false);
  assert.equal(history.past.length,0);
  blocked=true;const failed=predictDrop('chair',layout,placement,collision);
  session.update(layout,failed.ok,failed.message);
  assert.equal(session.confirm(),null);assert.equal(layout.chair.y,height);
  blocked=false;const drop=predictDrop('chair',layout,placement,collision);
  session.update(drop.candidate,drop.ok,drop.message);
  const confirmed=session.confirm();history.commit(session.committed(),confirmed);
  assert.equal(confirmed.chair.y,0);assert.equal(confirmed.chair.x,layout.chair.x);
  assert.equal(history.past.length,1);assert.deepEqual(history.undo(confirmed),before);
});
test('two-hand scaling owns the camera and resumes a remaining left pinch from its new baseline',()=>{
  const r=scalingPort(), input=new GestureInput(r.port);
  input.input(frame(hand(.7,.5),{helper:hand(.3,.5)}),0);
  input.input(frame(hand(.7,.5),{helper:hand(.3,.5,{pinching:true,started:true})}),10);
  input.input(frame(hand(.7,.5),{helper:hand(.4,.5,{pinching:true})}),20);
  const theta=r.camera.theta;
  input.input(frame(hand(.7,.5,{pinching:true,started:true}),{helper:hand(.4,.5,{pinching:true})}),30);
  input.input(frame(hand(.8,.5,{pinching:true}),{helper:hand(.2,.5,{pinching:true})}),40);
  assert.equal(r.camera.theta,theta); assert.ok(Math.abs(r.camera.zoom-2)<1e-10);
  input.input(frame(hand(.9,.5,{pinching:true,releasing:true}),{helper:hand(.1,.5,{pinching:true})}),50);
  assert.ok(Math.abs(r.camera.zoom-2)<1e-10,'opening fingers do not change scale');
  input.input(frame(hand(.9,.5,{ended:true}),{helper:hand(.1,.5,{pinching:true})}),100);
  input.input(frame(hand(.9,.5),{helper:hand(.1,.5,{pinching:true})}),110);
  assert.equal(r.camera.theta,theta,'first resumed orbit must not jump');
  input.input(frame(hand(.9,.5),{helper:hand(.2,.5,{pinching:true})}),120);
  assert.ok(Math.abs(r.camera.theta-(theta-.2*Math.PI))<1e-10);
  assert.equal(r.calls.filter(c=>c[0]==='scale-end').length,1);
});

test('a short missing hand freezes scaling; sustained loss is interruption, not release',()=>{
  const r=scalingPort(), input=new GestureInput(r.port);
  input.input(frame(hand(.7,.5),{helper:hand(.3,.5)}),0);
  input.input(frame(hand(.7,.5,{pinching:true,started:true}),{helper:hand(.3,.5,{pinching:true,started:true})}),10);
  input.input(frame(hand(.8,.5,{pinching:true})),20);
  assert.equal(r.camera.zoom,1);
  input.input(frame(hand(.8,.5,{pinching:true}),{helperInterrupted:true}),230);
  assert.deepEqual(r.calls.at(-1),['scale-end',true]);
  input.input(frame(hand(.8,.5,{pinching:true}),{helper:hand(.2,.5,{pinching:true,started:true})}),240);
  assert.equal(r.camera.zoom,1);
  assert.equal(r.calls.filter(c=>c[0]==='orbit-start').length,0);
});

test('two-hand payload validates fingertip geometry and independent interruption flags',()=>{
  const msg={protocol:PROTOCOL,session:'s',sequence:1,type:'frame',sampleTime:1,
    frame:frame(hand(.5,.5),{helper:hand(.2,.4,{fingertips:{thumb:{u:.1,v:.3},index:{u:.3,v:.5}}}),helperInterrupted:false})};
  assert.ok(parseMessage(msg));
  for (const pinchRatio of [Infinity,-.1,'0.4']) assert.equal(parseMessage({...msg,frame:{...msg.frame,operator:{...msg.frame.operator,pinchRatio}}}),null);
  assert.equal(parseMessage({...msg,frame:{...msg.frame,helperInterrupted:'yes'}}),null);
  msg.frame.helper.fingertips.thumb.u=Infinity;assert.equal(parseMessage(msg),null);
  assert.ok(parseMessage({protocol:PROTOCOL,session:'s',sequence:1,type:'mode',mode:'height'}));
  assert.ok(parseMessage({protocol:PROTOCOL,session:'s',sequence:1,type:'mode',mode:'scale'}));
});

test('helper release does not end a right-hand drag, and a right release does not end orbit',()=>{
  const r=recorder(), input=new GestureInput(r.port);
  input.input(frame(hand(.6,.5),{helper:hand(.3,.5)}),0);
  input.input(frame(hand(.6,.5,{pinching:true,started:true}),{helper:hand(.3,.5,{pinching:true,started:true})}),10);
  input.input(frame(hand(.7,.5,{pinching:true}),{helper:hand(.4,.5,{ended:true})}),20);
  assert.deepEqual(r.calls.at(-1),['move',.7]);assert.equal(input.active,true);
  input.input(frame(hand(.7,.5,{pinching:true}),{helper:hand(.4,.5)}),30);
  input.input(frame(hand(.7,.5,{pinching:true}),{helper:hand(.4,.5,{pinching:true,started:true})}),40);
  input.input(frame(hand(.7,.5,{ended:true}),{helper:hand(.5,.5,{pinching:true})}),50);
  assert.equal(input.leftActive,true);assert.deepEqual(r.calls.at(-1),['release']);
});

test('left release during placement validation ends orbit and never leaves the mode switch blocked',()=>{
  const r=recorder(), input=new GestureInput(r.port);let busy=false;r.port.blocked=()=>busy;
  input.input(frame(hand(.6,.5),{helper:hand(.3,.5)}),0);
  input.input(frame(hand(.6,.5,{pinching:true,started:true}),{helper:hand(.3,.5,{pinching:true,started:true})}),10);
  input.input(frame(hand(.7,.5,{ended:true}),{helper:hand(.4,.5,{pinching:true})}),20);
  busy=true;
  input.input(frame(hand(.7,.5),{helper:hand(.5,.5,{pinching:true})}),30);
  assert.deepEqual(r.calls.at(-1),['view',.5],'left orbit continues while right placement validates');
  input.input(frame(hand(.7,.5),{helper:hand(.5,.5,{ended:true})}),40);
  assert.equal(input.leftActive,false);assert.deepEqual(r.calls.at(-1),['finish',false]);
  busy=false;input.input(frame(hand(.7,.5),{helper:hand(.5,.5)}),50);
  assert.equal(input.active,false);assert.equal(input.leftActive,false);
});
