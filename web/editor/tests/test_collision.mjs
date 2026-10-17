import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCollision, sweepTriangle} from '../collision.mjs';

const pose = (x = 0, y = 0, z = 0, yaw = 0) => ({x, y, z, yaw});
function box(x0, y0, z0, x1, y1, z1) {
  const p = [[x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0],[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]];
  return [[0,1,2],[0,2,3],[4,6,5],[4,7,6],[0,4,5],[0,5,1],[3,2,6],[3,6,7],[0,3,7],[0,7,4],[1,5,6],[1,6,2]].map((face) => face.map((i) => p[i]));
}
const owner = (id, triangles, origin = [0,0,0]) => ({id, name: id, origin, meshes: [{name: id, triangles}]});
const near = (a, b, tolerance = .001) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);

test('stored furniture does not obstruct a move or a destination, but restoring it does', () => {
  const collision = buildCollision([owner('chair', box(-.2, 0, -.2, .2, .5, .2)), owner('cabinet', box(1, 0, -1, 1.2, 1, 1))]);
  const before = {chair: pose(), cabinet: {...pose(), visible: false}};
  const next = {...before, chair: pose(2)};
  assert.equal(collision.limit(before, next, ['chair']).blocked, false);
  assert.equal(collision.checkPlacement({...next, chair: pose(1.1)}, ['chair']).ok, true);
  const restored = {...before, cabinet: pose()};
  assert.equal(collision.limit(restored, {...restored, chair: pose(2)}, ['chair']).blocked, true);
  assert.equal(collision.checkPlacement({...restored, chair: pose(1.1)}, ['chair']).ok, false);
});

test('hidden moving furniture ignores collisions and truncated moves preserve visibility', () => {
  const collision = buildCollision([owner('chair', box(-.2, 0, -.2, .2, .5, .2)), owner('cabinet', box(1, 0, -1, 1.2, 1, 1))]);
  const before = {chair: {...pose(), visible: false}, cabinet: pose()};
  const next = {...before, chair: {...pose(2), visible: false}};
  assert.equal(collision.limit(before, next, ['chair']).blocked, false);
  assert.equal(collision.checkPlacement({...next, chair: {...pose(1.1), visible: false}}, ['chair']).ok, true);
  const visible = {chair: {...pose(), visible: true}, cabinet: pose()};
  const limited = collision.limit(visible, {...visible, chair: {...pose(2), visible: true}}, ['chair']);
  assert.equal(limited.blocked, true);
  assert.equal(limited.layout.chair.visible, true);
});

test('continuous triangle sweep detects a thin plane crossed by a long step', () => {
  const moving = [[-1,.2,.2],[-1,.8,.2],[-1,.2,.8]], wall = [[0,0,0],[0,2,0],[0,0,2]];
  near(sweepTriangle(moving, wall, [10,0,0]), .1, 1e-8);
  assert.equal(sweepTriangle(moving, wall, [-10,0,0]), null);
});

test('coplanar disjoint triangles are separated in their own plane', () => {
  const a = [[0,0,0],[1,0,0],[0,0,1]], b = [[2,0,0],[3,0,0],[2,0,1]];
  assert.equal(sweepTriangle(a,b,[0,0,1]), null);
  near(sweepTriangle(a,b,[2,0,0],null,0,false), .5, 1e-8);
});

test('floor contact permits sliding and lifting, but prevents downward penetration', () => {
  const c = buildCollision([owner('chair',box(-.1,0,-.1,.1,.4,.1)),owner('floor',box(-10,-.1,-10,10,0,10))]);
  const before={chair:pose()};
  for (const target of [pose(1),pose(0,.3),pose()]) assert.equal(c.limit(before,{chair:target},['chair']).blocked,false);
  const down=c.limit(before,{chair:pose(0,-.1)},['chair']);
  assert.equal(down.blocked,true); assert.equal(down.fraction,0);
});

test('a chair stops at the first mesh contact, can retreat, and cannot jump through', () => {
  const c=buildCollision([owner('chair',box(-.2,0,-.2,.2,.5,.2)),owner('cabinet',box(1,0,-1,1.2,1,1))]);
  const first=c.limit({chair:pose()},{chair:pose(4)},['chair']);
  assert.equal(first.blocked,true); assert.equal(first.other.id,'cabinet'); near(first.layout.chair.x,.8);
  const again=c.limit(first.layout,{chair:pose(2)},['chair']); near(again.layout.chair.x,first.layout.chair.x);
  const retreat=c.limit(first.layout,{chair:pose(.2)},['chair']); assert.equal(retreat.blocked,false);
});

test('table hollow space stays free despite overlapping enclosing bounds', () => {
  const table=[...box(-1,1,-1,1,1.1,1),...box(-1,0,-1,-.9,1,1),...box(.9,0,-1,1,1,1)];
  const c=buildCollision([owner('chair',box(-.2,0,-.2,.2,.6,.2)),owner('table',table)]);
  const pass=c.limit({chair:pose(0,0,-2)},{chair:pose(0,0,2)},['chair']); assert.equal(pass.blocked,false);
  const side=c.limit({chair:pose()},{chair:pose(2)},['chair']); assert.equal(side.blocked,true); near(side.layout.chair.x,.7);
});

test('a lifted table descends around a smaller chair without a whole-object box collision', () => {
  const table=[...box(-1,1,-1,1,1.1,1),...box(-1,0,-1,-.9,1,1),...box(.9,0,-1,1,1,1)];
  const c=buildCollision([owner('table',table),owner('chair',box(-.2,0,-.2,.2,.6,.2))]);
  assert.equal(c.limit({table:pose(0,.5)},{table:pose()},['table']).blocked,false);
});

test('authored penetration allows escape but not deepening, without ignoring later triangles', () => {
  const c=buildCollision([owner('chair',box(-.1,0,-.1,.1,.5,.1)),owner('wall',box(.09,-1,-1,.3,1,1))]);
  assert.equal(c.limit({chair:pose()},{chair:pose(-.2)},['chair']).blocked,false);
  assert.equal(c.limit({chair:pose()},{chair:pose(.05)},['chair']).fraction,0);
  assert.equal(c.limit({chair:pose()},{chair:pose(2)},['chair']).fraction,0,'long step does not skip initial penetration');
});

test('all members of an assembly stop together when a carried object contacts a wall', () => {
  const c=buildCollision([owner('table',box(-.2,0,-.2,.2,.5,.2)),owner('payload',box(-.3,.5,-.3,.3,1,.3)),owner('wall',box(.8,.8,-1,1,2,1))]);
  const before={table:pose(),payload:pose()}, next={table:pose(2),payload:pose(2)};
  const hit=c.limit(before,next,['table','payload']); assert.equal(hit.blocked,true); near(hit.layout.table.x,.5); near(hit.layout.payload.x,hit.layout.table.x,1e-10);
});

test('yaw sweep stops a thin rotating arm before an obstacle crossed between endpoints', () => {
  const c=buildCollision([owner('arm',box(0,.5,-.03,2,.6,.03)),owner('post',box(1.35,0,-1.4,1.45,1,-1.3))]);
  const hit=c.limit({arm:pose()},{arm:pose(0,0,0,Math.PI/2)},['arm']);
  assert.equal(hit.blocked,true); assert.ok(hit.layout.arm.yaw>.5&&hit.layout.arm.yaw<.85);
});

test('yaw around a support keeps coplanar floor contacts movable', () => {
  const c=buildCollision([owner('chair',box(-.2,0,-.2,.2,.5,.2)),owner('floor',box(-10,-.1,-10,10,0,10))]);
  assert.equal(c.limit({chair:pose()},{chair:pose(0,0,0,Math.PI/4)},['chair']).blocked,false);
});

test('partial rotation preserves a carried payloads orbit and relative orientation', () => {
  const c=buildCollision([owner('table',box(-.2,0,-.2,.2,.5,.2)),owner('payload',box(-.08,.5,-.08,.08,.8,.08),[1.8,0,0]),owner('post',box(1.2,.6,-1.4,1.4,1,-1.1))]);
  const before={table:pose(),payload:pose()}, next={table:pose(0,0,0,Math.PI/2),payload:pose(-1.8,0,-1.8,Math.PI/2)};
  const hit=c.limit(before,next,['table','payload']);
  assert.equal(hit.blocked,true); assert.ok(hit.fraction>0&&hit.fraction<1);
  near(Math.hypot(1.8+hit.layout.payload.x,hit.layout.payload.z),1.8,1e-10);
  near(hit.layout.payload.yaw,hit.layout.table.yaw,1e-10);
});

test('yaw wrap uses the short arc across pi', () => {
  const c=buildCollision([owner('arm',box(0,.5,-.03,2,.6,.03)),owner('post',box(1.3,0,-1.4,1.4,1,-1.3))]);
  const hit=c.limit({arm:pose(0,0,0,Math.PI-.05)},{arm:pose(0,0,0,-Math.PI+.05)},['arm']);
  assert.equal(hit.blocked,false);
});

test('destination placement checks the target without sweeping through the room', () => {
  const c = buildCollision([owner('board', box(-.2, .5, -.05, .2, 1, .05)), owner('obstacle', box(1, 0, -1, 1.2, 2, 1))]);
  assert.equal(c.limit({board: pose()}, {board: pose(3)}, ['board']).blocked, true);
  assert.deepEqual(c.checkPlacement({board: pose(3)}, ['board']), {ok: true, blocked: false, other: null, reason: null});
});

test('destination rejects actual crossing of an open wall mesh', () => {
  const wall = [[[-2, 0, 0], [2, 0, 0], [2, 2, 0]], [[-2, 0, 0], [2, 2, 0], [-2, 2, 0]]];
  const c = buildCollision([owner('board', box(-.2, .5, -.1, .2, 1, .1)), owner('wall', wall)]);
  const result = c.checkPlacement({board: pose()}, ['board']);
  assert.equal(result.ok, false); assert.equal(result.other.id, 'wall'); assert.equal(result.reason, 'crossing');
  assert.equal(c.checkPlacement({board: pose(0, 0, .103)}, ['board']).ok, true);
});

test('destination permits coplanar support and side contacts between closed meshes', () => {
  const c = buildCollision([owner('object', box(0, 0, 0, 1, 1, 1)), owner('fixed', box(1, 0, 0, 2, 1, 1)), owner('support', box(-2, -.2, -2, 3, 0, 3))]);
  assert.equal(c.checkPlacement({object: pose()}, ['object']).ok, true);
});

test('destination preserves empty space in an overlapping table bounding box', () => {
  const table = [...box(-1, 1, -1, 1, 1.1, 1), ...box(-1, 0, -1, -.9, 1, 1), ...box(.9, 0, -1, 1, 1, 1)];
  const c = buildCollision([owner('chair', box(-.2, 0, -.2, .2, .6, .2)), owner('table', table)]);
  assert.equal(c.checkPlacement({chair: pose()}, ['chair']).ok, true);
  const hit = c.checkPlacement({chair: pose(.85)}, ['chair']);
  assert.equal(hit.ok, false); assert.equal(hit.other.id, 'table');
});

test('destination detects a fully enclosed mesh without a surface crossing', () => {
  const c = buildCollision([owner('small', box(-.1, -.1, -.1, .1, .1, .1)), owner('large', box(-1, -1, -1, 1, 1, 1))]);
  const small = c.checkPlacement({small: pose()}, ['small']);
  assert.equal(small.ok, false); assert.equal(small.reason, 'containment');
  const large = c.checkPlacement({large: pose()}, ['large']);
  assert.equal(large.ok, false); assert.equal(large.other.id, 'small');
});

test('destination rejects coincident and aligned overlapping solids', () => {
  const c = buildCollision([owner('moving', box(0, 0, 0, 1, 1, 1)), owner('fixed', box(0, 0, 0, 1, 1, 1))]);
  for (const target of [pose(), pose(.4), pose(0, .4), pose(0, 0, .4)]) {
    const result = c.checkPlacement({moving: target}, ['moving']);
    assert.equal(result.ok, false); assert.equal(result.other.id, 'fixed');
  }
});

test('destination validates every carried member but permits internal assembly contact', () => {
  const c = buildCollision([owner('shelf', box(-.5, .5, -.2, .5, .6, .2)), owner('payload', box(-.1, .6, -.1, .1, .9, .1)), owner('cabinet', box(1.9, .7, -.2, 2.1, 1, .2))]);
  assert.equal(c.checkPlacement({shelf: pose(), payload: pose()}, ['shelf', 'payload']).ok, true);
  const result = c.checkPlacement({shelf: pose(2), payload: pose(2)}, ['shelf', 'payload']);
  assert.equal(result.ok, false); assert.equal(result.other.id, 'cabinet'); assert.equal(result.other.movingId, 'payload');
});

test('destination uses the yaw and authored origins of both moving and stationary objects', () => {
  const c = buildCollision([owner('board', box(0, 0, -.05, 1, .5, .05), [1, 0, 0]), owner('other', box(-.1, 0, -.1, .1, .5, .1), [4, 0, 0])]);
  const layout = {board: pose(0, 0, 0, Math.PI / 2), other: pose(-3, 0, -.5)};
  assert.equal(c.checkPlacement(layout, ['board']).ok, false);
  layout.other.z = .5;
  assert.equal(c.checkPlacement(layout, ['board']).ok, true);
});

test('a target wall is never broadly ignored at an adjacent wall corner', () => {
  const back = [[[0, 0, -2], [0, 2, -2], [0, 2, 2]], [[0, 0, -2], [0, 2, 2], [0, 0, 2]]];
  const side = [[[-2, 0, 0], [2, 0, 0], [2, 2, 0]], [[-2, 0, 0], [2, 2, 0], [-2, 2, 0]]];
  const c = buildCollision([owner('board', box(.003, .5, -.3, .1, 1, .3)), owner('target-wall', back), owner('adjacent-wall', side)]);
  const result = c.checkPlacement({board: pose()}, ['board']);
  assert.equal(result.ok, false); assert.equal(result.other.id, 'adjacent-wall');
  assert.equal(c.checkPlacement({board: pose(0, 0, .5)}, ['board']).ok, true);
});

test('an open mesh cannot create a phantom enclosed volume', () => {
  const openBox = box(-1, -1, -1, 1, 1, 1).slice(0, 8);
  const c = buildCollision([owner('small', box(-.1, -.1, -.1, .1, .1, .1)), owner('open', openBox)]);
  assert.equal(c.checkPlacement({small: pose()}, ['small']).ok, true);
});

test('destination validation rejects invalid object poses explicitly', () => {
  const c = buildCollision([owner('board', box(0, 0, 0, 1, 1, 1))]);
  for (const [layout, ids] of [[{}, ['board']], [{board: pose(NaN)}, ['board']], [{board: pose()}, ['unknown']]]) {
    assert.equal(c.checkPlacement(layout, ids).reason, 'invalid-pose');
  }
});

test('the same placement question is answered once, a changed pose is checked again', () => {
  const c = buildCollision([owner('moving', box(0, 0, 0, 1, 1, 1)), owner('fixed', box(2, 0, 0, 3, 1, 1))]);
  const clear = c.checkPlacement({moving: pose()}, ['moving']);
  assert.equal(c.checkPlacement({moving: pose()}, ['moving']), clear);
  const blocked = c.checkPlacement({moving: pose(2)}, ['moving']);
  assert.equal(blocked.ok, false); assert.equal(blocked.other.id, 'fixed');
  assert.equal(c.checkPlacement({moving: pose()}, ['moving']).ok, true);
});
