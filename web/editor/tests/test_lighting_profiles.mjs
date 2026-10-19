import {test} from 'node:test';
import assert from 'node:assert/strict';
import {lightingProfile,LIGHTING_PROFILES} from '../lighting-profiles.mjs';

test('original URL keeps legacy exposure and light intensities; initial enhancement is separately reproducible', () => {
  const original=lightingProfile('off');
  assert.deepEqual(original,{name:'original',hemisphere:2.5,key:2.4,fill:1.4,exposure:1.15,environment:0});
  assert.deepEqual(lightingProfile('original'),original);
  assert.equal(lightingProfile('initial').environment,.18);
});

test('one default balanced profile is shared, with immutable source values and no room-specific selection', () => {
  assert.equal(lightingProfile(null).name,'balanced');assert.equal(lightingProfile('unknown').name,'balanced');
  const a=lightingProfile('balanced'), b=lightingProfile('balanced');a.key=100;
  assert.equal(b.key,3);assert.equal(LIGHTING_PROFILES.balanced.key,3);
  assert.ok(b.hemisphere < LIGHTING_PROFILES.original.hemisphere && b.fill < LIGHTING_PROFILES.original.fill);
});
