import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {createWalk} from '../editor/walk.mjs';
import {bindTouchWalk} from '../editor/touch-walk.mjs';
import {installMobileTextures} from './texture-loader.mjs';
import {createRoomVisibility} from './room-visibility.mjs';
import {createMobileLighting} from './lighting.mjs';
import {createEnvironmentLighting} from '../editor/environment-lighting.mjs';
import {createStaticLighting} from '../editor/static-lighting.mjs';
import {offsetDecals} from '../editor/decals.mjs';

const $ = id => document.getElementById(id), identifier = location.pathname.match(/^\/s\/([a-f0-9]{32})\/?$/)?.[1];
let manifest, abort, renderer, scene, camera, orbit, walk, room, cleanupTouch, environment, textureResources, roomVisibility, lighting, staticLighting, frame = 0;
const status = message => {$('status').textContent = message;};
function render() {
  if (frame || !renderer) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    if (!staticLighting) return;
    const visibility = roomVisibility?.update(camera.position.clone().sub(orbit.target).toArray(), {walking: !!walk?.active});
    $('viewport').dataset.hiddenWalls = visibility?.hidden.join(',') || '';
    if (visibility?.changed) renderer.shadowMap.needsUpdate = true;
    if (renderer.shadowMap.needsUpdate) lighting?.syncOccluders();
    const view = walk?.active ? walk.camera : camera;
    staticLighting.setCamera(view); staticLighting.render();
  });
}
function resize() {
  if (!renderer) return;
  const {clientWidth: w, clientHeight: h} = $('viewport');
  renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); walk?.resize(w, h); render();
}
function setWalking(value) {
  if (!walk) return;
  orbit.enabled = !value;
  if (value) walk.enter(); else walk.exit();
  $('touch-pad').hidden = !value;
  $('walk').textContent = value ? '退出漫游' : '走进房间';
  $('view-hint').textContent = value ? '左侧移动，画面滑动转向' : '单指旋转，双指缩放';
  render();
}
function dispose() {
  cancelAnimationFrame(frame); frame = 0;
  walk?.exit(); cleanupTouch?.(); orbit?.dispose(); staticLighting?.dispose(); lighting?.dispose(); environment?.dispose();
  staticLighting = null; lighting = null;
  const geometries = new Set(), materials = new Set(), textures = new Set();
  room?.traverse(o => {if (o.isMesh) {geometries.add(o.geometry); [o.material].flat().forEach(m => {materials.add(m); Object.values(m).forEach(t => {if (t?.isTexture) textures.add(t);});});}});
  geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); textures.forEach(t => t.dispose());
  textureResources?.dispose(); textureResources = null;
  renderer?.dispose(); $('viewport').replaceChildren(); renderer = null; room = null; walk = null;
  cleanupTouch = null; orbit = null; environment = null; roomVisibility = null;
  $('touch-pad').hidden = true; $('walk').textContent = '走进房间';
}
async function readManifest() {
  if (!identifier) throw new Error('分享地址不完整，请重新扫描电脑上的二维码');
  const response = await fetch(`/s/${identifier}/manifest.json`, {cache: 'no-cache'});
  if (!response.ok) throw new Error('分享不存在或已失效，请在电脑上重新生成');
  const value = await response.json();
  if (value.schema !== 1 || value.id !== identifier || value.model?.url !== `/s/${identifier}/room.glb`) throw new Error('分享信息无效，请重新生成');
  manifest = value;
  $('room-name').textContent = manifest.name;
  document.title = `${manifest.name} · RoomCanvas`;
  $('version').textContent = `版本 ${manifest.version.slice(0, 8)} · ${new Date(manifest.createdAt).toLocaleString()} · ${(manifest.model.bytes / 1048576).toFixed(1)} MB`;
  $('open-browser').disabled = false;
  $('download-model').href = manifest.model.url; $('download-model').hidden = false;
  const appleMobile = /iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  // Keep the Android entry discoverable, including browsers using desktop mode.
  // iPhone/iPad have no native app, so explain the disabled action instead of hiding it.
  $('open-app').setAttribute('aria-disabled', String(appleMobile));
  if (appleMobile) {
    $('open-app').removeAttribute('href');
    $('app-requirement').textContent = '当前设备不支持 Android App，请使用“在浏览器中体验”。如需 App，请在安卓手机安装 RoomCanvas 0.2.0 或更新版本。';
  } else {
    $('open-app').href = `roomcanvas://import?manifest=${encodeURIComponent(new URL(`/s/${identifier}/manifest.json`, location.href).href)}`;
  }
  $('open-app').onclick = event => {
    if (appleMobile) {event.preventDefault(); $('app-hint').textContent = 'iPhone / iPad 暂无原生 App，请点击上方“在浏览器中体验”。';}
    $('app-hint').hidden = false;
  };
  status('已连接。选择打开方式。'); $('retry').hidden = true;
}
async function loadRoom() {
  if (abort) return;
  abort = new AbortController(); const signal = abort.signal;
  $('entry').hidden = true; $('experience').hidden = false; document.body.classList.add('loading-view');
  $('cancel').hidden = false; $('retry').hidden = true; $('progress').hidden = false; $('progress').value = 0;
  $('walk').disabled = $('reset').disabled = true;
  try {
    dispose();
    const response = await fetch(manifest.model.url, {signal});
    if (!response.ok) throw new Error('房间下载失败，请确认电脑服务仍在运行');
    const reader = response.body.getReader(), chunks = []; let received = 0;
    while (true) {
      const {done, value} = await reader.read(); if (done) break;
      received += value.byteLength;
      if (received > manifest.model.bytes || received > 512 * 1048576) {await reader.cancel(); throw new Error('房间文件大小与分享信息不一致');}
      chunks.push(value); $('progress').value = received / manifest.model.bytes;
      status(`正在下载房间 ${Math.round(received / manifest.model.bytes * 100)}%`);
    }
    if (received !== manifest.model.bytes) throw new Error('下载不完整，请重试');
    status('正在解析模型与贴图…'); $('progress').removeAttribute('value');
    const data = new Uint8Array(received); let offset = 0;
    for (const chunk of chunks) {data.set(chunk, offset); offset += chunk.byteLength;}
    chunks.length = 0;
    const loader = new GLTFLoader();
    textureResources = installMobileTextures(THREE, loader, {signal});
    const gltf = await loader.parseAsync(data.buffer, '');
    room = gltf.scene;
    textureResources.check();
    offsetDecals(THREE, room, gltf.parser.associations);
    if (signal.aborted) throw new DOMException('已取消', 'AbortError');
    renderer = new THREE.WebGLRenderer({antialias: true, powerPreference: 'low-power'});
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.domElement.setAttribute('aria-label', '房间三维场景'); $('viewport').append(renderer.domElement);
    scene = new THREE.Scene(); scene.background = new THREE.Color('#ebe7da'); scene.add(room);
    const box = new THREE.Box3().setFromObject(room), center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
    camera = new THREE.PerspectiveCamera(50, 1, .03, 2000);
    camera.position.copy(center).add(new THREE.Vector3(size.x * .85, Math.max(size.x, size.z), size.z * 1.1));
    orbit = new OrbitControls(camera, renderer.domElement); orbit.target.copy(center); orbit.update(); orbit.saveState(); orbit.addEventListener('change', render);
    room.updateMatrixWorld(true);
    roomVisibility = createRoomVisibility(THREE, room);
    const floor = room.getObjectByName('Floor0'), floorBox = floor ? new THREE.Box3().setFromObject(floor) : box;
    const floorY = Number.isFinite(manifest.floorY) ? manifest.floorY : floorBox.min.y;
    lighting = createMobileLighting(THREE, {renderer, scene, visibility: roomVisibility, bounds: box, floorY});
    await lighting.ready;
    if (signal.aborted) throw new DOMException('已取消', 'AbortError');
    if (lighting.settings.environment) environment = createEnvironmentLighting(renderer, scene, {intensity: scene.environmentIntensity});
    walk = createWalk(THREE, {canvas: renderer.domElement, room, floorY,
      bounds: {min: [floorBox.min.x, floorBox.min.z], max: [floorBox.max.x, floorBox.max.z]},
      solid: hit => ![hit.object.material].flat().every(m => m.transparent && m.opacity < .2),
      onChange: render, onClick: () => {}, onExit: () => setWalking(false)});
    cleanupTouch = bindTouchWalk($('touch-pad'), walk);
    staticLighting = createStaticLighting({renderer, scene, camera, room, roomSize: size,
      enabled: lighting.settings.ao, grading: lighting.settings.grading, busy: () => document.hidden || !!walk?.moving()});
    $('walk').disabled = $('reset').disabled = false;
    document.body.classList.remove('loading-view'); $('progress').hidden = true;
    status('房间已加载');
    // Read-only diagnostics for real-device verification; no model mutation exposed.
    $('viewport').dataset.textureBytes = String(textureResources.stats().decodedBytes);
    $('viewport').dataset.textureEdge = String(textureResources.stats().edge);
    $('viewport').dataset.lighting = lighting.settings.preset;
    resize();
  } catch (error) {
    dispose(); status(error.name === 'AbortError' ? '已取消加载，可重新打开房间' : error.message || '加载失败，请重试');
    $('retry').hidden = false; $('progress').hidden = true;
  } finally {abort = null; $('cancel').hidden = true;}
}
$('open-browser').onclick = loadRoom;
$('retry').onclick = () => {if (manifest) loadRoom(); else init();};
$('cancel').onclick = () => abort?.abort();
$('back').onclick = () => {
  if (abort) {abort.abort(); return;}
  setWalking(false); $('experience').hidden = true; $('entry').hidden = false; document.body.classList.remove('loading-view');
};
$('walk').onclick = () => setWalking(!walk.active);
$('reset').onclick = () => {if (walk.active) walk.reset(); else orbit.reset(); render();};
window.addEventListener('resize', resize);
window.addEventListener('pagehide', () => {abort?.abort(); setWalking(false);});
document.addEventListener('visibilitychange', () => {if (document.hidden) staticLighting?.pause(); else {staticLighting?.resume(); render();}});
async function init() {try {await readManifest();} catch (error) {status(error.message || '无法连接电脑，请确认同一 Wi-Fi 并重试'); $('retry').hidden = false;}}
init();
