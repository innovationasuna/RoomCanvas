import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {VERSION, initialLayout, copyLayout, encodeLayout, decodeLayout, groundBasis, wallBasis, move, rotate, History} from './layout.mjs?v=gesture-33';
import {createPlacement} from './placement.mjs?v=gesture-33';
import {updatePlacementPanel, bindPlacementPanel} from './placement-ui.mjs?v=gesture-33';
import {PlacementSession} from './placement-session.mjs?v=gesture-33';
import {createCollision} from './collision.mjs?v=gesture-33';
import {createWallVisibility, nearestWall, worldVertices} from './wall-visibility.mjs?v=gesture-33';
import {roomConfig, flattenObjects, topMembers} from './room-catalog.mjs?v=gesture-33';

import {mountJoysticks} from './joystick-ui.mjs?v=gesture-33';
import {analogDelta} from './placement-motion.mjs?v=gesture-33';

import {predictDrop, fallFraction} from './drop-placement.mjs?v=gesture-33';
import {connectGestureBridge, GestureInput, observationPose} from './gesture-bridge.mjs?v=gesture-33';
import {readCatalog, readAsset, modelURL as viewforgeModel, objectLabel, metricScale, savedMeasurement, placementMatrix, sizeInMeters} from './viewforge-import.mjs?v=gesture-33';

const $ = (selector) => document.querySelector(selector);
const host = $('#viewport');
// The room directory: beside a published preview (<room>/preview/editor/) by default, or
// ?scene=<relative path> when run from the repository, e.g. ?scene=../../samples/room3.
const sceneParam = new URLSearchParams(location.search).get('scene');
const sceneDir = sceneParam && !/^[a-z]+:|^\/\//i.test(sceneParam) ? sceneParam.replace(/\/+$/, '') : '../..';
const modelURL = `${sceneDir}/Room.glb`;
// What can be moved, and how, comes from the room's room_objects.json (web/scripts/room_objects.py).
const objectsURL = `${sceneDir}/room_objects.json`;
let config;
// ids: everything editable; roomIds: the room's own furniture. Objects imported from ViewForge
// are added to ids only, so saved and exported layouts still fit the room on its own.
const ids = [], roomIds = [];
const roomPart = (value) => Object.fromEntries(roomIds.map((id) => [id, value[id]]));
const addedPart = (value) => Object.fromEntries(ids.filter((id) => !roomIds.includes(id)).map((id) => [id, value[id]]));
const stored = () => ({x: 0, y: 0, z: 0, yaw: 0, visible: false});
const history = new History();
let layout = {};
const placementSpecs = {};
let dropPlan = null, falling = null;
let pending = null, mode = 'edit', warm = false;
const ghostMaterials = [];

let sceneKey, storageKey, room, floorY, ceilingY, center, roomSize, placement, collision, wallVisibility;
let motionNotice = null;
let wallRelocation = null, wallGhost = null;
const wallGhostSources = new Set();
const wallMaterialRestore = [];
const editingWallMaterials = [];
let translucentEditingWall = null;
let placementStates = new Map();
let selected = null, hovered = null, pendingFrame = false, hold = null, pointerStart = null;
let toastTimer, lastHoverTime = 0, activeView = 'overview', ready = false;
const entities = new Map();
const ceilingObjects = [], materialRestore = [];
const raycaster = new THREE.Raycaster();
const scene = new THREE.Scene();
scene.background = new THREE.Color('#e9ede5');
const camera = new THREE.OrthographicCamera(-5, 5, 4, -4, .02, 3000);
camera.aspect = 1;
let cameraSpan = 7.8;
const selectionBox = new THREE.Box3();
const footprint = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
  color: 0x298970, transparent: true, opacity: .13, depthWrite: false, depthTest: false, side: THREE.DoubleSide,
}));
footprint.rotation.x = -Math.PI / 2;
footprint.renderOrder = 3;
footprint.visible = false;
scene.add(footprint);
const dropProjection = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({color:0x298970,transparent:true,opacity:.28,depthWrite:false,side:THREE.DoubleSide}));
dropProjection.visible = false; dropProjection.renderOrder = 4; scene.add(dropProjection);
const dropGuide = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({color:0x298970,dashSize:.04,gapSize:.025,transparent:true,opacity:.6}));
dropGuide.visible = false; scene.add(dropGuide);
const arrows = Array.from({length: 4}, () => {
  const arrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), .25, 0x2c8772, .09, .07);
  for (const part of [arrow.line, arrow.cone]) {part.material.depthTest = false; part.renderOrder = 6;}
  arrow.visible = false;
  scene.add(arrow);
  return arrow;
});

let renderer, controls, joysticks, joystickBefore, hasEdited = false;
let analogActive = false, validationFrame = 0, validationTimer = 0;
function cancelValidation() {
  cancelAnimationFrame(validationFrame); clearTimeout(validationTimer);
  validationFrame = validationTimer = 0;
}
function validateAfterRender() {
  cancelValidation();
  const session = pending, candidate = layout;
  // Present the latest pose before doing the exact release-time checks.
  requestRender();
  validationFrame = requestAnimationFrame(() => {
    validationFrame = 0;
    validationTimer = setTimeout(() => {
      validationTimer = 0;
      if (pending === session && layout === candidate && !analogActive && !falling) applyLayout();
    }, 0);
  });
}
function fail(error) {
  console.error(error);
  $('#loading').hidden = true;
  $('#status').classList.remove('rc-sr-only');
  $('#status').textContent = `加载失败：${error.message || error}。请刷新重试。`;
  window.roomEditorError = String(error);
}

function showToast(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {$('#toast').hidden = true;}, 2700);
}

function requestRender() {
  if (pendingFrame || document.hidden) return;
  pendingFrame = true;
  requestAnimationFrame(() => {
    pendingFrame = false;
    if (!renderer) return;
    if (wallVisibility) {
      const editingWall = selected && placement.isWall(selected) ? placementStates.get(selected)?.wall : null;
      const result = wallVisibility.update(camera.position.clone().sub(controls.target).toArray(), {enabled: $('#cut').checked, reveal: !!wallRelocation, revealWalls: editingWall ? [editingWall] : []});
      host.dataset.hiddenWalls = result.hidden.join(',');
      setEditingWall(result.revealed[0] || null);
      if (result.changed) renderer.shadowMap.needsUpdate = true;
      const hidden = new Set(result.hidden);
      for (const [id, entity] of entities) {
        const visible = layout[id].visible !== false && !wallGhostSources.has(id) && !(placement.isWall(id) && hidden.has(placementStates.get(id)?.wall));
        if (entity.group.visible !== visible) {entity.group.visible = visible; renderer.shadowMap.needsUpdate = true;}
      }
    }
    updateSelectionVisuals();
    renderer.render(scene, camera);
  });
}

function basis() {
  camera.updateMatrixWorld();
  return groundBasis(new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0));
}

function updateDropProjection() {
  dropProjection.visible = dropGuide.visible = false;
  $('#drop-label').hidden = true;
  if (!pending?.gravity || !selected || !dropPlan || falling) return;
  const height = Number.isFinite(dropPlan.height) ? dropPlan.height : floorY;
  const hull = placement.projectedBase(selected, layout);
  if (hull.length < 3) return;
  const points = hull.map(p => new THREE.Vector2(...p));
  const faces = THREE.ShapeUtils.triangulateShape(points, []);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(hull.flatMap(([x,z]) => [x,height+.014,z]), 3));
  geometry.setIndex(faces.flat());
  dropProjection.geometry.dispose(); dropProjection.geometry = geometry;
  const color = dropPlan.checked === false ? 0xb39a62 : dropPlan.ok ? 0x298970 : 0xc86c51;
  dropProjection.material.color.setHex(color); dropGuide.material.color.setHex(color);
  dropProjection.visible = true;
  const x = hull.reduce((sum,p) => sum+p[0],0)/hull.length;
  const z = hull.reduce((sum,p) => sum+p[1],0)/hull.length;
  const bounds = new THREE.Box3().setFromObject(entities.get(selected).group);
  dropGuide.geometry.dispose();
  dropGuide.geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x,height+.014,z),new THREE.Vector3(x,bounds.min.y,z)]);
  dropGuide.computeLineDistances(); dropGuide.visible = bounds.min.y > height+.035;
  const projected = new THREE.Vector3(x,height+.014,z).project(camera);
  const label = $('#drop-label');
  label.textContent = `${dropPlan.checked === false ? '预计落点' : dropPlan.ok ? '落点' : '无法放置'}：${dropPlan.label || '无可用支撑'}`;
  label.dataset.valid = String(dropPlan.ok);
  label.style.left = `${(projected.x*.5+.5)*host.clientWidth}px`;
  label.style.top = `${(-projected.y*.5+.5)*host.clientHeight+16}px`;
  label.hidden = projected.z < -1 || projected.z > 1;
}

function stopFall() {
  if (!falling) return;
  cancelAnimationFrame(falling.frame); falling = null;
}

function startFall(landing) {
  const source = copyLayout(layout), session = pending;
  falling = {frame:0};
  restoreGhostMaterials();
  pending.message = `正在落到${landing.label || '支撑面'}…`;
  dropProjection.visible = dropGuide.visible = false; $('#drop-label').hidden = true;
  updateInspector();
  let start = null;
  const tick = time => {
    if (!falling || pending !== session) return;
    start ??= time;
    const fraction = fallFraction((time-start)/1000, landing.distance);
    for (const id of landing.moved) {
      const entity = entities.get(id);
      entity.group.position.y = entity.origin.y + source[id].y + (landing.candidate[id].y-source[id].y)*fraction;
    }
    room.updateMatrixWorld(true); requestRender();
    renderer.shadowMap.needsUpdate = true;
    if (fraction < 1) falling.frame = requestAnimationFrame(tick);
    else {
      falling = null; layout = copyLayout(landing.candidate);
      pending.update(layout, true, landing.message); completePlacement();
    }
  };
  falling.frame = requestAnimationFrame(tick);
}

function updateSelectionVisuals() {
  if (!selected) return;
  const entity = entities.get(selected);
  entity.group.updateMatrixWorld(true);
  selectionBox.setFromObject(wallGhost || entity.group);
  const size = selectionBox.getSize(new THREE.Vector3());
  const midpoint = selectionBox.getCenter(new THREE.Vector3());
  const state = placementStates.get(selected);
  if (pending?.gravity) {
    footprint.visible = false; arrows.forEach(arrow => {arrow.visible = false;});
    // Reproject the label as the camera or the falling object moves.
    if (!falling && dropPlan) {
      const hull = placement.projectedBase(selected, layout);
      if (hull.length) {
        const p = new THREE.Vector3(hull.reduce((sum,v)=>sum+v[0],0)/hull.length, dropPlan.height ?? floorY, hull.reduce((sum,v)=>sum+v[1],0)/hull.length).project(camera);
        $('#drop-label').style.left = `${(p.x*.5+.5)*host.clientWidth}px`;
        $('#drop-label').style.top = `${(-p.y*.5+.5)*host.clientHeight+16}px`;
      }
    }
  }
  const color = pending && !pending.valid ? 0xc86c51 : state?.state === 'stable' ? 0x2c8772 : state?.state === 'blocked' ? 0xb9513e : 0xc58d36;
  footprint.material.color.setHex(color);
  // Floating objects keep a ground projection; confirmed support uses its actual height.
  const supportY = Number.isFinite(state?.height) ? state.height : floorY;
  footprint.rotation.set(-Math.PI / 2, 0, 0);
  footprint.position.set(midpoint.x, supportY + .015, midpoint.z);
  footprint.scale.set(size.x + .08, size.z + .08, 1);
  const axes = basis();
  const directions = [axes.forward, axes.right, {x: -axes.forward.x, z: -axes.forward.z}, {x: -axes.right.x, z: -axes.right.z}];
  directions.forEach((axis, i) => {
    const direction = new THREE.Vector3(axis.x, 0, axis.z);
    const distance = Math.min(
      Math.abs(axis.x) > 1e-6 ? (size.x / 2 + .1) / Math.abs(axis.x) : Infinity,
      Math.abs(axis.z) > 1e-6 ? (size.z / 2 + .1) / Math.abs(axis.z) : Infinity,
    );
    arrows[i].position.set(midpoint.x, supportY + .024, midpoint.z).addScaledVector(direction, distance);
    arrows[i].setDirection(direction);
    arrows[i].setColor(color);
  });
  const mount = placement?.wallFrame(selected, wallRelocation?.candidate || layout);
  if (mount) {
    const anchor = new THREE.Vector3().fromArray(mount.center);
    const tangent = new THREE.Vector3().fromArray(mount.tangent);
    if (tangent.x * axes.right.x + tangent.z * axes.right.z < 0) tangent.negate();
    footprint.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3().fromArray(mount.n));
    footprint.position.copy(anchor);
    footprint.scale.set(mount.width + .04, mount.height + .04, 1);
    [new THREE.Vector3(0, 1, 0), tangent, new THREE.Vector3(0, -1, 0), tangent.clone().negate()].forEach((axis, i) => {
      arrows[i].position.copy(anchor).addScaledVector(axis, (i % 2 ? mount.width : mount.height) / 2 + .07);
      arrows[i].setDirection(axis);
    });
  }
  const projected = new THREE.Vector3(midpoint.x, selectionBox.max.y + .1, midpoint.z).project(camera);
  const label = $('#selection-label');
  const x = (projected.x * .5 + .5) * host.clientWidth;
  const y = (-projected.y * .5 + .5) * host.clientHeight;
  label.hidden = projected.z < -1 || projected.z > 1 || x < 0 || x > host.clientWidth || y < 0 || y > host.clientHeight;
  label.style.left = `${Math.max(80, Math.min(host.clientWidth - 80, x))}px`;
  label.style.top = `${Math.max(72, y)}px`;
}

function applyLayout() {
  for (const [id, entity] of entities) {
    const value = layout[id];
    entity.group.position.set(entity.origin.x + value.x, entity.origin.y + (value.y || 0), entity.origin.z + value.z);
    entity.group.rotation.y = value.yaw;
    entity.group.visible = value.visible !== false;
  }
  room.updateMatrixWorld(true);
  if (placement) placementStates = new Map(ids.filter(id => layout[id].visible !== false).map((id) => [id, placement.assess(id, layout)]));
  if (pending) refreshSession();
  updateDropProjection();
  for (const row of $('#object-list').children) {
    const id = row.dataset.object;
    row.dataset.stored = String(layout[id].visible === false);
    row.querySelector('.warehouse-state').textContent = layout[id].visible === false ? '待放置' : '在房间';
    row.querySelector('small').textContent = entities.get(id).sizeLabel;
    row.title = `${entities.get(id).name} · ${entities.get(id).sizeLabel}`;
  }
  $('#object-count').textContent = `房间内 ${ids.filter(id => layout[id].visible !== false).length} 件 · 共 ${ids.length} 件`; 
  updateInspector();
  if (!analogActive) renderer.shadowMap.needsUpdate = true;
  requestRender();
}

function updateInspector() {
  $('#undo').disabled = !history.past.length;
  $('#selected-count').textContent = selected ? '1' : '0';
  $('#selection-fieldset').disabled = !selected || !!falling;
  $('#empty-selection').hidden = !!selected;
  $('#selection-controls').hidden = !selected;
  $('.rc-controls').hidden = !selected;
  $('#focus').disabled = !selected;
  updateSessionUI();
  const support = placementStates.get(selected)?.support;
  joysticks?.setState({enabled: !!selected && mode === 'edit' && !falling, wall: selected && placement?.isWall(selected), support: entities.get(support)?.name || '地面', landing:dropPlan ? dropPlan.label || (dropPlan.ok ? '地面' : '无可用落点') : ''});
  if (!selected) {
    $('#selected-name').textContent = '挑一件家具，试着摆放';
    $('#selected-category').textContent = '从房间或下方家具栏选择';
    return;
  }
  const entity = entities.get(selected);
  const value = (wallRelocation?.candidate || layout)[selected];
  $('#selected-name').textContent = entity.name;
  $('#selected-category').textContent = `${entity.category} · ${entity.sizeLabel || '模型尺度'}`;
  $('#selection-label').textContent = entity.name;
  const display = (number) => Math.abs(number) < .0005 ? '0.000' : `${number > 0 ? '+' : ''}${number.toFixed(3)}`;
  $('#offset-x').textContent = display(value.x);
  $('#offset-y').textContent = display(value.y || 0);
  $('#offset-z').textContent = display(value.z);
  $('#rotation').textContent = `${Math.round(value.yaw * 180 / Math.PI)}°`;
  const wall = placement?.isWall(selected);
  $('.advanced-controls summary').textContent = wall ? '前后换墙与位置详情' : '高度与位置详情';
  const changingWall = !!wallRelocation;
  $('#rotate-left').disabled = $('#rotate-right').disabled = !!wall;
  $('#rotate-left').title = $('#rotate-right').title = wall ? '壁挂物件保持安装朝向' : '旋转 15°';
  $('#direction-note').textContent = wall ? '上下左右沿墙移动 · 前后按当前视角换墙' : '按当前视角移动 · 可调整高度';
  $('.control-shortcut').textContent = wall ? '↑ ↓ ← → · W / S 换墙' : '↑ ↓ ← →';
  $('.direction-pad').setAttribute('aria-label', wall ? '沿墙上下左右移动选中物体' : '沿地面移动选中物体');
  $('.height-buttons').setAttribute('aria-label', wall ? '按当前视角前后换墙' : '调整选中物体的高度');
  $('.height-heading span').textContent = wall ? '前后换墙 · 保持高度' : '高度偏移';
  const controls = [
    ['.move-forward', wall ? 'up' : 'forward', wall ? '上' : '前'],
    ['.move-back', wall ? 'down' : 'back', wall ? '下' : '后'],
    ['#depth-forward', wall ? 'forward' : 'up', wall ? '前 · 换墙' : '上升'],
    ['#depth-back', wall ? 'back' : 'down', wall ? '后 · 换墙' : '下降'],
  ];
  const names = {up: '向上移动', down: '向下移动', forward: wall ? '向前换墙' : '向前移动', back: wall ? '向后换墙' : '向后移动'};
  for (const [selector, direction, label] of controls) {
    const button = $(selector); button.dataset.move = direction; button.querySelector('span').textContent = label;
    button.setAttribute('aria-label', names[direction]);
    button.title = wall && ['forward', 'back'].includes(direction) ? '沿当前视角寻找另一面墙；每次按下换墙一次' : names[direction];
  }
  const state = placementStates.get(selected);
  $('#wall-section').hidden = !wall || !changingWall;
  $('#wall-current').textContent = wallRelocation?.candidate ? `${wallLabel(wallRelocation.target)} · 预览` : state?.wall ? wallLabel(state.wall) : '等待贴合墙面';
  $('#change-wall').textContent = changingWall ? '取消换墙' : '点选换墙';
  $('#change-wall').setAttribute('aria-expanded', String(changingWall));
  $('#wall-picker-controls').hidden = !changingWall;
  for (const selector of ['.move-section', '.placement-section', '.transform-section']) $(selector).hidden = changingWall;
  $('.rotate-section').hidden = !!wall || changingWall;
  if (changingWall) {
    $('#wall-preview-status').textContent = wallRelocation.message;
    $('#wall-preview-status').dataset.state = wallRelocation.valid ? 'ready' : wallRelocation.target ? 'blocked' : 'waiting';
    $('#apply-wall').disabled = !wallRelocation.candidate;
  }
  $('#placement-state').textContent = state?.label || '检查放置面';
  $('#placement-state').dataset.state = state?.state || 'draft';
  $('#placement-detail').textContent = motionNotice?.id === selected ? motionNotice.message : state?.detail || '';
  $('#settle-object span').textContent = wall ? '贴合墙面' : '落到支撑面';
}

function wallLabel(name) {return /^Wall\d+$/.test(name) ? `墙面 ${Number(name.slice(4)) + 1}` : '墙面';}

function setEditingWall(name) {
  if (name === translucentEditingWall) return;
  for (const [mesh, original] of editingWallMaterials) {
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) material.dispose();
    mesh.material = original;
  }
  editingWallMaterials.length = 0;
  translucentEditingWall = name;
  if (name) room.getObjectByName(name)?.traverse(mesh => {
    if (!mesh.isMesh) return;
    const original = mesh.material;
    const tint = material => {const clone = material.clone(); clone.transparent = true; clone.opacity = .18; clone.depthWrite = false; clone.side = THREE.DoubleSide; return clone;};
    mesh.material = Array.isArray(original) ? original.map(tint) : tint(original);
    editingWallMaterials.push([mesh, original]);
  });
  renderer.shadowMap.needsUpdate = true;
}

function clearWallGhost() {
  for (const id of wallGhostSources) entities.get(id).group.visible = layout[id].visible !== false;
  wallGhostSources.clear();
  if (!wallGhost) return;
  wallGhost.traverse((object) => {
    if (object.material) for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.dispose();
  });
  scene.remove(wallGhost); wallGhost = null;
}

function endWallRelocation() {
  if (!wallRelocation) return;
  clearWallGhost();
  for (const [mesh, original] of wallMaterialRestore) {
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) material.dispose();
    mesh.material = original;
  }
  wallMaterialRestore.length = 0;
  wallRelocation = null;
  $('#cut').disabled = false;
  host.style.cursor = '';
  requestRender();
}

function beginWallRelocation() {
  finishHold();
  if (!selected || !placement.isWall(selected)) return;
  if (wallRelocation) return;
  setEditingWall(null);
  if (pending) pending.locked = false;
  wallRelocation = {id: selected, candidate: null, valid: false, target: null, message: '请选择目标墙面。拖动场景可调整视角。'};
  motionNotice = null; hovered = null;
  $('#wall-target').value = '';
  // Reveal complete walls while choosing; restore the user's original cutaway on exit.
  for (const root of room.children.filter((object) => /^Wall\d+$/.test(object.userData.name || object.name))) root.traverse((mesh) => {
    if (!mesh.isMesh) return;
    const original = mesh.material;
    const translucent = (material) => {const clone = material.clone(); clone.transparent = true; clone.opacity = .18; clone.depthWrite = false; clone.clippingPlanes = []; clone.side = THREE.DoubleSide; return clone;};
    mesh.material = Array.isArray(original) ? original.map(translucent) : translucent(original);
    wallMaterialRestore.push([mesh, original]);
  });
  $('#cut').disabled = true;
  $('#status').textContent = '换墙模式 · 点选墙面位置，预览后确认 · Esc 取消';
  updateInspector(); requestRender();
}

function showWallGhost(candidate, moved, valid) {
  clearWallGhost();
  wallGhost = new THREE.Group();
  const color = valid ? 0x35a67d : 0xc86c51;
  for (const id of moved) {
    const entity = entities.get(id), ghost = entity.group.clone(true), value = candidate[id];
    ghost.visible = true;
    ghost.position.set(entity.origin.x + value.x, entity.origin.y + value.y, entity.origin.z + value.z);
    ghost.rotation.y = value.yaw;
    ghost.traverse((mesh) => {
      if (!mesh.isMesh) return;
      const material = new THREE.MeshBasicMaterial({color, transparent: true, opacity: .4, depthWrite: false, side: THREE.DoubleSide});
      mesh.material = material;
    });
    wallGhost.add(ghost);
    wallGhostSources.add(id); entity.group.visible = false;
  }
  scene.add(wallGhost); wallGhost.updateMatrixWorld(true);
}

function previewWall(name, point) {
  if (!wallRelocation) return;
  clearWallGhost();
  const {candidate, result, carried, valid, message} = wallCandidate(name, point);
  wallRelocation = {...wallRelocation, candidate: result.ok ? candidate : null, moved: carried.moved, target: name, valid, message};
  $('#wall-target').value = name;
  if (result.ok) showWallGhost(candidate, carried.moved || [selected], valid);
  updateInspector(); requestRender();
}

function lockWallPreview() {
  if (!pending || !wallRelocation?.candidate) {
    showToast('请先在能容纳物体的墙面上选择位置');
    return false;
  }
  // Lock only the draft. An obstructed mount can still be nudged clear, but
  // refreshSession must recheck its complete geometry before confirmation.
  layout = copyLayout(wallRelocation.candidate);
  endWallRelocation();
  pending.locked = true;
  motionNotice = null;
  applyLayout();
  $('#status').textContent = '墙面预览已锁定 · 方向键微调高度和位置 · Enter 确认';
  return true;
}

function wallCandidate(name, point) {
  const candidate = copyLayout(layout);
  const result = placement.mount(selected, candidate, name, point);
  const carried = result.ok ? placement.carry(selected, layout, candidate) : result;
  const contact = carried.ok ? collision.checkPlacement(candidate, carried.moved) : {ok: false};
  const valid = !!carried.ok && contact.ok;
  const message = !carried.ok ? carried.message : !contact.ok ? `这里会碰到${contact.other?.name || '其他物体'}，请在墙上另选一个位置。` : `${wallLabel(name)} · 可以放置。确认后可用方向按钮微调。`;
  return {candidate, result, carried, valid, message};
}

function changeWallInDirection(direction) {
  const forward = basis().forward, sign = direction === 'back' ? -1 : 1;
  const target = placement.directionTarget(selected, layout, {x: forward.x * sign, z: forward.z * sign});
  if (!target) {
    motionNotice = {id: selected, message: '这个方向没有另一面墙，请转动视角后再试'};
    showToast(motionNotice.message); updateInspector(); return;
  }
  const result = wallCandidate(target.name, target.point);
  if (!result.valid) {
    motionNotice = {id: selected, message: `${wallLabel(target.name)}：${result.message}`};
    showToast(motionNotice.message); updateInspector(); return;
  }
  layout = result.candidate;
  $('#status').textContent = `已安装到${wallLabel(target.name)} · 上下左右沿新墙移动`;
  showToast(pending ? `已预览${wallLabel(target.name)}，确认后保存` : `已换到${wallLabel(target.name)}，可撤销`);
}

function pickWall(clientX, clientY) {
  const rect = host.getBoundingClientRect();
  camera.updateMatrixWorld();
  raycaster.setFromCamera(new THREE.Vector2((clientX - rect.left) / rect.width * 2 - 1, -(clientY - rect.top) / rect.height * 2 + 1), camera);
  let nearest = null;
  for (const target of placement.wallTargets()) {
    // The near outside wall is transparent in this mode. Select the interior face
    // the user sees across the room, rather than intercepting it with that near wall.
    if (raycaster.ray.direction.dot(new THREE.Vector3().fromArray(target.n)) >= -.00001) continue;
    for (const triangle of target.triangles) {
      const point = raycaster.ray.intersectTriangle(...triangle.map((p) => new THREE.Vector3().fromArray(p)), false, new THREE.Vector3());
      if (!point) continue;
      const distance = point.distanceTo(raycaster.ray.origin);
      if (!nearest || distance < nearest.distance) nearest = {name: target.name, point: point.toArray(), distance};
    }
  }
  return nearest;
}

function restoreMaterials() {
  for (const [mesh, original] of materialRestore) {
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) material.dispose();
    mesh.material = original;
  }
  materialRestore.length = 0;
}

function select(id, announce = true) {
  finishHold();
  endWallRelocation();
  if (id !== null && !entities.has(id)) return;
  restoreMaterials();
  selected = id;
  motionNotice = null;
  hovered = null;
  host.style.cursor = '';
  footprint.visible = !!id;
  dropProjection.visible = dropGuide.visible = false; $('#drop-label').hidden = true;
  arrows.forEach((arrow) => {arrow.visible = !!id;});
  $('#selection-label').hidden = !id;
  for (const row of $('#object-list').querySelectorAll('button')) {
    const active = row.dataset.object === id;
    row.classList.toggle('active', active);
    row.setAttribute('aria-pressed', String(active));
  }
  if (id) {
    entities.get(id).group.traverse((mesh) => {
      if (!mesh.isMesh) return;
      const original = mesh.material;
      const tint = (material) => {
        const clone = material.clone();
        if (clone.emissive) {clone.emissive.set(0x146852); clone.emissiveIntensity = .14;}
        return clone;
      };
      materialRestore.push([mesh, original]);
      mesh.material = Array.isArray(original) ? original.map(tint) : tint(original);
    });
    $('#selection-label').classList.remove('just-selected');
    requestAnimationFrame(() => $('#selection-label').classList.add('just-selected'));
    if (announce) $('#status').textContent = `已选中${entities.get(id).name}，可以用方向按钮移动`;
  } else if (announce) $('#status').textContent = '点选物体，开始布置房间';
  updateInspector();
  requestRender();
}

function persist() {
  if (!ready || !hasEdited) return;
  try {
    localStorage.setItem(storageKey, JSON.stringify(encodeLayout(roomPart(pending ? pending.committed() : layout), sceneKey)));
    $('#resume-layout').disabled = false;
    const drafts = [...placementStates.values()].filter((state) => state.state !== 'stable').length;
    $('#save-state').textContent = drafts ? `已保存草稿 · ${drafts} 件待落位` : '已保存到此浏览器';
  } catch {
    $('#save-state').textContent = '未能自动保存，请导出布局';
  }
}

function commit(before) {
  if (pending) {refreshSession(); updateSessionUI(); return;}
  if (history.commit(before, layout)) {hasEdited = true; persist();}
  updateInspector();
}

function act(callback) {
  if (!ready || falling) return;
  joysticks?.stop();
  finishHold();
  endWallRelocation();
  motionNotice = null;
  const before = copyLayout(layout);
  callback();
  applyLayout();
  commit(before);
}

function nudge(direction) {
  if (!selected || wallRelocation) return;
  if (pending) {pending.locked = true; if (motionNotice?.previewInvalid) layout = copyLayout(pending.lastReachable);}
  const frame = placement.isWall(selected) ? placement.wallFrame(selected, layout) : null;
  if (placement.isWall(selected) && ['forward', 'back'].includes(direction)) {changeWallInDirection(direction); return;}
  const axes = frame ? wallBasis(frame.tangent, basis()) : basis();
  if (!editObject((next) => move(next, selected, direction, Number($('#step').value), axes), direction)) finishHold();
}

function editObject(change, direction) {
  if (!selected || falling) return false;
  if (pending) {pending.locked = true; if (motionNotice?.previewInvalid) layout = copyLayout(pending.lastReachable);}
  motionNotice = null;
  const before = copyLayout(layout), next = copyLayout(layout);
  change(next);
  const result = direction === 'reset' ? {ok: true} : direction === 'settle' ? placement.settle(selected, next) : placement.constrain(selected, before, next, pending?.gravity ? 'up' : direction);
  const carried = result.ok ? placement.carry(selected, before, next) : result;
  if (!carried.ok) {
    motionNotice = {id: selected, message: carried.message};
    if (pending) {pending.valid = false; pending.message = carried.message; updateSessionUI();}
    showToast(carried.message);
    updateInspector();
    return false;
  }
  // Restoring a wall fixture is another installation, including a change of wall.
  // Sweeping between its two mounts could leave it stopped at an unsupported yaw.
  const restoringMount = direction === 'reset' && placement.isWall(selected);
  // A not-yet-installed draft has no physical sweep from its stored/invalid pose.
  // Keep a blocked draft adjustable and validate the destination until it clears.
  const installing = pending && (pending.before[selected].visible === false || pending.gravity || pending.surfaceChoice || (placement.isWall(selected) && !pending.valid));
  const destination = pending && analogActive ? null : restoringMount || installing ? collision.checkPlacement(next, carried.moved || [selected]) : null;
  const contact = pending && analogActive ? {layout:next, blocked:false} : destination ? {...destination, layout: destination.ok || installing ? next : before} : collision.limit(before, next, carried.moved || [selected]);
  layout = contact.layout;
  if (contact.blocked) {
    const name = typeof contact.other === 'string' ? (entities.get(contact.other)?.name || contact.other) : contact.other?.name || '其他物体';
    motionNotice = {id: selected, contactInvalid: !!installing, message: installing ? `这里会碰到${name}，请继续调整位置或高度` : restoringMount ? `原安装位置会碰到${name}，已保留当前位置` : `碰到${name}，已停止；请调整方向或高度`, other: contact.other, fraction: contact.fraction};
    showToast(motionNotice.message);
  }
  applyLayout();
  return !contact.blocked;
}

function startHold(direction, owner) {
  if (!ready || !selected || hold || wallRelocation) return;
  // Depth commands reinstall once. Holding one must not bounce across the room.
  if (placement.isWall(selected) && ['forward', 'back'].includes(direction)) {act(() => nudge(direction)); return;}
  hold = {owner, before: copyLayout(layout), timer: null, interval: null};
  nudge(direction);
  if (!hold) return;
  hold.timer = setTimeout(() => {
    if (hold) hold.interval = setInterval(() => nudge(direction), 100);
  }, 360);
}

function finishHold() {
  if (!hold) return;
  const previous = hold;
  hold = null;
  clearTimeout(previous.timer);
  clearInterval(previous.interval);
  commit(previous.before);
}

function alignCameraToStage() {
  const width = host.clientWidth, height = host.clientHeight;
  if (!width || !height) return;
  // Match the sample's composition: leave space for the floating controls.
  camera.left = -cameraSpan * camera.aspect / 2; camera.right = cameraSpan * camera.aspect / 2;
  camera.top = cameraSpan / 2; camera.bottom = -cameraSpan / 2;
  camera.setViewOffset(width, height, width < 520 || mode === 'preview' ? 0 : Math.round(width * .065), width < 520 ? Math.round(height * .16) : 0, width, height);
}

function view(mode) {
  if (!ready) return;
  finishHold();
  activeView = mode;
  const span = Math.max(roomSize.x, roomSize.z);
  camera.up.set(0, 1, 0);
  camera.zoom = 1;
  cameraSpan = span * (host.clientWidth <= 740 ? 1.18 : 1.08) / Math.min(camera.aspect, 1);
  const distance = Math.max(12, roomSize.length() * 2);
  const target = new THREE.Vector3(center.x, floorY + .65, center.z);
  if (mode === 'top') {
    target.y = floorY;
    camera.position.copy(target).add(new THREE.Vector3(0, distance, .001));
  } else if (mode === 'focus' && selected) {
    const bounds = new THREE.Box3().setFromObject(entities.get(selected).group);
    bounds.getCenter(target);
    const size = bounds.getSize(new THREE.Vector3());
    cameraSpan = Math.max(1.5, size.length() * 1.3) / Math.min(camera.aspect, 1);
    camera.position.copy(target).add(new THREE.Vector3(1, .9, 1).normalize().multiplyScalar(distance));
  } else {
    camera.position.copy(target).add(new THREE.Vector3(Math.sin(.78)*Math.sin(.62), Math.cos(.78), Math.sin(.78)*Math.cos(.62)).multiplyScalar(distance));
  }
  controls.target.copy(target);
  controls.update();
  alignCameraToStage();
  camera.updateMatrixWorld();
  for (const id of ['overview', 'top', 'focus']) {
    $(`#${id}`).classList.toggle('active', id === mode);
    $(`#${id}`).setAttribute('aria-pressed', String(id === mode));
  }
  requestRender();
}

function pick(clientX, clientY) {
  if (!ready) return null;
  camera.updateMatrixWorld();
  const rect = host.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2((clientX - rect.left) / rect.width * 2 - 1, -(clientY - rect.top) / rect.height * 2 + 1), camera);
  for (const hit of raycaster.intersectObject(room, true)) {
    let visible = true;
    for (let object = hit.object; object; object = object.parent) {if (!object.visible) visible = false;}
    if (!visible) continue;
    const material = Array.isArray(hit.object.material) ? hit.object.material[hit.face.materialIndex] : hit.object.material;
    if (material.clippingPlanes?.some((plane) => plane.distanceToPoint(hit.point) < 0)) continue;
    return hit.object.userData.editorId || null;
  }
  return null;
}

function bindEvents() {
  const toolsMenu = $('#tools-menu');
  document.addEventListener('click', event => {if (!toolsMenu.contains(event.target)) toolsMenu.open = false;});
  toolsMenu.addEventListener('keydown', event => {if (event.key === 'Escape') {toolsMenu.open = false; event.stopPropagation();}});
  $('#change-wall').onclick = () => {
    if (wallRelocation) {endWallRelocation(); if (pending) pending.locked = true; updateInspector(); $('#status').textContent = '已取消换墙，原位置保持不变';}
    else beginWallRelocation();
  };
  $('#wall-target').onchange = () => {
    const target = placement.wallTargets().find((wall) => wall.name === $('#wall-target').value);
    if (!wallRelocation) return;
    if (!target) {
      clearWallGhost();
      wallRelocation = {...wallRelocation, candidate: null, valid: false, target: null, message: '请选择目标墙面。拖动场景可调整视角。'};
      updateInspector(); requestRender(); return;
    }
    const point = target.center.slice();
    point[1] = placement.wallFrame(selected, layout)?.center[1] ?? point[1];
    previewWall(target.name, point);
  };
  $('#apply-wall').onclick = lockWallPreview;
  for (const button of document.querySelectorAll('[data-move]')) {
    button.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !selected) return;
      event.preventDefault();
      button.focus({preventScroll: true});
      button.setPointerCapture(event.pointerId);
      startHold(button.dataset.move, event.pointerId);
    });
    button.addEventListener('click', (event) => {
      // detail=0 covers keyboard / assistive activation. Pointer actions already ran.
      if (event.detail === 0) act(() => nudge(button.dataset.move));
    });
    button.addEventListener('lostpointercapture', finishHold);
  }
  window.addEventListener('pointerup', finishHold);
  window.addEventListener('pointercancel', finishHold);
  window.addEventListener('blur', () => {finishHold(); pointerStart = null;});
  document.addEventListener('visibilitychange', () => {if (document.hidden) finishHold(); else requestRender();});
  $('#step').addEventListener('change', finishHold);
  $('#rotate-left').onclick = () => act(() => editObject((next) => rotate(next, selected, Math.PI / 12), 'rotate'));
  $('#rotate-right').onclick = () => act(() => editObject((next) => rotate(next, selected, -Math.PI / 12), 'rotate'));
  $('#settle-object').onclick = () => act(() => {if (editObject(() => {}, 'settle')) showToast(placementStates.get(selected).label);});
  $('#reset-object').onclick = () => act(() => editObject((next) => {next[selected] = {x: 0, y: 0, z: 0, yaw: 0};}, 'reset'));
  $('#reset-layout').onclick = () => {joysticks?.stop(); cancelSession(false); hasEdited = true; act(() => {layout = {...initialLayout(roomIds), ...Object.fromEntries(Object.keys(addedPart(layout)).map((id) => [id, stored()]))};}); persist(); showToast('已恢复原始布置，可撤销');};
  $('#resume-layout').onclick = () => {
    try {
      const saved = decodeLayout(JSON.parse(localStorage.getItem(storageKey)), sceneKey, roomIds);
      joysticks?.stop(); cancelSession(false); act(() => {layout = {...saved, ...addedPart(layout)};}); showToast('已继续上次确认的布置');
    } catch (error) {showToast(error.message || '没有可恢复的布局');}
  };
  const undo = () => {
    joysticks?.stop();
    finishHold();
    endWallRelocation();
    motionNotice = null;
    cancelSession(false);
    const previous = history.undo(layout);
    if (previous) {layout = previous; hasEdited = true; applyLayout(); persist(); showToast('已撤销');}
    else updateInspector();
  };
  const redo = () => {
    joysticks?.stop();
    finishHold();
    endWallRelocation();
    motionNotice = null;
    cancelSession(false);
    const next = history.redo(layout);
    if (next) {layout = next; hasEdited = true; applyLayout(); persist(); showToast('已重做');}
    else updateInspector();
  };
  $('#undo').onclick = undo;
  document.addEventListener('keydown', (event) => {
    if (ready && pending && event.key === 'Escape') {event.preventDefault(); cancelSession(); return;}
    if (ready && event.key === 'Escape' && wallRelocation) {
      event.preventDefault(); endWallRelocation(); updateInspector(); $('#status').textContent = '已取消换墙，原位置保持不变'; return;
    }
    if (!ready || event.target.closest('input,select,textarea,[contenteditable="true"]')) return;
    if (event.key === '/' && !event.metaKey && !event.ctrlKey) {event.preventDefault(); $('#object-panel').classList.add('open'); $('#list-toggle').setAttribute('aria-expanded', 'true'); $('#search').focus(); return;}
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault(); event.shiftKey ? redo() : undo(); return;
    }
    if (event.key === 'Escape') {
      $('#object-panel').classList.remove('open'); $('#list-toggle').setAttribute('aria-expanded', 'false'); select(null); return;
    }
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    if (pending && event.key === 'Enter') {event.preventDefault(); confirmSession(); return;}
    if (pending && event.key.toLowerCase() === 'r') {event.preventDefault(); $('#session-rotate-right').click(); return;}
    const wall = selected && placement.isWall(selected);
    const direction = {ArrowUp: wall ? 'up' : 'forward', ArrowDown: wall ? 'down' : 'back', ArrowLeft: 'left', ArrowRight: 'right', PageUp: 'up', PageDown: 'down',
      ...(wall ? {w: 'forward', W: 'forward', s: 'back', S: 'back'} : {})}[event.key];
    if (direction && selected) {event.preventDefault(); if (!event.repeat) startHold(direction, event.code);}
  });
  document.addEventListener('keyup', (event) => {if (hold?.owner === event.code) finishHold();});
  for (const id of ['overview', 'top', 'focus']) $(`#${id}`).onclick = () => view(id);
  $('#cut').onchange = requestRender;
  $('#ceiling').onchange = () => {ceilingObjects.forEach((object) => {object.visible = $('#ceiling').checked;}); renderer.shadowMap.needsUpdate = true; requestRender();};
  $('#search').oninput = () => {
    const term = $('#search').value.trim().toLowerCase();
    let count = 0;
    for (const row of $('#object-list').children) {
      row.hidden = !row.textContent.toLowerCase().includes(term);
      if (!row.hidden) count++;
    }
    $('#object-count').textContent = term ? `${count} / ${ids.length}` : `${ids.length}`;
  };
  $('#list-toggle').onclick = () => {
    const open = $('#object-panel').classList.toggle('open');
    $('#list-toggle').setAttribute('aria-expanded', String(open));
  };
  $('#close-list').onclick = () => {$('#object-panel').classList.remove('open'); $('#list-toggle').setAttribute('aria-expanded', 'false');};
  $('#export-layout').onclick = () => {
    if (!ready) return;
    finishHold();
    const blob = new Blob([JSON.stringify(encodeLayout(roomPart(pending ? pending.committed() : layout), sceneKey), null, 2)], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = `RoomCanvas-${config.sceneId}-layout.json`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('布局已导出，可在此房间中重新导入');
  };
  $('#import-layout').onclick = () => {if (ready) $('#layout-file').click();};
  $('#layout-file').onchange = async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      if (file.size > 1024 * 1024) throw new Error('布局文件过大');
      const next = decodeLayout(JSON.parse(await file.text()), sceneKey, roomIds);
      cancelSession(false);
      act(() => {layout = {...next, ...addedPart(layout)};});
      showToast('布局已导入，可撤销');
    } catch (error) {showToast(`导入失败：${error.message}`);}
    event.target.value = '';
  };
  renderer.domElement.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !event.isPrimary) {pointerStart = null; return;}
    pointerStart = {x: event.clientX, y: event.clientY, id: event.pointerId, dragged: false};
  });
  renderer.domElement.addEventListener('pointermove', (event) => {
    if (pointerStart && Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 5) pointerStart.dragged = true;
    if (event.buttons || event.pointerType !== 'mouse') return;
    if (pending && !pending.locked) {
      if (performance.now() - lastHoverTime < 60) return;
      lastHoverTime = performance.now(); followPointer(event.clientX, event.clientY); return;
    }
    if (performance.now() - lastHoverTime < 45) return;
    lastHoverTime = performance.now();
    if (wallRelocation) {host.style.cursor = pickWall(event.clientX, event.clientY) ? 'crosshair' : ''; return;}
    const id = pick(event.clientX, event.clientY);
    host.style.cursor = id ? 'pointer' : '';
    if (id === hovered) return;
    hovered = id;
    requestRender();
  });
  renderer.domElement.addEventListener('pointerup', (event) => {
    if (pointerStart?.id === event.pointerId && !pointerStart.dragged && event.button === 0) {
      if (pending && wallRelocation) {
        const target = pickWall(event.clientX, event.clientY);
        if (target) {previewWall(target.name, target.point); lockWallPreview();}
        else showToast('请点击墙面实体部分；拖动场景可以调整视角');
      } else if (pending && !pending.locked) {
        followPointer(event.clientX, event.clientY);
        pending.locked = true; updateInspector();
      } else if (wallRelocation) {
        const target = pickWall(event.clientX, event.clientY);
        if (target) previewWall(target.name, target.point); else showToast('请点击墙面实体部分；拖动场景可以调整视角');
      } else if (mode === 'edit') {const id = pick(event.clientX, event.clientY); if (id) beginSession(id); else if (!pending) select(null);}
    }
    pointerStart = null;
  });
  renderer.domElement.addEventListener('pointercancel', () => {pointerStart = null;});
  renderer.domElement.addEventListener('pointerleave', () => {hovered = null; requestRender();});
  window.addEventListener('pagehide', () => {joysticks?.stop(); finishHold(); persist();});
}

function groupScene(gltf, originalMatrices) {
  // Validate all required names first; never silently publish a partly editable scene.
  const assigned = new Set();
  for (const spec of config.catalog) for (const name of spec.roots) {
    if (assigned.has(name)) throw new Error(`物体重复归组 ${name}`);
    assigned.add(name);
  }
  const members = new Map(config.catalog.map((spec) => [spec.id, topMembers(room, spec.roots)]));
  for (const spec of config.catalog) {
    const bounds = new THREE.Box3();
    members.get(spec.id).forEach((object) => bounds.expandByObject(object));
    const origin = bounds.getCenter(new THREE.Vector3());
    origin.y = floorY;
    const group = new THREE.Group();
    group.name = `Editable_${spec.id}`;
    group.position.copy(origin);
    room.add(group);
    group.updateMatrixWorld(true);
    for (const object of members.get(spec.id)) group.attach(object);
    group.traverse((object) => {if (object.isMesh) object.userData.editorId = spec.id;});
    const dimensions = bounds.getSize(new THREE.Vector3());
    const sizeLabel = `${dimensions.x.toFixed(2)} × ${dimensions.z.toFixed(2)} × ${dimensions.y.toFixed(2)} ${config.units}`;
    entities.set(spec.id, {...spec, group, origin, sizeLabel});
  }
  room.updateMatrixWorld(true);
  let groupingError = 0;
  for (const [object, matrix] of originalMatrices) {
    matrix.elements.forEach((value, i) => {groupingError = Math.max(groupingError, Math.abs(value - object.matrixWorld.elements[i]));});
  }
  if (groupingError > 1e-6) throw new Error('物体归组改变了原始位置');
  sceneKey = `${config.sceneId}:v2:${gltf.parser.json.buffers.map((buffer) => buffer.byteLength).join('-')}:${gltf.parser.json.nodes.length}`;
  storageKey = `roomcanvas:layout:${sceneKey}`;
  for (const entity of entities.values()) appendWarehouseRow(entity);
  $('#object-count').textContent = `${entities.size}`;
  return {groupingError, groupedRoots: assigned.size, meshes: originalMatrices.size};
}

function appendWarehouseRow(entity, first = false) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'object-row'; row.dataset.object = entity.id;
    row.setAttribute('aria-pressed', 'false');
    row.setAttribute('aria-label', `${entity.name}，选择摆放`);
    row.innerHTML = `<span class="warehouse-state">在房间</span><img class="object-thumb" alt="" width="264" height="144"><span class="object-copy"><strong>${entity.name}</strong><small>${entity.category}</small></span><span class="object-dot" aria-hidden="true"></span>`;
    row.onclick = () => {
      beginSession(entity.id);
      $('#object-panel').classList.remove('open');
      $('#list-toggle').setAttribute('aria-expanded', 'false');
    };
    if (first) $('#object-list').prepend(row); else $('#object-list').appendChild(row);
}

function renderFurnitureThumbnails(list = entities.values()) {
  // Render the actual grouped model, sharing its geometry/materials without mutating them.
  // One temporary context serves the entire shelf and is released after rendering.
  const previewRenderer = new THREE.WebGLRenderer({antialias: true, alpha: true, preserveDrawingBuffer: true});
  previewRenderer.setClearColor(0x000000, 0);
  previewRenderer.setSize(264, 144);
  previewRenderer.outputColorSpace = renderer.outputColorSpace;
  previewRenderer.toneMapping = renderer.toneMapping;
  previewRenderer.toneMappingExposure = renderer.toneMappingExposure;
  const previewScene = new THREE.Scene();
  scene.children.filter((object) => object.isLight).forEach((light) => previewScene.add(light.clone()));
  const previewCamera = new THREE.PerspectiveCamera(36, 264 / 144, .01, 1000);
  try {
    for (const entity of list) {
      const bounds = new THREE.Box3().setFromObject(entity.group);
      const target = bounds.getCenter(new THREE.Vector3());
      const radius = Math.max(bounds.getSize(new THREE.Vector3()).length() / 2, .01);
      const model = entity.group.clone(true);
      model.matrixAutoUpdate = false;
      model.matrix.copy(entity.group.matrixWorld).premultiply(new THREE.Matrix4().makeTranslation(-target.x, -target.y, -target.z));
      previewScene.add(model);
      const distance = radius / Math.sin(THREE.MathUtils.degToRad(previewCamera.fov / 2)) * 1.05;
      previewCamera.near = Math.max(.001, distance - radius * 2);
      previewCamera.far = distance + radius * 3;
      previewCamera.updateProjectionMatrix();
      const direction = new THREE.Vector3(1, .65, 1);
      previewCamera.position.copy(direction.normalize().multiplyScalar(distance));
      previewCamera.lookAt(0, 0, 0);
      previewRenderer.render(previewScene, previewCamera);
      $(`[data-object="${entity.id}"] .object-thumb`).src = previewRenderer.domElement.toDataURL('image/png');
      previewScene.remove(model);
    }
  } finally {
    previewRenderer.dispose();
    previewRenderer.forceContextLoss();
  }
}

function restoreGhostMaterials() {
  for (const [mesh, original, castShadow] of ghostMaterials) {mesh.material.dispose(); mesh.material = original; mesh.castShadow = castShadow;}
  ghostMaterials.length = 0;
  if (renderer) renderer.shadowMap.needsUpdate = true;
}

// A piece still where it was, resting there, needs no new drop check: that pose was checked
// when it was placed. Selecting it, or confirming without moving it, is then immediate.
function planDrop(options) {
  const before = pending.before[selected], now = layout[selected], state = placementStates.get(selected);
  const inPlace = before.visible !== false && state?.state === 'stable' && ['x', 'y', 'z', 'yaw'].every((key) => Math.abs((now[key] || 0) - (before[key] || 0)) < 1e-9);
  if (!inPlace) return predictDrop(selected, layout, placement, collision, options);
  const label = state.label.replace(/^已放稳 · /, '');
  return {ok: true, checked: true, candidate: copyLayout(layout), moved: [selected], state, height: state.height, label, distance: 0, message: `保持在${label}`};
}

function refreshSession() {
  if (!pending) return;
  const state = placementStates.get(selected);
  const installing = pending.before[selected].visible === false;
  dropPlan = pending.gravity ? planDrop({previewOnly:analogActive}) : null;
  const contact = !analogActive && !pending.gravity && (installing || placement.isWall(selected)) ? collision.checkPlacement(layout, [selected]) : null;
  const valid = !analogActive && (pending.gravity ? dropPlan.ok : state?.state === 'stable' && !motionNotice?.previewInvalid && !motionNotice?.contactInvalid && (!contact || contact.ok));
  if (valid) pending.lastReachable = copyLayout(layout);
  pending.update(layout, valid, pending.gravity ? dropPlan.message : contact && !contact.ok ? `这里会碰到${contact.other?.name || '其他物体'}，请选择其他位置` : motionNotice?.message || state?.label || '等待落位');
  const moved = ids.filter(id => id === selected || ['x','y','z','yaw'].some(key => Math.abs((layout[id][key] || 0) - (pending.before[id][key] || 0)) > 1e-9));
  const originals = new Map(ghostMaterials.map(record => [record[0], record]));
  const activeMeshes = new Set();
  for (const id of moved) entities.get(id).group.traverse(mesh => {
    if (!mesh.isMesh || mesh.userData.contactOnly) return;
    activeMeshes.add(mesh);
    let record = originals.get(mesh);
    if (!record) {
      record = [mesh, mesh.material, mesh.castShadow];
      ghostMaterials.push(record);
      mesh.castShadow = false;
      renderer.shadowMap.needsUpdate = true;
      mesh.material = new THREE.MeshBasicMaterial({transparent:true, opacity:.34, depthWrite:false, side:THREE.DoubleSide});
    }
    const color = analogActive ? 0xb39a62 : valid ? 0x62c6b1 : 0xed766b;
    mesh.material.color.setHex(color);
  });
  for (let i=ghostMaterials.length-1; i>=0; i--) {
    const [mesh, original, castShadow] = ghostMaterials[i];
    if (activeMeshes.has(mesh)) continue;
    mesh.material.dispose(); mesh.material = original; mesh.castShadow = castShadow;
    ghostMaterials.splice(i,1); renderer.shadowMap.needsUpdate = true;
  }
}

function updateSessionUI() {
  updatePlacementPanel({pending, wall:selected && placement?.isWall(selected), wallRelocation, value:selected && layout[selected]});
  $('#store-object').hidden = !selected || (pending?.before[selected] || layout[selected])?.visible === false;
  $('#store-object').disabled = !!falling;
  $('#settle-object').hidden = !!pending?.gravity;
  if (pending?.gravity) {
    $('#confirm-placement').textContent = falling ? '正在落下…' : '放置并落下';
    $('#confirm-placement').disabled = !!falling || !pending.valid;
    $('#interaction-help').textContent = '摇杆移动 · 升降调整高度 · 投影显示落点';
  } else $('#confirm-placement').textContent = '确认放置';
}

function beginSession(id) {
  if (!ready || !entities.has(id)) return;
  cancelSession(false);
  setMode('edit');
  select(id, false);
  pending = new PlacementSession(layout, id, true);
  pending.gravity = !placement.isWall(id);
  pending.lastReachable = copyLayout(layout);
  layout = copyLayout(layout);
  // Out of the warehouse, a piece starts where the reconstruction had it.
  if (layout[id].visible === false) layout[id] = {x: 0, y: 0, z: 0, yaw: 0};
  delete layout[id].visible;
  motionNotice = null;
  applyLayout();
  $('#status').textContent = `正在预览${entities.get(id).name} · 确认后保存，Esc 取消`;
}

function cancelSession(announce = true) {
  cancelValidation();
  if (!pending) return;
  stopFall();
  joysticks?.stop();
  cancelValidation();
  finishHold();
  endWallRelocation();
  restoreGhostMaterials();
  layout = pending.cancel();
  pending = null;
  select(null, false);
  applyLayout();
  $('#save-state').textContent = '已保留确认过的布局';
  if (announce) {showToast('已取消，原位置保留'); $('#status').textContent = '已取消预览，原布局保持不变';}
}

function confirmSession() {
  if (!pending || falling) return;
  joysticks?.stop();
  cancelValidation();
  finishHold();
  if (!pending.gravity) refreshSession();
  if (wallRelocation) {
    if (!wallRelocation.valid) {showToast('请先选择可安装的墙面位置'); return;}
    if (!lockWallPreview()) return;
  }
  if (pending.gravity) {
    dropPlan = planDrop();
    if (!dropPlan.ok) {showToast(dropPlan.message); applyLayout(); return;}
    const landing = dropPlan;
    if (landing.distance > .005) {startFall(landing); return;}
    layout = copyLayout(landing.candidate);
    pending.update(layout, true, landing.message);
  }
  completePlacement();
}

function completePlacement() {
  const result = pending.confirm();
  if (!result) {showToast(pending.message || '请先落到有效支撑面'); return;}
  const before = pending.committed(), name = entities.get(selected).name;
  restoreGhostMaterials();
  pending = null;
  layout = result;
  select(null, false);
  applyLayout();
  commit(before);
  hasEdited = true;
  persist();
  $('#status').textContent = `已放置${name} · 可撤销或重新摆放`;
  showToast('家具已放置，布局已保存');
}

function followPointer(clientX, clientY, force = false) {
  if (!pending || (pending.locked && !force)) return;
  if (placement.isWall(selected)) {
    if (!wallRelocation) beginWallRelocation();
    const hit = pickWall(clientX, clientY);
    if (hit) previewWall(hit.name, hit.point);
    updateSessionUI();
    return;
  }
  const rect = host.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2((clientX-rect.left)/rect.width*2-1,-(clientY-rect.top)/rect.height*2+1), camera);
  let target = null;
  for (const hit of raycaster.intersectObject(room, true)) {
    const owner = hit.object.userData.editorId || null;
    if (owner === selected || (owner && layout[owner].visible === false)) continue;
    // Decorative contents, backs and arms are not placement targets. Only a
    // point on an authored support surface can raise the candidate off the floor.
    target = placement.supportAtPoint(owner, hit.point.toArray(), layout);
    if (target) break;
  }
  const point = target ? new THREE.Vector3().fromArray(target.point) : raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0,1,0),-floorY), new THREE.Vector3());
  if (!point) return;
  const before = pending.lastReachable, next = copyLayout(before), entity = entities.get(selected);
  delete next[selected].visible;
  next[selected].x = point.x - entity.origin.x;
  next[selected].z = point.z - entity.origin.z;
  next[selected].yaw = layout[selected].yaw;
  next[selected].y = layout[selected].y;
  motionNotice = null;
  const constrained = pending.gravity ? placement.constrain(selected, before, next, 'up') : target ? placement.settleAt(selected, next, point.y) : placement.constrain(selected, before, next, 'pointer');
  const carried = constrained.ok ? placement.carry(selected, before, next) : constrained;
  if (!carried.ok) {
    layout = next;
    motionNotice = {id:selected, previewInvalid:true, message:carried.message};
  } else {
    // Warehouse entries are installed at their destination; placed furniture moves
    // continuously from its last reachable pose, including carried objects.
    const relocating = pending.before[selected].visible === false || pending.gravity || pending.surfaceChoice;
    // While a hand drags it (analogActive) this is a preview; release checks it in full.
    const contact = analogActive ? {layout:next, blocked:false} : relocating ? {...collision.checkPlacement(next, carried.moved), layout:next} : collision.limit(before, next, carried.moved);
    layout = contact.layout;
    if (contact.blocked) motionNotice = {id:selected, previewInvalid:relocating, message:`碰到${contact.other?.name || '物体'}，请调整预览位置`};
    if (!contact.blocked || pending.before[selected].visible !== false) pending.lastReachable = copyLayout(layout);
  }
  applyLayout();
  host.style.cursor = pending.valid ? 'crosshair' : 'not-allowed';
}

function setMode(nextMode) {
  if (nextMode === 'preview') {cancelSession(false); select(null, false);}
  mode = nextMode;
  $('#rc-placement-demo').dataset.mode = mode;
  alignCameraToStage();
  for (const button of document.querySelectorAll('[data-mode]')) button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
  requestRender();
}

function storeObjects(id = null) {
  cancelSession(false);
  act(() => {
    const targets = id ? placement.carry(id, layout, copyLayout(layout)).moved || [id] : ids;
    for (const item of targets) layout[item] = {...layout[item], visible:false};
  });
  select(null, false);
  if (!id) {$('#object-panel').classList.add('open'); $('#list-toggle').setAttribute('aria-expanded','true');}
  showToast(id ? '已收回仓库，可重新放置或撤销' : '房间已清空，家具都在仓库中 · 可撤销');
}

function bindPlacementEvents() {
  bindPlacementPanel({
    confirm: confirmSession,
    cancel: () => cancelSession(),
    lock: () => {
      if (!pending) return;
      if (wallRelocation) {lockWallPreview(); return;}
      pending.locked = !pending.locked;
      if (!pending.locked && placement.isWall(selected)) beginWallRelocation();
      updateSessionUI();
    },
    store: () => storeObjects(selected),
    clear: () => storeObjects(),
    setMode,
    toggleLight: () => {
      warm = !warm;
      $('#light').setAttribute('aria-pressed', String(warm));
      scene.children.filter(object => object.isLight).forEach(light => {if (light.isDirectionalLight) light.color.set(warm ? 0xffd2a5 : 0xffffff);});
      showToast(warm ? '傍晚暖光' : '柔和日光'); requestRender();
    },
  });
}

// The gesture page (gesture/, see gesture-bridge.mjs) embeds this editor and sends hand frames.
// Move and rotate run the same preview → release → drop-and-check transaction as the mouse and
// joystick; a release that cannot be placed puts the piece back, as ViewForge's layout page does.
let gestureMode = 'view', gesture = null, gestureFrame = 0, gestureView = null;
const handPointer = Object.assign(document.createElement('div'), {className: 'rc-hand-pointer', hidden: true});
$('.rc-stage').appendChild(handPointer);
const GESTURE_HELP = {view: '仅观察：右手两指捏合环绕，三指合拢平移', move: '移动：右手指向家具捏合拖动，松开落下', rotate: '旋转：右手指向家具捏合，左右移动转向，松开确认'};
function handClient({u, v}) {
  const rect = host.getBoundingClientRect();
  return {x: rect.left + u * rect.width, y: rect.top + v * rect.height};
}
function gestureStep(step) {
  if (!gesture) return;
  gesture.step = step;
  // Frames arrive faster than a heavy piece can be checked; apply only the latest one.
  gestureFrame ||= requestAnimationFrame(() => {gestureFrame = 0; const next = gesture?.step; if (next) {gesture.step = null; next();}});
}
function endGesture() {
  cancelAnimationFrame(gestureFrame); gestureFrame = 0;
  gesture = null; analogActive = false; controls.enabled = true;
}
function cameraState() {
  controls.update(); camera.updateMatrixWorld();
  const orbit = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
  return {theta: orbit.theta, phi: orbit.phi, radius: orbit.radius, minPhi: Math.min(.02, orbit.phi), maxPhi: controls.maxPolarAngle,
    target: controls.target.toArray(), right: new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).toArray(),
    up: new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).toArray(),
    width: (camera.right - camera.left) / camera.zoom, height: (camera.top - camera.bottom) / camera.zoom};
}
function applyCamera(pose) {
  controls.target.fromArray(pose.target);
  camera.position.setFromSpherical(new THREE.Spherical(pose.radius, pose.phi, pose.theta)).add(controls.target);
  controls.update(); requestRender();
}
const gesturePort = {
  blocked: () => !ready || !!falling,
  mode: () => gestureMode,
  begin(hand, kind) {
    const {x, y} = handClient(hand), id = pick(x, y);
    if (!id) {$('#status').textContent = '没有指到家具：指向家具后再捏合'; return false;}
    if (kind === 'rotate' && placement.isWall(id)) {showToast('壁挂物件保持安装朝向'); return false;}
    beginSession(id);
    if (!pending) return false;
    analogActive = true; controls.enabled = false;
    gesture = {id, kind, yaw: layout[id].yaw, step: null};
    $('#status').textContent = `${kind === 'move' ? '移动' : '旋转'}${entities.get(id).name} · 松开放下`;
    return true;
  },
  move(hand) {
    const {x, y} = handClient(hand);
    gestureStep(() => followPointer(x, y, true));
  },
  rotate(angle) {
    const {id, yaw} = gesture || {};
    gestureStep(() => editObject((next) => {next[id].yaw = Math.atan2(Math.sin(yaw + angle), Math.cos(yaw + angle));}, 'rotate'));
  },
  commit() {
    if (!gesture) return;
    // Apply the last pending frame as a preview, then check the release in full.
    cancelAnimationFrame(gestureFrame); gestureFrame = 0;
    const step = gesture.step; gesture.step = null; step?.();
    endGesture();
    if (!pending) return;
    confirmSession();
    if (pending && !falling) {
      const reason = dropPlan?.message || pending.message || '这里放不下';
      cancelSession(false); showToast(`${reason}，已放回原位`);
    }
  },
  cancel() {
    if (!gesture) return;
    endGesture(); cancelSession(false);
  },
  pointer(hand) {
    handPointer.hidden = !hand;
    if (!hand) return;
    handPointer.style.left = `${hand.u * 100}%`; handPointer.style.top = `${hand.v * 100}%`;
    handPointer.dataset.pinching = String(!!hand.pinching);
  },
  observe: {
    begin(hand, action) {
      if (gestureView || !ready) return false;
      gestureView = {base: cameraState(), start: {u: hand.u, v: hand.v}, action};
      controls.enabled = false; return true;
    },
    update(hand) {if (gestureView) applyCamera(observationPose(gestureView.base, gestureView.start, hand, gestureView.action));},
    finish(cancel) {
      if (!gestureView) return;
      if (cancel) applyCamera(gestureView.base);
      gestureView = null; controls.enabled = true;
    },
  },
};
const embedded = connectGestureBridge({
  input: new GestureInput(gesturePort),
  setMode(next) {
    gestureMode = next;
    if (next !== 'view' && mode !== 'edit') setMode('edit');
    $('#status').textContent = GESTURE_HELP[next]; $('#interaction-help').textContent = GESTURE_HELP[next];
    return true;
  },
  state: () => ({busy: !ready || !!falling, mode: gestureMode, selectedId: selected, layoutReady: ready,
    phase: gestureView ? 'observing' : falling ? 'validating' : gesture ? 'preview' : 'idle',
    message: $('#status').textContent || '', capabilities: ['observe-pinch-v1']}),
});

// Objects rebuilt by ViewForge, at their measured size. The full model is shown; its light
// preview (same frame, ~1/40 of the triangles) stands in for contact and collision checks.
let addedCount = 0, importAsset = null;
async function openImports() {
  let catalog;
  try {catalog = await readCatalog();} catch {return;}
  if (!catalog.runs?.length) return;
  for (const run of catalog.runs) $('#import-run').appendChild(new Option(objectLabel(run), run));
  $('#import-menu').hidden = false;
  $('#import-run').onchange = () => void chooseImport();
  $('#import-axis').onchange = $('#import-meters').oninput = describeImport;
  $('#import-object').onclick = () => void importObject().catch((error) => {
    console.error(error); showToast(`导入失败：${error.message || error}`); $('#import-object').disabled = false;
  });
  await chooseImport();
}
async function chooseImport() {
  const run = $('#import-run').value;
  importAsset = null; $('#import-object').disabled = true; $('#import-note').textContent = '正在读取尺寸…';
  const asset = await readAsset(run).catch(() => null);
  if ($('#import-run').value !== run) return;
  if (!asset) {$('#import-note').textContent = '读取失败，请检查 ViewForge 隧道'; return;}
  importAsset = {...asset, run};
  const saved = savedMeasurement(asset);
  if (saved) {$('#import-axis').value = saved.axis; $('#import-meters').value = String(+saved.meters.toFixed(3));}
  else $('#import-meters').value = '';
  describeImport();
}
function describeImport() {
  if (!importAsset) return;
  let size;
  try {size = sizeInMeters(importAsset.base, metricScale(importAsset.base, $('#import-axis').value, Number($('#import-meters').value)));}
  catch {$('#import-note').textContent = savedMeasurement(importAsset) ? '请输入实测长度' : 'ViewForge 里还没标定：填一条实测边长'; $('#import-object').disabled = true; return;}
  $('#import-note').textContent = `${size[0].toFixed(2)} × ${size[2].toFixed(2)} × ${size[1].toFixed(2)} 米（宽 × 深 × 高）`;
  $('#import-object').disabled = false;
}
// The free floor spot nearest the middle of the room where a new piece can stand.
function freeSpot(id) {
  const step = .2, reach = Math.max(roomSize.x, roomSize.z) / 2, spots = [];
  for (let x = -reach; x <= reach; x += step) for (let z = -reach; z <= reach; z += step) spots.push([x, z]);
  spots.sort((a, b) => Math.hypot(...a) - Math.hypot(...b));
  for (const [x, z] of spots) {
    const candidate = copyLayout(layout);
    candidate[id] = {x, y: 0, z, yaw: 0};
    const drop = predictDrop(id, candidate, placement, collision);
    if (drop.ok) return drop.candidate[id];
  }
  return null;
}
async function importObject() {
  if (!ready || !importAsset) return;
  const {run, base} = importAsset, scale = metricScale(base, $('#import-axis').value, Number($('#import-meters').value));
  $('#import-object').disabled = true; $('#status').textContent = `正在载入 ${objectLabel(run)}…`;
  const loader = new GLTFLoader();
  const [full, light] = await Promise.all(['result.glb', 'preview.glb'].map((file) => loader.loadAsync(viewforgeModel(run, file))));
  cancelSession(false);
  const id = `added-${++addedCount}`, contact = `${id}:contact`;
  const shape = new THREE.Group();
  shape.applyMatrix4(new THREE.Matrix4().fromArray(placementMatrix(base, scale)));
  full.scene.traverse((mesh) => {
    if (!mesh.isMesh) return;
    // Colours are baked into the vertices; light them as ViewForge does (unlit).
    mesh.material = new THREE.MeshBasicMaterial({vertexColors: !!mesh.geometry.attributes.color, side: THREE.DoubleSide});
    mesh.userData.collision = false; mesh.raycast = () => {};
    mesh.castShadow = true;
  });
  light.scene.name = light.scene.userData.name = contact;
  light.scene.traverse((mesh) => {
    if (!mesh.isMesh) return;
    mesh.material = new THREE.MeshBasicMaterial({colorWrite: false, depthWrite: false});
    mesh.userData.contactOnly = true; mesh.castShadow = mesh.receiveShadow = false;
  });
  shape.add(full.scene, light.scene);
  const origin = new THREE.Vector3(center.x, floorY, center.z);
  const group = new THREE.Group();
  group.name = `Editable_${id}`; group.position.copy(origin);
  group.add(shape); room.add(group); room.updateMatrixWorld(true);
  group.traverse((object) => {if (object.isMesh) object.userData.editorId = id;});
  const size = sizeInMeters(base, scale), name = objectLabel(run);
  const entity = {id, name, category: '导入物体 · 真实尺寸', roots: [contact], group, origin, added: true,
    sizeLabel: `${size[0].toFixed(2)} × ${size[2].toFixed(2)} × ${size[1].toFixed(2)} ${config.units}`};
  entities.set(id, entity); ids.push(id);
  placementSpecs[id] = {body: [contact]};
  layout[id] = stored();
  for (const past of [...history.past, ...history.future]) past[id] = stored();
  appendWarehouseRow(entity, true); renderFurnitureThumbnails([entity]);
  group.visible = false;
  // Placement and collision index every piece once; rebuild them with the new one (a few seconds).
  placement = createPlacement(THREE, room, entities, placementSpecs, floorY, ceilingY, {openings: config.openings});
  collision = createCollision(THREE, room, entities, placementSpecs, {label: config.label, keepAuthoredOverlaps: true});
  $('#import-menu').open = false; $('#import-object').disabled = false;
  renderer.shadowMap.needsUpdate = true;
  beginSession(id);
  const spot = freeSpot(id);
  if (spot) {layout[id] = spot; pending.lastReachable = copyLayout(layout); applyLayout();}
  showToast(`已导入${name}：${embedded ? '移动模式下指向它捏合拖动' : '移动鼠标摆放，单击锁定'}，确认后放下`);
  if (!embedded) pending.locked = false;
}

async function load() {
  renderer = new THREE.WebGLRenderer({antialias: true, powerPreference: 'low-power'});
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.localClippingEnabled = true;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.domElement.setAttribute('aria-label', '房间三维场景，点选家具或使用物体列表');
  host.appendChild(renderer.domElement);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;
  controls.minZoom = .45; controls.maxZoom = 8;
  controls.minDistance = .2;
  controls.maxDistance = 2000;
  controls.maxPolarAngle = Math.PI / 2 - .015;
  controls.addEventListener('change', requestRender);
  controls.addEventListener('start', finishHold);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x87919d, 2.5));
  for (const [position, intensity] of [[[3, 8, 5], 2.4], [[-5, 4, -4], 1.4]]) {
    const light = new THREE.DirectionalLight(0xffffff, intensity);
    light.position.set(...position); scene.add(light);
  }
  const resize = () => {
    const width = host.clientWidth, height = host.clientHeight;
    if (!width || !height) return;
    const aspectChanged = Math.abs((width / height) / camera.aspect - 1) > .18;
    camera.aspect = width / height; alignCameraToStage(); camera.updateProjectionMatrix();
    renderer.setSize(width, height);
    if (ready && aspectChanged) view(activeView);
    requestRender();
  };
  new ResizeObserver(resize).observe(host);
  resize();
  bindEvents();
  bindPlacementEvents();
  const progress = $('#load-progress');
  const reportProgress = (start, span) => event => {
    if (event.total) progress.value = start + event.loaded / event.total * span;
    else progress.removeAttribute('value');
  };
  config = await roomConfigReady;
  ids.push(...config.catalog.map((item) => item.id)); roomIds.push(...ids);
  Object.assign(placementSpecs, config.placement);
  const gltf = await new GLTFLoader().loadAsync(await versionedModelURL(), reportProgress(0, 80));
  progress.value = 80;
  room = gltf.scene;
  scene.add(room);
  room.updateMatrixWorld(true);
  // Grouping, and flattening a generated room, must leave every mesh where it was.
  const originalMatrices = new Map();
  room.traverse((object) => {if (object.isMesh) originalMatrices.set(object, object.matrixWorld.clone());});
  flattenObjects(room, config.nodes);
  const bounds = new THREE.Box3().setFromObject(room);
  center = bounds.getCenter(new THREE.Vector3()); roomSize = bounds.getSize(new THREE.Vector3());
  floorY = new THREE.Box3().setFromObject(room.getObjectByName('Floor0')).max.y;
  for (const root of room.children) {
    if (config.isCeiling(root.userData.name || root.name)) {ceilingObjects.push(root); root.visible = $('#ceiling').checked;}
  }
  // Keep the sample's soft daylight and contact shadows on the actual room assets.
  room.traverse(mesh => {if (mesh.isMesh) {mesh.castShadow = mesh.name !== 'Floor0'; mesh.receiveShadow = true;}});
  const sun = scene.children.find(light => light.isDirectionalLight);
  sun.position.set(center.x - 3.5, floorY + 8, center.z + 4);
  sun.target.position.set(center.x, floorY, center.z); scene.add(sun.target);
  sun.castShadow = true; sun.shadow.mapSize.set(2048,2048);
  const shadowSpan = Math.max(roomSize.x,roomSize.z)*.9;
  Object.assign(sun.shadow.camera,{left:-shadowSpan,right:shadowSpan,top:shadowSpan,bottom:-shadowSpan,near:.1,far:30});
  sun.shadow.bias = -.00025; sun.shadow.normalBias = .012; sun.shadow.radius = 4;
  const audit = groupScene(gltf, originalMatrices);
  progress.value = 92;
  renderFurnitureThumbnails();
  ceilingY = new THREE.Box3().setFromObject(room.getObjectByName('Wall0')).max.y;
  placement = createPlacement(THREE, room, entities, placementSpecs, floorY, ceilingY, {openings: config.openings});
  for (const wall of placement.wallTargets()) {
    const option = document.createElement('option'); option.value = wall.name; option.textContent = wallLabel(wall.name);
    $('#wall-target').appendChild(option);
  }
  audit.placement = placement.audit;
  collision = createCollision(THREE, room, entities, placementSpecs, {label: config.label, keepAuthoredOverlaps: true});
  audit.collision = collision.audit;
  wallVisibility = createWallVisibility(room, placement.wallTargets(), wallOptions(placement.wallTargets()));
  ready = true;
  // Entering a room always shows its authored layout. Merely opening it must
  // not overwrite the last confirmed arrangement in browser storage.
  layout = initialLayout(ids);
  try {$('#resume-layout').disabled = !localStorage.getItem(storageKey);} catch {}
  $('#save-state').textContent = '原始布置 · 确认更改后自动保存';
  joysticks = mountJoysticks($('.rc-stage'), {
    onStart() {
      cancelValidation();
      finishHold();
      if (wallRelocation) {if (wallRelocation.candidate) lockWallPreview(); else endWallRelocation();}
      if (pending) pending.locked = true;
      analogActive = true;
      joystickBefore = copyLayout(layout); controls.enabled = false;
      updateInspector();
    },
    onMove(x, y, dt) {
      if (!selected) return;
      const frame = placement.isWall(selected) ? placement.wallFrame(selected, layout) : null;
      if (placement.isWall(selected) && !frame) return;
      const delta = analogDelta(x, y, .65 * dt, basis(), frame?.tangent);
      editObject(next => {for (const key of ['x','y','z']) next[selected][key] = (next[selected][key] || 0) + delta[key];}, 'joystick');
    },
    onLift(sign, dt) {
      if (selected && !placement.isWall(selected)) editObject(next => {next[selected].y = (next[selected].y || 0) + sign * .8 * dt;}, sign > 0 ? 'up' : 'down');
    },
    onRotate(angle) {
      if (selected && !placement.isWall(selected)) editObject(next => rotate(next, selected, angle), 'rotate');
    },
    onEnd() {
      analogActive = false;
      controls.enabled = true;
      const before = joystickBefore; joystickBefore = null;
      if (before && pending) validateAfterRender();
      else if (before) commit(before);
    },
    onSurface() {
      if (!pending && selected) beginSession(selected);
      if (!pending) return;
      if (placement.isWall(selected)) {
        if (wallRelocation) {endWallRelocation(); pending.locked = true; updateInspector();}
        else beginWallRelocation();
      } else {
        pending.locked = !pending.locked;
        if (!pending.locked) pending.surfaceChoice = true;
        updateInspector();
        showToast(pending.locked ? '已锁定放置面' : '在地面、椅面或桌面上单击选择位置');
      }
    },
  });
  applyLayout();
  progress.value = 100;
  $('#loading').hidden = true;
  $('#status').textContent = `${entities.size} 件物体可布置 · 点选房间或下方家具卡片`;
  view('overview');
  void openImports();
  // Read-only diagnostics for real-browser verification; no controls or mutable scene exposed.
  window.roomEditor = Object.freeze({
    get ready() {return ready;},
    captureFrame() {renderer.render(scene, camera); return renderer.domElement.toDataURL('image/png');},
    projectFloor(x, z) { const p = new THREE.Vector3(x, floorY, z).project(camera), r = host.getBoundingClientRect(); return {x:r.x+(p.x*.5+.5)*r.width,y:r.y+(-p.y*.5+.5)*r.height}; },
    snapshot() {
      room.updateMatrixWorld(true);
      camera.updateMatrixWorld();
      return {scene: sceneKey, formatVersion: VERSION, selected, view: activeView, mode, cameraBasis: basis(), layout: copyLayout(pending ? pending.before : layout),
        pending: pending ? {id: pending.id, locked: pending.locked, valid: pending.valid, message: pending.message, candidate: copyLayout(pending.candidate)} : null, placement: Object.fromEntries(placementStates), motionNotice,
        wallRelocation: wallRelocation ? {target: wallRelocation.target, valid: wallRelocation.valid, message: wallRelocation.message, candidate: wallRelocation.candidate ? copyLayout(wallRelocation.candidate) : null} : null,
        wallTargets: placement.wallTargets().map(({name,center}) => {const p = new THREE.Vector3().fromArray(center).project(camera), rect = host.getBoundingClientRect(); return {name,center,screen:{x:rect.x+(p.x*.5+.5)*rect.width,y:rect.y+(-p.y*.5+.5)*rect.height}};}),
        undo: history.past.length, redo: history.future.length, audit,
        objects: [...entities.values()].map((entity) => {
          const box = new THREE.Box3().setFromObject(entity.group);
          const projected = box.getCenter(new THREE.Vector3()).project(camera);
          const rect = host.getBoundingClientRect();
          return {id: entity.id, name: entity.name, visible: entity.group.visible, roots: entity.roots, origin: entity.origin.toArray(),
            bounds: {min: box.min.toArray(), max: box.max.toArray()},
            members: entity.group.children.map((child) => ({name: child.userData.name || child.name, position: child.getWorldPosition(new THREE.Vector3()).toArray()})),
            screen: {x: rect.x + (projected.x * .5 + .5) * rect.width, y: rect.y + (-projected.y * .5 + .5) * rect.height}};
        }), renderCalls: renderer.info.render.calls, geometries: renderer.info.memory.geometries};
    },
  });
  renderer.domElement.addEventListener('webglcontextlost', (event) => {event.preventDefault(); finishHold(); persist(); fail('图形上下文已暂停');});
}

// Each fixture hides with its recorded wall; one with none (a curtain on a ceiling track)
// with the wall it hangs in front of.
function wallOptions(walls) {
  const near = new Map(config.nearWall.map((name) => {
    const root = room.children.find((object) => (object.userData.name || object.name) === name);
    return [name, root ? nearestWall(worldVertices(THREE, root), walls) : null];
  }));
  return {owner: (name) => config.wallOwner(name) || near.get(name) || null};
}

// A browser may keep an earlier Room.glb without asking the server again. Name the model by
// the file's own date and size, so a replaced room is always downloaded and an unchanged one cached.
async function versionedModelURL() {
  try {
    const head = await fetch(modelURL, {method: 'HEAD', cache: 'no-store'});
    const stamp = head.ok && (head.headers.get('etag') || [head.headers.get('last-modified'), head.headers.get('content-length')].filter(Boolean).join(' '));
    return stamp ? `${modelURL}?v=${encodeURIComponent(stamp)}` : modelURL;
  } catch {return modelURL;}
}

async function loadRoomConfig() {
  const response = await fetch(objectsURL, {cache: 'no-cache'});
  if (!response.ok) throw new Error(`物体清单读取失败（${response.status}）`);
  return roomConfig(await response.json());
}

const roomConfigReady = loadRoomConfig();
// The reconstruction viewer only exists beside a published preview.
if (sceneParam) $('a[href="../?model=authored"]').hidden = true;
roomConfigReady.then(({title}) => {
  document.title = `RoomCanvas · ${title}`;
  for (const label of document.querySelectorAll('.rc-room-card strong, .rc-project strong')) label.textContent = title;
}, () => {});

$('#open-office').onclick = () => {
  $('#open-office').disabled = true;
  $('#rc-placement-demo').dataset.roomSelection = 'false';
  load().catch(fail);
};
// Inside the gesture page there is no one to press the room card; open the room directly.
if (embedded) $('#open-office').click();
