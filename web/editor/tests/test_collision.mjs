import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCollision, sweepTriangle, packOwners, unpackOwners} from '../collision.mjs';

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

test('a scanned overlap may slide, lift and leave in any direction, but not go deeper', () => {
  // The chair is scanned 1 cm into the wall.
  const c = buildCollision([owner('chair', box(-.1, 0, -.1, .1, .5, .1)), owner('wall', box(.09, -1, -1, .3, 1, 1))], {keepAuthoredOverlaps: true});
  const original = {chair: pose()}, clear = {chair: pose(-.2)};
  assert.equal(c.checkPlacement(original, ['chair']).ok, true);
  assert.equal(c.limit(original, clear, ['chair']).blocked, false);
  // Oblique moves: out and along the wall, up and along it, along it sinking less than the tolerance.
  for (const target of [pose(-.05, 0, .1), pose(0, .3, -.4), pose(.003, .1, .2)]) {
    assert.equal(c.limit(original, {chair: target}, ['chair']).blocked, false, JSON.stringify(target));
    assert.equal(c.checkPlacement({chair: target}, ['chair']).ok, true, JSON.stringify(target));
  }
  const deeper = c.limit(original, {chair: pose(.05, 0, .05)}, ['chair']);
  assert.equal(deeper.blocked, true); assert.equal(deeper.other.id, 'wall');
  assert.ok(deeper.layout.chair.x < .0051, 'stops within the tolerance of its scanned depth');
  assert.equal(c.checkPlacement({chair: pose(.02)}, ['chair']).ok, false);
  assert.equal(c.checkPlacement({chair: pose(.2)}, ['chair']).ok, false);
  assert.ok(c.limit(original, {chair: pose(2)}, ['chair']).layout.chair.x < .0051, 'a long step cannot pass through');
  // Turning in place swings the chair's corners deeper into the wall.
  assert.equal(c.limit(original, {chair: pose(0, 0, 0, .2)}, ['chair']).blocked, true);
  // Pulled clear and pushed back, it goes in only as deep as it was scanned. Undo restores
  // poses only, so the same departure from the scanned pose gives the same answer again.
  assert.ok(c.limit(clear, {chair: pose(2)}, ['chair']).layout.chair.x < .0051);
  assert.equal(c.limit(original, clear, ['chair']).blocked, false);
});

test('a scanned overlap with a rotated wall is judged by depth, not by the direction of the move', () => {
  const turn = ([x, y, z]) => [Math.cos(.5) * x + Math.sin(.5) * z, y, -Math.sin(.5) * x + Math.cos(.5) * z];
  const turned = (triangles) => triangles.map((triangle) => triangle.map(turn));
  const c = buildCollision([owner('desk', turned(box(-.1, 0, -.1, .1, .5, .1))), owner('wall', turned(box(.09, -1, -1, .3, 1, 1)))], {keepAuthoredOverlaps: true});
  const [nx, , nz] = turn([1, 0, 0]), [tx, , tz] = turn([0, 0, 1]), at = (s, y, t) => pose(nx * s + tx * t, y, nz * s + tz * t);
  for (const target of [at(0, 0, .3), at(0, .2, 0), at(-.1, 0, .2), at(.002, 0, -.3)]) {
    assert.equal(c.limit({desk: pose()}, {desk: target}, ['desk']).blocked, false, JSON.stringify(target));
    assert.equal(c.checkPlacement({desk: target}, ['desk']).ok, true, JSON.stringify(target));
  }
  const deeper = c.limit({desk: pose()}, {desk: at(.05, 0, .1)}, ['desk']);
  assert.equal(deeper.blocked, true);
  assert.ok(deeper.layout.desk.x * nx + deeper.layout.desk.z * nz < .0051);
  assert.equal(c.checkPlacement({desk: at(.03, 0, 0)}, ['desk']).ok, false);
});

test('against a slightly slanted wall, a scanned overlap slides along it but not deeper, whichever moves', () => {
  const degrees = Math.PI / 180, apply = (m, p) => m.map((row) => row[0] * p[0] + row[1] * p[1] + row[2] * p[2]);
  const rotation = (yaw, tilt = 0, roll = 0) => {
    const [cy, sy, ct, st, cr, sr] = [Math.cos(yaw), Math.sin(yaw), Math.cos(tilt), Math.sin(tilt), Math.cos(roll), Math.sin(roll)];
    const y = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]], z = [[ct, -st, 0], [st, ct, 0], [0, 0, 1]], x = [[1, 0, 0], [0, cr, -sr], [0, sr, cr]];
    const times = (a, b) => a.map((row) => [0, 1, 2].map((j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));
    return times(y, times(z, x));
  };
  for (const [yaw, tilt, roll] of [[.5, 0, 0], [3, 0, 0], [10, 0, 0], [30, 0, 0], [3, 2, 4]]) for (const square of [false, true]) {
    const r = rotation(yaw * degrees, tilt * degrees, roll * degrees), turn = (p) => apply(r, p);
    const n = turn([1, 0, 0]), t = turn([0, 0, 1]), at = (into, along) => n.map((v, k) => v * into + t[k] * along);
    // The wall's face is the plane n·x = 0, the wall behind it. The item is scanned 5 mm into it,
    // either turned with the wall or square to the room axes, its deepest corner 5 mm in.
    const wall = box(0, -1, -2, .2, 1, 2).map((tri) => tri.map(turn));
    let item = box(-.2, 0, -.1, .005, .5, .1).map((tri) => tri.map(turn));
    if (square) {
      const center = turn([-.0975, .25, 0]), corners = [-1, 1].flatMap((a) => [-1, 1].flatMap((b) => [-1, 1].map((c) => [center[0] + a * .1, center[1] + b * .25, center[2] + c * .1])));
      const shift = .005 - Math.max(...corners.map((p) => p[0] * n[0] + p[1] * n[1] + p[2] * n[2]));
      item = box(...[-1, 1].flatMap((sign) => center.map((v, k) => v + sign * [.1, .25, .1][k] + shift * n[k])));
    }
    const c = buildCollision([owner('item', item), owner('wall', wall)], {keepAuthoredOverlaps: true});
    const scanned = {item: pose(), wall: pose()}, label = JSON.stringify({yaw, tilt, roll, square});
    for (const [moved, sign] of [['item', 1], ['wall', -1]]) {
      const move = (into, along) => {const [x, y, z] = at(into, along).map((v) => v * sign); return {...scanned, [moved]: pose(x, y, z)};};
      const depthAfter = (layout) => .005 + sign * (layout[moved].x * n[0] + layout[moved].y * n[1] + layout[moved].z * n[2]);
      // Along and into at once: stops within the tolerance of the scanned depth, cannot be confirmed.
      for (const along of [.4, -.4]) {
        const deeper = c.limit(scanned, move(.02, along), [moved]);
        assert.equal(deeper.blocked, true, `${label} ${moved} along ${along}`);
        assert.ok(depthAfter(deeper.layout) < .0101, `${label} ${moved} along ${along} pushed to ${depthAfter(deeper.layout)}`);
        assert.equal(c.checkPlacement(move(.02, along), [moved]).ok, false, `${label} ${moved} along ${along}`);
      }
      // Purely along the wall, a long way either way: allowed and confirmable.
      for (const along of [1.2, -1.2]) {
        assert.equal(c.limit(scanned, move(0, along), [moved]).blocked, false, `${label} ${moved} along ${along}`);
        assert.equal(c.checkPlacement(move(0, along), [moved]).ok, true, `${label} ${moved} along ${along}`);
      }
    }
  }
});

test('a long push into a scanned neighbour stops at the tolerance, not before it, whichever moves', () => {
  for (const angle of [0, .05]) {
    // Scanned 5 mm in, pushed 5 cm further along the wall's normal: it may go 5 mm deeper, as close as the clearance lets it.
    const turn = ([x, y, z]) => [Math.cos(angle) * x + Math.sin(angle) * z, y, -Math.sin(angle) * x + Math.cos(angle) * z];
    const turned = (triangles) => triangles.map((triangle) => triangle.map(turn)), [nx, , nz] = turn([1, 0, 0]);
    const c = buildCollision([owner('item', turned(box(-.2, 0, -.1, .005, .5, .1))), owner('wall', turned(box(0, -1, -2, .2, 1, 2)))], {keepAuthoredOverlaps: true});
    const scanned = {item: pose(), wall: pose()};
    const item = c.limit(scanned, {...scanned, item: pose(nx * .05, 0, nz * .05)}, ['item']), back = c.limit(scanned, {...scanned, wall: pose(-nx * .05, 0, -nz * .05)}, ['wall']);
    near(item.layout.item.x * nx + item.layout.item.z * nz, .005 - .0002, 1e-4);
    near(back.fraction, item.fraction, 1e-9);
  }
});

test('turning a large scanned pair projects only the planes near its depth, not all of them', () => {
  const ball = (r) => {
    const lat = 41, lon = 40, rows = Array.from({length: lat}, (_, i) => Array.from({length: lon}, (_, j) => {const t = Math.PI * i / (lat - 1), q = 2 * Math.PI * j / lon; return [r * Math.sin(t) * Math.cos(q), r * Math.cos(t), r * Math.sin(t) * Math.sin(q)];}));
    const triangles = [];
    for (let i = 0; i < lat - 1; i++) for (let j = 0; j < lon; j++) {
      const [a, b, c, d] = [rows[i][j], rows[i][(j + 1) % lon], rows[i + 1][j], rows[i + 1][(j + 1) % lon]];
      if (i > 0) triangles.push([a, c, b]);
      if (i < lat - 2) triangles.push([b, c, d]);
    }
    return triangles;
  };
  // Two 3k-triangle spheres 1 cm into each other, one turned 0.01 rad a step about an off-centre origin.
  const c = buildCollision([owner('a', ball(.3).map((t) => t.map(([x, y, z]) => [x + .05, y + .4, z]))), owner('b', ball(.3).map((t) => t.map(([x, y, z]) => [x + .64, y + .4, z])))], {keepAuthoredOverlaps: true});
  c.prepare('a');
  const scanning = c.audit.projections;
  let before = {a: pose(), b: pose()};
  for (let step = 0; step < 10; step++) before = c.limit(before, {...before, a: {...before.a, yaw: before.a.yaw + .01}}, ['a']).layout;
  assert.ok(Math.abs(before.a.yaw - .1) < 1e-9, 'turns freely');
  // About twenty new turns. Each sphere has about 1,600 outer planes: projecting all of them at
  // every turn would be some 60,000 projections, counted here rather than timed.
  assert.ok(c.audit.projections - scanning < 400, `${c.audit.projections - scanning} projections for ten steps`);
});

test('coincident solids stay where scanned; an interlock cannot be pushed into one side', () => {
  const c = buildCollision([owner('a', box(0, 0, 0, 1, 1, 1)), owner('b', box(0, 0, 0, 1, 1, 1))], {keepAuthoredOverlaps: true});
  assert.equal(c.checkPlacement({a: pose()}, ['a']).ok, true);
  assert.equal(c.limit({a: pose()}, {a: pose(.1)}, ['a']).blocked, false);
  assert.equal(c.checkPlacement({a: pose(2)}, ['a']).ok, true);
  // One mesh in two parts, each 1 cm into the piece between them.
  const concave = [...box(-.3, 0, -.3, -.09, 1, .3), ...box(.09, 0, -.3, .3, 1, .3)];
  const interlock = buildCollision([owner('a', box(-.1, 0, -.1, .1, .5, .1)), owner('b', concave)], {keepAuthoredOverlaps: true});
  assert.equal(interlock.checkPlacement({a: pose()}, ['a']).ok, true);
  assert.equal(interlock.limit({a: pose()}, {a: pose(0, .2, .2)}, ['a']).blocked, false);
  assert.equal(interlock.limit({a: pose()}, {a: pose(-.2)}, ['a']).blocked, true);
  assert.equal(interlock.checkPlacement({a: pose(-.2)}, ['a']).ok, false);
});

test('a detailed scanned mesh slides along its wall and leaves it, but not deeper', () => {
  const lat = 21, lon = 40, rows = Array.from({length: lat}, (_, i) => Array.from({length: lon}, (_, j) => {
    const t = Math.PI * i / (lat - 1), q = 2 * Math.PI * j / lon;
    return [.29 + .3 * Math.sin(t) * Math.cos(q), .4 + .3 * Math.cos(t), .3 * Math.sin(t) * Math.sin(q)];
  }));
  const ball = [];
  for (let i = 0; i < lat - 1; i++) for (let j = 0; j < lon; j++) {
    const [a, b, c, d] = [rows[i][j], rows[i][(j + 1) % lon], rows[i + 1][j], rows[i + 1][(j + 1) % lon]];
    if (i > 0) ball.push([a, c, b]);
    if (i < lat - 2) ball.push([b, c, d]);
  }
  // Scanned 1 cm into the wall.
  const c = buildCollision([owner('ball', ball), owner('wall', box(-.3, -1, -1, 0, 2, 1))], {keepAuthoredOverlaps: true});
  assert.equal(c.checkPlacement({ball: pose()}, ['ball']).ok, true);
  for (const target of [pose(0, .2, .3), pose(.002, 0, -.3), pose(.1)]) assert.equal(c.limit({ball: pose()}, {ball: target}, ['ball']).blocked, false, JSON.stringify(target));
  assert.ok(c.limit({ball: pose()}, {ball: pose(-.05)}, ['ball']).layout.ball.x > -.0051);
  assert.equal(c.checkPlacement({ball: pose(-.03)}, ['ball']).ok, false);
});

test('a scanned pair gets the same verdict whichever of the two is moved', () => {
  const concave = [...box(-.3, 0, -.3, -.09, 1, .3), ...box(.09, 0, -.3, .3, 1, .3)];
  const c = buildCollision([owner('a', box(-.1, 0, -.1, .1, .5, .1)), owner('frame', concave)], {keepAuthoredOverlaps: true});
  const scanned = {a: pose(), frame: pose()};
  c.prepare('frame'); // what selecting it does ahead of a drag; the answers stay the same
  // The same relative step, once by the middle piece and once by the frame.
  const middle = c.limit(scanned, {...scanned, a: pose(-.16)}, ['a']), frame = c.limit(scanned, {...scanned, frame: pose(.16)}, ['frame']);
  assert.equal(middle.blocked, true); assert.equal(frame.blocked, true);
  near(middle.layout.a.x, -frame.layout.frame.x, 1e-6);
  assert.ok(frame.layout.frame.x < .0051);
  assert.equal(c.checkPlacement({...scanned, a: pose(-.16)}, ['a']).ok, false);
  assert.equal(c.checkPlacement({...scanned, frame: pose(.16)}, ['frame']).ok, false);
  for (const [moved, step] of [['a', pose(0, .2, .2)], ['frame', pose(0, -.2, -.2)]]) {
    assert.equal(c.limit(scanned, {...scanned, [moved]: step}, [moved]).blocked, false, moved);
    assert.equal(c.checkPlacement({...scanned, [moved]: step}, [moved]).ok, true, moved);
  }
});

test('the scan allowance stays with the parts that touched: a thin partition of the same mesh still blocks', () => {
  // A 1 mm sheet scanned 5 mm into a rail; a 2 mm partition, a separate part of the rail's mesh, stands further along.
  const sheet = box(-.2, .015, -.0005, .2, .5, .0005), rail = [...box(-1, 0, -.02, 1, .02, .02), ...box(.5, 0, -.3, .502, .6, .3)];
  const c = buildCollision([owner('sheet', sheet), owner('rail', rail)], {keepAuthoredOverlaps: true});
  const scanned = {sheet: pose(), rail: pose()};
  assert.equal(c.checkPlacement(scanned, ['sheet']).ok, true);
  assert.equal(c.limit(scanned, {...scanned, sheet: pose(.2)}, ['sheet']).blocked, false, 'slides along the rail');
  const through = c.limit(scanned, {...scanned, sheet: pose(.8)}, ['sheet']);
  assert.equal(through.blocked, true);
  near(through.layout.sheet.x, .3, .001);
  assert.equal(c.checkPlacement({...scanned, sheet: pose(.4)}, ['sheet']).ok, false);
  const back = c.limit(scanned, {...scanned, rail: pose(-.8)}, ['rail']);
  near(back.layout.rail.x, -.3, .001);
});

test('a carried pair scanned through an open sheet may leave it, and still meets every other mesh', () => {
  const wall = [[[.09, -1, -1], [.09, 1, -1], [.09, 1, 1]], [[.09, -1, -1], [.09, 1, 1], [.09, -1, 1]]];
  const c = buildCollision([owner('table', box(-.1, 0, -.1, .1, .5, .1)), owner('payload', box(-.1, .5, -.1, .1, .8, .1)), owner('wall', wall), owner('other', box(-.5, .6, -.2, -.4, 1, .2))], {keepAuthoredOverlaps: true});
  const initial = {table: pose(), payload: pose()};
  assert.equal(c.limit(initial, {table: pose(-.2), payload: pose(-.2)}, ['table', 'payload']).blocked, false);
  assert.ok(c.limit(initial, {table: pose(1), payload: pose(1)}, ['table', 'payload']).layout.table.x < .0051, 'cannot be pushed through the sheet');
  const stop = c.limit(initial, {table: pose(-1), payload: pose(-1)}, ['table', 'payload']);
  assert.equal(stop.blocked, true);
  assert.equal(stop.other.movingId, 'payload');
  near(stop.layout.table.x, stop.layout.payload.x);
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

test('owners handed to the collision worker unpack to the same triangles, sharing the same vertices', () => {
  const a = [0, 0, 0], b = [1.25, 0, 0], c = [0, 2.5, 1 / 3], d = [-1e-9, 3, 7];
  const owners = [{id: 'chair', name: '椅子', origin: [1, 0, 2], added: false, meshes: [{name: 'seat', triangles: [[a, b, c], [b, c, d]]}]},
    {id: 'room:Wall0', name: '墙', origin: [0, 0, 0], meshes: [{name: 'Wall0', triangles: [[d, a, b]]}]}];
  const {owners: packed, transfer} = packOwners(owners);
  assert.equal(transfer.length, 4);
  const back = unpackOwners(structuredClone(packed));
  assert.deepEqual(back, owners);
  const [first, second] = back[0].meshes[0].triangles;
  assert.equal(first[1], second[0], 'a vertex shared by two faces is still one array');
});
