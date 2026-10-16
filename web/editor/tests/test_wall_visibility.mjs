import test from 'node:test';
import assert from 'node:assert/strict';
import {hiddenWalls, deriveJoins, createWallVisibility} from '../wall-visibility.mjs';
const walls = [
  {name: 'Wall0', n: [1,0,0]}, {name: 'Wall1', n: [-1,0,0]},
  {name: 'Wall2', n: [0,0,1]}, {name: 'Wall3', n: [0,0,-1]},
];
test('view direction hides facing and edge-on walls and restores the opposite side', () => {
  assert.deepEqual([...hiddenWalls(walls, [4,3,0])], ['Wall1', 'Wall2', 'Wall3']);
  const corner = hiddenWalls(walls, [4,3,4]);
  assert.deepEqual([...corner], ['Wall1', 'Wall3']);
  assert.deepEqual([...hiddenWalls(walls, [-4,3,-4], corner)], ['Wall0', 'Wall2']);
  assert.deepEqual([...hiddenWalls(walls, [0,10,.001], corner)], []);
  assert.deepEqual([...hiddenWalls(walls, [0,0,0])], []);
});
test('grazing walls stay hidden without flicker and return when their inner face is visible', () => {
  const first = hiddenWalls(walls, [1,1,-.10]);
  assert(first.has('Wall3'));
  assert(hiddenWalls(walls, [1,1,-.14], first).has('Wall3'));
  assert(!hiddenWalls(walls, [1,1,-.14]).has('Wall3'));
  assert(hiddenWalls(walls, [1,1,0], first).has('Wall3'));
  assert(!hiddenWalls(walls, [1,1,-.20], first).has('Wall3'));
  assert.deepEqual([...hiddenWalls(walls, [0,10,0], first)], []);
});
test('complete wall visibility includes structural details without mutating furniture or ceilings', () => {
  const owners = {Wall1: 'Wall1', Skirting_Wall1: 'Wall1', Door0: 'Wall1', DoorServiceConduit0: 'Wall1'};
  const children = ['Wall1','Skirting_Wall1','Door0','DoorServiceConduit0','Chair0','Ceiling0'].map(name => ({name, visible: name !== 'Ceiling0'}));
  const controller = createWallVisibility({children}, walls, {owner: name => owners[name] || null});
  assert(controller.update([1,1,0]).changed);
  assert.deepEqual(children.map(root => root.visible), [false,false,false,false,true,false]);
  assert(!controller.update([1,1,0]).changed);
  controller.update([1,1,0], {reveal: true});
  assert.deepEqual(children.map(root => root.visible), [true,true,true,true,true,false]);
  controller.update([1,1,0]);
  controller.update([1,1,0], {enabled: false});
  assert.deepEqual(children.map(root => root.visible), [true,true,true,true,true,false]);
});
test('a grazing door wall removes the entire frame and conduit, not only its wall mesh', () => {
  const children = ['Wall1','Door0','DoorServiceConduit0'].map(name => ({name, visible: true}));
  const controller = createWallVisibility({children}, [{name:'Wall1', n:[0,0,1]}], {owner: () => 'Wall1'});
  controller.update([1,1,.10]);
  assert(children.every(root => !root.visible));
  controller.update([1,1,.20]);
  assert(children.every(root => root.visible));
});
const own = name => /^Wall\d+$/.test(name) ? name : name.match(/_(Wall\d+)$/)?.[1] || null;
// The office's three corners, as deriveJoins finds them (see below).
const officeJoins = [
  {ends: ['Wall1', 'Wall2'], returns: ['Wall4', 'Wall3']},
  {ends: ['Wall1', 'Wall5'], returns: ['Wall8', 'Wall7']},
  {ends: ['Wall0', 'Wall2'], returns: ['Wall6']},
];
test('office corner returns stay connected or disappear as a complete corner with their trim', () => {
  const normals = [[0,0,1],[0,0,-1],[-1,0,0],[0,0,-1],[-1,0,0],[1,0,0],[0,0,1],[0,0,-1],[1,0,0]];
  const office = normals.map((n,i) => ({name:`Wall${i}`,n}));
  const children = [...office.map(w => w.name),'Skirting_Wall7','Trunking_Wall8','Chair0'].map(name => ({name,visible:true}));
  const controller = createWallVisibility({children},office,{owner: own, joins: officeJoins});
  const visible = name => children.find(root => root.name===name).visible;
  controller.update([-1,1,-1]);
  assert(visible('Wall1') && visible('Wall2'));
  assert(visible('Wall3') && visible('Wall4'));
  assert(!visible('Wall5'));
  assert(!visible('Wall7') && !visible('Wall8'));
  assert(!visible('Skirting_Wall7') && !visible('Trunking_Wall8'));
  assert(!visible('Wall6'));
  controller.update([1,1,1]);
  assert(visible('Wall0') && visible('Wall5'));
  for (const name of ['Wall3','Wall4','Wall6','Wall7','Wall8']) assert(!visible(name));
  controller.update([-1,1,1]);
  assert(visible('Wall0') && visible('Wall2') && visible('Wall6'));
  controller.update([0,1,0]);
  assert(children.every(root => root.visible));
  controller.update([-1,1,-1]);
  controller.update([-1,1,-1],{reveal:true});
  assert(children.every(root => root.visible));
  controller.update([-1,1,-1]);
  controller.update([-1,1,-1],{enabled:false});
  assert(children.every(root => root.visible));
});
test('editing a fixture reveals only its mount and recomputes corner connections across camera changes', () => {
  const office = [{name:'Wall1',n:[0,0,-1]},{name:'Wall2',n:[-1,0,0]},
    {name:'Wall3',n:[0,0,-1]},{name:'Wall4',n:[-1,0,0]}];
  const children = office.map(w => ({name:w.name,visible:true}));
  const controller = createWallVisibility({children},office,{owner: own, joins: officeJoins});
  assert.deepEqual(controller.update([1,1,1],{revealWalls:['Wall1']}).hidden,['Wall2','Wall3','Wall4']);
  assert.deepEqual(controller.update([-1,1,1],{revealWalls:['Wall1']}).hidden,[]);
  assert.deepEqual(controller.update([1,1,-1],{revealWalls:['Wall2']}).hidden,[]);
  assert.deepEqual(controller.update([1,1,-1]).hidden,['Wall2','Wall3','Wall4']);
});
test('short walls between two long ones are found as corner returns from their end points', () => {
  // Inner-face end points of the office walls, in metres (x, z), measured from the sample.
  const ends = {Wall0: [[-.038,-2.273],[-3.982,-.69]], Wall1: [[-3.379,1.772],[.589,1.431]], Wall2: [[.904,1.127],[.607,-2.329]],
    Wall3: [[.565,1.155],[.904,1.126]], Wall4: [[.589,1.432],[.565,1.156]], Wall5: [[-3.982,-.691],[-3.786,1.585]],
    Wall6: [[.607,-2.328],[-.039,-2.273]], Wall7: [[-3.787,1.584],[-3.398,1.551]], Wall8: [[-3.397,1.551],[-3.378,1.773]]};
  // Describe each as a wall on the line through its two ends: tangent along it, d = 0 offset.
  const walls = Object.entries(ends).map(([name, [a, b]]) => {
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]), t = [(b[0] - a[0]) / length, 0, (b[1] - a[1]) / length];
    const n = [-t[2], 0, t[0]], d = n[0] * a[0] + n[2] * a[1], u = t[0] * a[0] + t[2] * a[1];
    return {name, n, d, tangent: t, bounds: [[u, 0], [u + length, 2.6]]};
  });
  const joins = deriveJoins(walls).map(({ends, returns}) => ({ends, returns: [...returns].sort()}));
  assert.deepEqual(joins.sort((a, b) => a.ends.join().localeCompare(b.ends.join())), [
    {ends: ['Wall0', 'Wall2'], returns: ['Wall6']},
    {ends: ['Wall1', 'Wall2'], returns: ['Wall3', 'Wall4']},
    {ends: ['Wall1', 'Wall5'], returns: ['Wall7', 'Wall8']},
  ]);
  assert.deepEqual(deriveJoins([{name: 'Wall0', n: [1, 0, 0]}]), [], 'walls without geometry have no joins');
});
