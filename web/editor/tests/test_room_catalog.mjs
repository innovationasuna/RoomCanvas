import test from 'node:test';
import assert from 'node:assert/strict';
import {roomConfig} from '../room-catalog.mjs';
import {nearestWall} from '../wall-visibility.mjs';

const object = (id, category, role, extra = {}) => ({id, node: id, category, role, group: id, mount: null, wall: null,
  bbox_min: [0, 0, 0], bbox_max: [1, 1, 1], ...extra});
const doc = {
  format: 'roomcanvas-room-objects', version: 1, scene: 'test_room', floor: 'Floor0', walls: ['Wall0', 'Wall1'], ceiling: ['Ceiling0'],
  openings: {Wall0: ['Door0']},
  groups: [
    {id: 'Slipper0', category: 'shoe', mount: 'floor', wall: null, members: ['Slipper0'], support_parts: []},
    {id: 'Bed0', category: 'bed', mount: 'floor', wall: null, members: ['Bed0', 'Sheet'], support_parts: ['Mattress']},
    {id: 'Slipper1', category: 'shoe', mount: 'floor', wall: null, members: ['Slipper1'], support_parts: []},
    {id: 'Picture0', category: 'picture', mount: 'wall', wall: 'Wall1', members: ['Picture0'], support_parts: []},
  ],
  objects: [
    object('Floor0', 'floor', 'structure'), object('Wall0', 'wall', 'structure', {wall: 'Wall0'}),
    object('Wall1', 'wall', 'structure', {wall: 'Wall1'}), object('Ceiling0', 'ceiling', 'structure'),
    object('Door0', 'door', 'opening', {mount: 'wall', wall: 'Wall0'}),
    object('Bed0', 'bed', 'furniture', {bbox_min: [0, 0, 0], bbox_max: [2, .5, 1.6]}),
    object('Sheet', 'textile', 'furniture', {group: 'Bed0'}),
    object('Slipper0', 'shoe', 'furniture', {bbox_max: [.1, .05, .3]}),
    object('Slipper1', 'shoe', 'furniture', {bbox_max: [.1, .05, .3]}),
    object('Picture0', 'picture', 'furniture', {mount: 'wall', wall: 'Wall1', bbox_max: [1, 1, .05]}),
    object('Socket0', 'socket', 'fixture', {mount: 'wall', wall: 'Wall0'}),
    object('Downlight0', 'light', 'fixture', {mount: 'ceiling', bbox_min: [0, 2.6, 0], bbox_max: [.1, 2.62, .1]}),
    object('Curtain0', 'curtain', 'fixture', {mount: 'ceiling', bbox_min: [0, .1, 0], bbox_max: [1, 2.6, .1]}),
  ],
};

test('room objects become an editable catalog, largest first, with readable names', () => {
  const config = roomConfig(doc);
  assert.equal(config.sceneId, 'test_room');
  assert.deepEqual(config.catalog.map(({id, name}) => [id, name]),
    [['Bed0', '床'], ['Picture0', '挂画'], ['Slipper0', '鞋 1'], ['Slipper1', '鞋 2']]);
  assert.deepEqual(config.catalog[0].roots, ['Bed0', 'Sheet']);
  assert.equal(config.catalog[0].category, '床 · 连同上面 1 件');
  assert.deepEqual(config.placement.Bed0, {body: ['Bed0'], surfaces: ['Mattress']});
  assert.deepEqual(config.placement.Picture0, {body: ['Picture0'], wall: true});
  assert.deepEqual(config.placement.Slipper0, {body: ['Slipper0']});
});

test('a hand-written name wins, and chairs get their seat found in the mesh', () => {
  const named = {...doc, groups: [...doc.groups.map((group) => group.id === 'Slipper1' ? {...group, name: '左脚拖鞋'} : group),
    {id: 'Chair0', category: 'chair', mount: 'floor', wall: null, members: ['Chair0'], support_parts: []}],
    objects: [...doc.objects, object('Chair0', 'chair', 'furniture', {bbox_max: [.5, .9, .5]})]};
  const config = roomConfig(named);
  assert.deepEqual(config.catalog.filter(({id}) => id.startsWith('Slipper')).map(({name}) => name), ['鞋 1', '左脚拖鞋']);
  assert.deepEqual(config.placement.Chair0, {body: ['Chair0'], seat: 'auto'});
});

test('fixtures follow their wall or the ceiling; the floor stays where it is', () => {
  const config = roomConfig(doc);
  assert.deepEqual(config.openings, {Wall0: ['Door0']});
  assert.equal(config.wallOwner('Socket0'), 'Wall0');
  assert.equal(config.wallOwner('Door0'), 'Wall0');
  assert.equal(config.wallOwner('Wall1'), 'Wall1');
  assert.equal(config.wallOwner('Bed0'), null, 'furniture is hidden through its placement, not as wall trim');
  assert(config.isCeiling('Ceiling0') && config.isCeiling('Downlight0') && !config.isCeiling('Curtain0'));
  assert.deepEqual(config.nearWall, ['Curtain0']);
  assert(!config.nodes.some(({node}) => node === 'Floor0'));
  assert.deepEqual(config.nodes.find(({node}) => node === 'Sheet'), {node: 'Sheet', group: 'Bed0'});
  assert.equal(config.label('Socket0'), '插座');
  assert.throws(() => roomConfig({...doc, version: 2}), /格式不兼容/);
});

test('a curtain with no recorded wall belongs to the wall it hangs in front of', () => {
  // Wall A: x = 0 facing +x; wall B: z = 0 facing +z. Both 4 m long from the origin.
  const walls = [
    {name: 'A', n: [1, 0, 0], d: 0, tangent: [0, 0, 1], bounds: [[0, 0], [4, 2.6]]},
    {name: 'B', n: [0, 0, 1], d: 0, tangent: [-1, 0, 0], bounds: [[-4, 0], [0, 2.6]]},
  ];
  const curtain = [[.1, 0, 1], [.25, 2.5, 2]];
  assert.equal(nearestWall(curtain, walls), 'A');
  assert.equal(nearestWall(curtain.map(([x, y, z]) => [x + 1, y, z]), walls), null, 'too far into the room');
  assert.equal(nearestWall([[.1, 0, 5], [.2, 2, 6]], walls), null, 'beyond the end of the wall');
  assert.equal(nearestWall([[.1, 0, .1], [.3, 2, .2]], walls), 'B', 'the closer of two walls at a corner');
});
