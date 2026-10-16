import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FORMAT, VERSION, initialLayout, copyLayout, sameLayout, encodeLayout,
  decodeLayout, groundBasis, wallBasis, move, rotate, History,
} from '../layout.mjs';

test('v3 inventory visibility round-trips and participates in undo/redo', () => {
  const before = initialLayout(['chair']);
  const next = copyLayout(before);
  next.chair.visible = false;
  assert.equal(sameLayout(before, next), false);
  const encoded = encodeLayout(next, 'inventory');
  assert.equal(encoded.version, 3);
  assert.equal(encoded.objects[0].visible, false);
  assert.deepEqual(decodeLayout(encoded, 'inventory', ['chair']), next);
  const history = new History();
  assert.equal(history.commit(before, next), true);
  assert.deepEqual(history.undo(next), before);
  assert.deepEqual(history.redo(before), next);
  assert.equal(sameLayout(before, {chair: {...before.chair, visible: true}}), true);
});

test('v2 layouts stay visible without adding inventory fields', () => {
  const before = initialLayout(['chair']);
  const document = encodeLayout(before, 'inventory');
  document.version = 2;
  const decoded = decodeLayout(document, 'inventory', ['chair']);
  assert.deepEqual(decoded, before);
  assert.equal(Object.hasOwn(copyLayout(decoded).chair, 'visible'), false);
  assert.equal(Object.hasOwn(encodeLayout(decoded, 'inventory').objects[0], 'visible'), false);
});

test('v3 rejects invalid visibility before returning an imported layout', () => {
  const document = encodeLayout(initialLayout(['chair']), 'inventory');
  for (const visible of [null, 0, 'false', {}]) {
    document.objects[0].visible = visible;
    assert.throws(() => decodeLayout(document, 'inventory', ['chair']), /可见性/);
  }
});

const IDS = ['Table1', 'Chair0', 'ShelfPhoto'];
const SCENE = 'office-fixture:v1';
const EPSILON = 1e-10;

function close(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < EPSILON,
    `${message}: expected ${expected}, received ${actual}`);
}

function freezeDocument(document) {
  document.objects.forEach(Object.freeze);
  Object.freeze(document.objects);
  return Object.freeze(document);
}

test('camera-relative movement remains orthonormal and reversible in each view', async (t) => {
  const views = [
    {name: 'front', right: {x: 1, y: 0, z: 0}, forward: {x: 0, z: -1}},
    {name: 'side', right: {x: 0, y: 0, z: 1}, forward: {x: 1, z: 0}},
    {name: 'reverse', right: {x: -1, y: 0, z: 0}, forward: {x: 0, z: 1}},
    {name: 'oblique', right: {x: 3, y: 0, z: 4}, forward: {x: .8, z: -.6}},
    // A near-vertical view must derive movement from screen-right, not from
    // a camera forward vector whose projection onto the floor vanishes.
    {name: 'near top-down', right: {x: Math.SQRT1_2, y: 1e-7, z: -Math.SQRT1_2},
      forward: {x: -Math.SQRT1_2, z: -Math.SQRT1_2}},
  ];
  for (const view of views) await t.test(view.name, () => {
    const basis = groundBasis(view.right);
    close(Math.hypot(basis.right.x, basis.right.z), 1, 'right length');
    close(Math.hypot(basis.forward.x, basis.forward.z), 1, 'forward length');
    close(basis.right.x * basis.forward.x + basis.right.z * basis.forward.z, 0, 'orthogonality');
    close(basis.forward.x, view.forward.x, 'forward x');
    close(basis.forward.z, view.forward.z, 'forward z');
    const layout = initialLayout(IDS);
    layout.Table1 = {x: 2.75, y: .45, z: -1.125, yaw: .3};
    layout.Chair0 = {x: -.2, y: .8, z: .7, yaw: -.4};
    const original = copyLayout(layout);
    move(layout, 'Table1', 'forward', .2, basis);
    close(layout.Table1.x, original.Table1.x + .2 * view.forward.x, 'forward delta x');
    close(layout.Table1.z, original.Table1.z + .2 * view.forward.z, 'forward delta z');
    move(layout, 'Table1', 'back', .2, basis);
    move(layout, 'Table1', 'right', .4, basis);
    close(layout.Table1.x, original.Table1.x + .4 * basis.right.x, 'right delta x');
    close(layout.Table1.z, original.Table1.z + .4 * basis.right.z, 'right delta z');
    move(layout, 'Table1', 'left', .4, basis);
    assert.ok(sameLayout(layout, original), 'four-direction round trip restores layout');
    assert.deepEqual(layout.Chair0, original.Chair0, 'another movable object is preserved');
    assert.deepEqual(layout.ShelfPhoto, original.ShelfPhoto, 'untouched object is preserved');
    assert.equal(layout.Table1.yaw, original.Table1.yaw, 'translation preserves rotation');
    assert.equal(layout.Table1.y, original.Table1.y, 'floor translation preserves height');
  });
});

test('degenerate screen-right has a finite deterministic ground basis', () => {
  assert.deepEqual(groundBasis({x: 0, y: 1, z: 0}), {
    right: {x: 1, z: 0}, forward: {x: 0, z: -1},
  });
  assert.deepEqual(groundBasis({x: 1e-12, z: -1e-12}), {
    right: {x: 1, z: 0}, forward: {x: 0, z: -1},
  });
});

test('wall left/right keep the full step across oblique and end-on camera angles', () => {
  const tangent = [3, 0, 4];
  for (const right of [{x: 1, z: 0}, {x: -1, z: 0}, {x: .8, z: -.6}, {x: .799, z: -.6}]) {
    const basis = groundBasis(right), axes = wallBasis(tangent, basis), layout = initialLayout(IDS);
    layout.ShelfPhoto.y = .6; layout.ShelfPhoto.yaw = 1;
    const before = copyLayout(layout);
    move(layout, 'ShelfPhoto', 'right', .1, axes);
    close(Math.hypot(layout.ShelfPhoto.x, layout.ShelfPhoto.z), .1, 'full tangential step');
    close(layout.ShelfPhoto.x * 4 - layout.ShelfPhoto.z * 3, 0, 'stays on wall tangent');
    assert(axes.right.x * basis.right.x + axes.right.z * basis.right.z >= -EPSILON, 'right agrees with screen');
    assert.deepEqual(axes.forward, basis.forward, 'depth direction retains camera basis');
    move(layout, 'ShelfPhoto', 'left', .1, axes);
    assert(sameLayout(layout, before));
  }
});

test('translation rejects unusable amounts and cannot exceed the importable bounds', () => {
  const layout = initialLayout(IDS);
  const basis = groundBasis({x: 1, z: 0});
  for (const amount of [0, -1, NaN, Infinity]) move(layout, 'Table1', 'right', amount, basis);
  move(layout, 'missing', 'right', 1, basis);
  assert.deepEqual(layout, initialLayout(IDS));
  layout.Table1.x = 999.9;
  layout.Table1.z = -999.9;
  move(layout, 'Table1', 'right', .2, basis);
  move(layout, 'Table1', 'forward', .2, basis);
  assert.deepEqual(layout.Table1, {x: 1000, y: 0, z: -1000, yaw: 0});
  assert.deepEqual(decodeLayout(encodeLayout(layout, SCENE), SCENE, IDS), layout);
});

test('vertical movement is reversible and preserves the floor position, rotation and other objects', () => {
  const layout = initialLayout(IDS);
  layout.Table1 = {x: .8, y: .35, z: -.4, yaw: .2};
  layout.Chair0.y = .7;
  const original = copyLayout(layout);
  // Height does not depend on a camera basis, including in top-down views.
  move(layout, 'Table1', 'up', .25);
  close(layout.Table1.y, .6, 'up delta');
  assert.equal(layout.Table1.x, original.Table1.x);
  assert.equal(layout.Table1.z, original.Table1.z);
  assert.equal(layout.Table1.yaw, original.Table1.yaw);
  assert.deepEqual(layout.Chair0, original.Chair0);
  assert.deepEqual(layout.ShelfPhoto, original.ShelfPhoto);
  move(layout, 'Table1', 'down', .25);
  assert.ok(sameLayout(layout, original));
});

test('vertical movement rejects unusable amounts and clamps both height bounds', () => {
  const layout = initialLayout(IDS);
  for (const direction of ['up', 'down']) {
    for (const amount of [0, -1, NaN, Infinity]) move(layout, 'Table1', direction, amount);
  }
  move(layout, 'missing', 'up', 1);
  assert.deepEqual(layout, initialLayout(IDS));
  layout.Table1.y = 999.9;
  move(layout, 'Table1', 'up', .2);
  assert.equal(layout.Table1.y, 1000);
  assert.deepEqual(decodeLayout(encodeLayout(layout, SCENE), SCENE, IDS), layout);
  layout.Table1.y = -999.9;
  move(layout, 'Table1', 'down', .2);
  assert.equal(layout.Table1.y, -1000);
  assert.deepEqual(decodeLayout(encodeLayout(layout, SCENE), SCENE, IDS), layout);
  assert.deepEqual(layout.Chair0, initialLayout(IDS).Chair0);
});

test('unsupported movement directions are no-ops even without a camera basis', () => {
  const layout = initialLayout(IDS);
  layout.Table1.y = .6;
  const original = copyLayout(layout);
  for (const direction of ['backward', 'UP', '', undefined, null]) {
    move(layout, 'Table1', direction, .2);
  }
  assert.deepEqual(layout, original);
});

test('rotation crosses both pi boundaries while preserving translation and other objects', () => {
  const layout = initialLayout(IDS);
  layout.Table1 = {x: .2, y: .7, z: -.3, yaw: Math.PI - .1};
  rotate(layout, 'Table1', .2);
  close(layout.Table1.yaw, -Math.PI + .1, 'positive wrap');
  rotate(layout, 'Table1', -.2);
  close(layout.Table1.yaw, Math.PI - .1, 'negative wrap');
  rotate(layout, 'Table1', 8 * Math.PI);
  close(layout.Table1.yaw, Math.PI - .1, 'multiple full turns');
  assert.equal(layout.Table1.x, .2);
  assert.equal(layout.Table1.y, .7);
  assert.equal(layout.Table1.z, -.3);
  assert.deepEqual(layout.Chair0, {x: 0, y: 0, z: 0, yaw: 0});
  const before = copyLayout(layout);
  rotate(layout, 'missing', .1);
  assert.deepEqual(layout, before);
});

test('undo/redo restores complete snapshots and a new branch discards redo', () => {
  const history = new History();
  const zero = initialLayout(IDS);
  const moved = copyLayout(zero);
  moved.Table1.x = 1;
  assert.equal(history.commit(zero, moved), true);
  const rotated = copyLayout(moved);
  rotated.Chair0.yaw = .5;
  history.commit(moved, rotated);
  let current = history.undo(rotated);
  assert.deepEqual(current, moved);
  assert.deepEqual(history.redo(current), rotated);
  current = history.undo(rotated);
  const branch = copyLayout(current);
  branch.ShelfPhoto.z = .25;
  history.commit(current, branch);
  assert.equal(history.redo(branch), null, 'the abandoned branch cannot reappear');
  current = history.undo(branch);
  assert.deepEqual(current, moved);
  assert.deepEqual(history.undo(current), zero);
  assert.equal(history.undo(zero), null);
});

test('history retains redo after a no-op and stores isolated snapshots', () => {
  const history = new History();
  const before = initialLayout(IDS);
  const after = copyLayout(before);
  after.Table1.x = .5;
  history.commit(before, after);
  before.Table1.x = 99;
  const current = history.undo(after);
  assert.equal(current.Table1.x, 0, 'commit copied the before snapshot');
  after.Table1.x = 77;
  assert.equal(history.commit(current, copyLayout(current)), false);
  const redone = history.redo(current);
  assert.equal(redone.Table1.x, .5, 'undo copied current and no-op preserved redo');
});

test('undo and redo restore vertical edits without changing other objects', () => {
  const history = new History();
  const before = initialLayout(IDS);
  before.Chair0 = {x: .3, y: .8, z: -.2, yaw: -.1};
  const raised = copyLayout(before);
  move(raised, 'Table1', 'up', .45);
  assert.equal(history.commit(before, raised), true, 'height alone creates a history entry');
  const restored = history.undo(raised);
  assert.deepEqual(restored, before);
  const redone = history.redo(restored);
  assert.deepEqual(redone, raised);
  assert.deepEqual(redone.Chair0, before.Chair0);
  assert.deepEqual(redone.ShelfPhoto, before.ShelfPhoto);
});

test('history applies its undo limit without losing the newest edit', () => {
  const history = new History(2);
  let current = initialLayout(IDS);
  for (let position = 1; position <= 3; position++) {
    const next = copyLayout(current);
    next.Table1.x = position;
    history.commit(current, next);
    current = next;
  }
  current = history.undo(current);
  assert.equal(current.Table1.x, 2);
  current = history.undo(current);
  assert.equal(current.Table1.x, 1);
  assert.equal(history.undo(current), null);
});

test('layout JSON round-trips with reordered objects and no aliases', () => {
  const layout = initialLayout(IDS);
  layout.Table1 = {x: .35, y: .625, z: -.75, yaw: -Math.PI};
  const document = encodeLayout(layout, SCENE);
  assert.equal(document.format, FORMAT);
  assert.equal(document.version, VERSION);
  document.objects.reverse();
  freezeDocument(document);
  const decoded = decodeLayout(document, SCENE, IDS);
  assert.deepEqual(decoded, layout);
  decoded.Table1.x = 90;
  assert.equal(layout.Table1.x, .35);
  assert.equal(document.objects.find(({id}) => id === 'Table1').x, .35);
});

test('legacy layouts treat missing height as zero and are encoded with explicit height', () => {
  const legacy = Object.fromEntries(IDS.map((id) => [id, {x: 0, z: 0, yaw: 0}]));
  const current = initialLayout(IDS);
  assert.ok(sameLayout(legacy, current));
  assert.ok(sameLayout(current, legacy));
  assert.deepEqual(copyLayout(legacy), current);
  const encoded = encodeLayout(legacy, SCENE);
  assert.equal(encoded.version, VERSION);
  assert.deepEqual(decodeLayout(encoded, SCENE, IDS), current);
  assert.ok(encoded.objects.every((item) => Object.hasOwn(item, 'y') && item.y === 0));
  assert.ok(!Object.hasOwn(legacy.Table1, 'y'), 'normalization leaves the original object unchanged');
  move(legacy, 'Table1', 'up', .3);
  assert.equal(legacy.Table1.y, .3, 'vertical movement supports a legacy in-memory object');
  assert.equal(sameLayout(legacy, current), false);
});

test('version 1 documents upgrade to zero-height offsets without changing the scene signature', () => {
  const document = {
    format: FORMAT, version: 1, scene: SCENE,
    objects: IDS.map((id) => ({id, x: .2, z: -.3, yaw: .4})),
  };
  freezeDocument(document);
  const decoded = decodeLayout(document, SCENE, IDS);
  for (const id of IDS) assert.deepEqual(decoded[id], {x: .2, y: 0, z: -.3, yaw: .4});
  const upgraded = encodeLayout(decoded, SCENE);
  assert.equal(upgraded.scene, document.scene);
  assert.equal(upgraded.version, VERSION);
  assert.deepEqual(decodeLayout(upgraded, SCENE, IDS), decoded);
  assert.ok(!Object.hasOwn(document.objects[0], 'y'), 'upgrading does not mutate a v1 document');
});

test('imports reject incompatible or invalid files atomically', async (t) => {
  const mutations = [
    ['other scene', (doc) => {doc.scene = 'another-room';}],
    ['other format', (doc) => {doc.format = 'other-format';}],
    ['other version', (doc) => {doc.version = VERSION + 1;}],
    ['missing object', (doc) => {doc.objects.pop();}],
    ['unknown object', (doc) => {doc.objects[2].id = 'Chair999';}],
    ['duplicate ID', (doc) => {doc.objects[2].id = doc.objects[0].id;}],
    ['NaN after a valid first object', (doc) => {doc.objects[1].x = NaN;}],
    ['Infinity', (doc) => {doc.objects[1].z = Infinity;}],
    ['string coordinate', (doc) => {doc.objects[1].x = '0.2';}],
    ['missing coordinate', (doc) => {delete doc.objects[1].yaw;}],
    ['oversized translation', (doc) => {doc.objects[1].x = 1000.01;}],
    ['missing height in version 2', (doc) => {delete doc.objects[1].y;}],
    ['NaN height', (doc) => {doc.objects[1].y = NaN;}],
    ['infinite height', (doc) => {doc.objects[1].y = Infinity;}],
    ['string height', (doc) => {doc.objects[1].y = '0.2';}],
    ['null height', (doc) => {doc.objects[1].y = null;}],
    ['height above upper bound', (doc) => {doc.objects[1].y = 1000.01;}],
    ['height below lower bound', (doc) => {doc.objects[1].y = -1000.01;}],
    ['unnormalized rotation', (doc) => {doc.objects[1].yaw = Math.PI + .01;}],
    ['null object', (doc) => {doc.objects[1] = null;}],
    ['non-array objects', (doc) => {doc.objects = {};}],
  ];
  for (const [name, mutate] of mutations) await t.test(name, () => {
    let current = initialLayout(IDS);
    current.Chair0.z = .65;
    const original = copyLayout(current);
    const document = encodeLayout(initialLayout(IDS), SCENE);
    document.objects[0].x = 12; // This valid early record must never leak through.
    mutate(document);
    const before = structuredClone(document);
    assert.throws(() => {current = decodeLayout(document, SCENE, IDS);});
    assert.deepEqual(current, original, 'an invalid import leaves the active layout unchanged');
    assert.deepEqual(document, before, 'validation does not modify the submitted document');
  });
  assert.throws(() => decodeLayout(null, SCENE, IDS));
});
