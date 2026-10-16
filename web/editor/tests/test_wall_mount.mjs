import test from 'node:test';
import assert from 'node:assert/strict';
import {mountPose, mountedNormal, resolveMountedWall, nearestWallAlongRay, transformPoint, coverage, sampleHull} from '../placement.mjs';

const close = (actual, expected) => assert(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const closePoint = (actual, expected) => actual.forEach((value, i) => close(value, expected[i]));
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const wall = (name, n, d, range = [-3, 3]) => ({name, n, d, tangent: [-n[2], 0, n[0]], bounds: [[range[0], -2], [range[1], 2]]});
const back = {n: [0, 0, 1], center: [2, .8, -4]};
const origin = [2.2, -1.6, -3.7];

test('moving a wall object onto a perpendicular wall turns its back and preserves the clicked height', () => {
  const target = wall('east', [-1, 0, 0], -5), click = [5, .3, 1];
  const pose = mountPose(back, origin, target, click);
  close(pose.yaw, -Math.PI / 2);
  closePoint(mountedNormal(back.n, pose.yaw), target.n);
  closePoint(transformPoint(back.center, origin, pose), [4.997, .3, 1]);
});

test('opposite-wall mounting faces into the room and keeps the same back gap', () => {
  const target = wall('south', [0, 0, -1], -3);
  const pose = mountPose(back, origin, target, [-1.5, -.5, 3]);
  close(Math.abs(pose.yaw), Math.PI);
  closePoint(mountedNormal(back.n, pose.yaw), target.n);
  closePoint(transformPoint(back.center, origin, pose), [-1.5, -.5, 2.997]);
});

test('oblique mounting projects only wall depth and does not slide the click along the wall', () => {
  const theta = .37, target = wall('angled', [Math.sin(theta), 0, Math.cos(theta)], -1.2);
  const click = [1.3, .9, -.7], pose = mountPose(back, origin, target, click);
  const mounted = transformPoint(back.center, origin, pose);
  closePoint(mountedNormal(back.n, pose.yaw), target.n);
  close(dot(target.n, mounted) - target.d, .003);
  close(dot(target.tangent, mounted), dot(target.tangent, click));
  close(mounted[1], click[1]);
});

test('mounting on the authored wall keeps its orientation and origin-relative geometry', () => {
  const target = wall('original', back.n, -4.003);
  const pose = mountPose(back, origin, target, back.center);
  closePoint([pose.x, pose.y, pose.z, pose.yaw], [0, 0, 0, 0]);
  closePoint(transformPoint([2.4, 1, -3.8], origin, pose), [2.4, 1, -3.8]);
});

test('the saved pose alone restores the selected wall after serialization', () => {
  const targets = [wall('north', [0, 0, 1], -4.003), wall('east', [-1, 0, 0], -5), wall('south', [0, 0, -1], -3)];
  const pose = JSON.parse(JSON.stringify(mountPose(back, origin, targets[1], [5, .1, 0])));
  const resolved = resolveMountedWall(back, origin, pose, targets);
  assert.equal(resolved.wall.name, 'east');
  close(resolved.gap, .003);
  assert.equal(resolveMountedWall(back, origin, {...pose, yaw: pose.yaw + .5}, targets), null);
});

test('parallel wall segments are resolved by depth and finite segment extent', () => {
  const targets = [wall('left', [0, 0, 1], -2, [-4, -2]), wall('right', [0, 0, 1], -2, [0, 2]), wall('behind', [0, 0, 1], -3, [0, 2])];
  const pose = mountPose(back, origin, targets[1], [-1, .4, -2]);
  assert.equal(resolveMountedWall(back, origin, pose, targets).wall.name, 'right');
  const behindPose = mountPose(back, origin, targets[2], [-1, .4, -3]);
  assert.equal(resolveMountedWall(back, origin, behindPose, targets).wall.name, 'behind');
});

test('a rotated mounting patch must still fit the destination wall and its openings', () => {
  const target = wall('east', [-1, 0, 0], -5), pose = mountPose(back, origin, target, [5, 0, 0]);
  const samples = sampleHull([[-.8, -.4], [.8, -.4], [.8, .4], [-.8, .4]]).map(([x, y]) => {
    const p = transformPoint([back.center[0] + x, back.center[1] + y, back.center[2]], origin, pose);
    return [dot(target.tangent, p), p[1]];
  });
  const rect = (a, b, c, d) => [[[a, b], [c, b], [c, d]], [[a, b], [c, d], [a, d]]];
  assert.equal(coverage(samples, rect(-1, -1, 1, 1)).full, true);
  assert.equal(coverage(samples, rect(-.5, -1, .5, 1)).full, false, 'narrow wall cannot hold the patch');
  const window = [...rect(-1, -1, -.2, 1), ...rect(.2, -1, 1, 1), ...rect(-.2, -1, .2, -.2), ...rect(-.2, .2, .2, 1)];
  assert.equal(coverage(samples, window).full, false, 'an actual window remains unsupported after yaw');
});


test('camera-forward ray chooses the nearest finite inward-facing wall and keeps height', () => {
  const walls = [wall('source', [0, 0, 1], -4), wall('far', [0, 0, -1], -3), wall('near', [0, 0, -1], -1)];
  const target = nearestWallAlongRay([.2, .7, -3.997], {x: 0, z: 5}, walls, 'source');
  assert.equal(target.name, 'near');
  closePoint(target.point, [.2, .7, 1]);
  close(target.distance, 4.997);
});

test('reversing the view direction finds the previous wall after a transfer', () => {
  const walls = [wall('north', [0, 0, 1], -4), wall('south', [0, 0, -1], -3)];
  const forward = nearestWallAlongRay([0, .2, -3.997], [0, 0, 1], walls, 'north');
  assert.equal(forward.name, 'south');
  const backward = nearestWallAlongRay([0, .2, 2.997], [0, 0, -1], walls, 'south');
  assert.equal(backward.name, 'north');
  closePoint(backward.point, [0, .2, -4]);
  assert.equal(nearestWallAlongRay([0, .2, -3.997], [0, 0, -1], walls, 'north'), null, 'outward heading cannot leave through the source wall');
});

test('an oblique target uses the ray intersection instead of its center', () => {
  const n = [-Math.SQRT1_2, 0, -Math.SQRT1_2];
  const walls = [wall('source', [0, 0, 1], -2), wall('angled', n, -2 * Math.SQRT1_2)];
  const target = nearestWallAlongRay([0, -.3, -1.997], {x: .4, z: 1}, walls, 'source');
  assert.equal(target.name, 'angled');
  close(dot(n, target.point), walls[1].d);
  close(target.point[0] / (target.point[2] + 1.997), .4);
  close(target.point[1], -.3);
});

test('rays cannot hit the infinite extension outside a finite wall segment', () => {
  const walls = [wall('source', [0, 0, 1], -4), wall('short', [0, 0, -1], -1, [1, 2]), wall('far', [0, 0, -1], -3)];
  const target = nearestWallAlongRay([0, .1, -3.997], {x: 0, z: 1}, walls, 'source');
  assert.equal(target.name, 'far', 'the ray misses the actual short wall');
  assert.equal(nearestWallAlongRay([0, 3, -3.997], {x: 0, z: 1}, walls, 'source'), null, 'wall height bounds also apply');
});

test('a doorway or window remains the first target boundary instead of skipping to a rear wall', () => {
  const opening = wall('window', [0, 0, -1], -1);
  opening.triangles = []; opening.openings = [[[-1, -1], [1, -1], [1, 1], [-1, 1]]];
  const walls = [wall('source', [0, 0, 1], -4), opening, wall('behind-window', [0, 0, -1], -3)];
  const target = nearestWallAlongRay([0, .1, -3.997], [0, 0, 1], walls, 'source');
  assert.equal(target.name, 'window', 'mount() must reject this target; no subsequent candidate is tried');
});

test('parallel, back-facing, absent and invalid ray targets return null', () => {
  const source = wall('source', [0, 0, 1], -4);
  for (const others of [[], [wall('parallel', [1, 0, 0], 1)], [wall('back-facing', [0, 0, 1], 1)]]) {
    assert.equal(nearestWallAlongRay([0, 0, -3.997], [0, 0, 1], [source, ...others], 'source'), null);
  }
  assert.equal(nearestWallAlongRay([0, 0, -3.997], {x: 0, z: 0}, [source], 'source'), null);
  assert.equal(nearestWallAlongRay([NaN, 0, 0], {x: 0, z: 1}, [source], 'source'), null);
  assert.equal(nearestWallAlongRay([0, 0, 0], {x: 0, z: Infinity}, [source], 'source'), null);
});

test('an outward camera direction cannot bypass the source wall in a concave room', () => {
  const walls = [wall('source', [0, 0, 1], 0), wall('beyond-outside', [0, 0, 1], -2)];
  assert.equal(nearestWallAlongRay([0, 0, .003], {x: 0, z: -1}, walls, 'source'), null);
});
