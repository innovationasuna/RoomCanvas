import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {photoFormat, preparePhoto} from '../object-photos.mjs';

test('image signatures detect HEIC even when its filename and MIME type claim PNG or JPEG', async () => {
  const heic = await readFile(new URL('./fixtures/photo.heic', import.meta.url));
  assert.equal(photoFormat(heic.subarray(0, 256)), 'heic');
  assert.equal(photoFormat(await readFile(new URL('./fixtures/photo.png', import.meta.url))), 'png');
  assert.equal(photoFormat(new Uint8Array([255, 216, 255, 224])), 'jpeg');
  assert.equal(photoFormat(new Uint8Array()), null);
  assert.equal(photoFormat(new TextEncoder().encode('not an image.png')), null);
});

test('HEIF compatible brands are recognised without mistaking AVIF or arbitrary boxes for HEIC', () => {
  const box = (...brands) => {
    const bytes = new Uint8Array(16 + (brands.length - 1) * 4), encoder = new TextEncoder();
    new DataView(bytes.buffer).setUint32(0, bytes.length);
    bytes.set(encoder.encode('ftyp'), 4); bytes.set(encoder.encode(brands[0]), 8);
    brands.slice(1).forEach((brand, i) => bytes.set(encoder.encode(brand), 16 + i * 4));
    return bytes;
  };
  for (const brands of [['mif1'], ['heix'], ['heis'], ['msf1'], ['iso8', 'heic']]) assert.equal(photoFormat(box(...brands)), 'heic');
  assert.equal(photoFormat(box('avif', 'mif1')), null);
  const wrongBox = box('heic'); wrongBox.set(new TextEncoder().encode('free'), 4);
  assert.equal(photoFormat(wrongBox), null);
});

test('unreadable and empty photos fail before creating a preview or upload entry', async () => {
  await assert.rejects(preparePhoto(new File([], 'empty.png', {type: 'image/png'})), /empty.png/);
  await assert.rejects(preparePhoto({name: 'cloud.heic', arrayBuffer: async () => {throw new Error('unavailable');}}), /下载到本机/);
});
