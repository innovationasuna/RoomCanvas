import * as THREE from 'three';
import {setLayer} from './material-layers.mjs';
import {createSelectionHighlight} from './selection-highlight.mjs';
import {workspace} from './form-workspace.mjs';
import {createGroundGrid} from './ground-grid.mjs';
import {frameWorkspaceCamera, workspaceViewSize} from './workspace-camera.mjs';
import {THUMBNAIL_SIZE, frameThumbnailCamera} from './furniture-thumbnail.mjs';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {VERSION, initialLayout, copyLayout, encodeLayout, decodeLayout, groundBasis, wallBasis, move, rotate, History} from './layout.mjs';
import {createPlacement} from './placement.mjs';
import {updatePlacementPanel, bindPlacementPanel, updateFurnitureReadouts} from './placement-ui.mjs';
import {PlacementSession} from './placement-session.mjs';
import {collisionOwners, buildCollision, packOwners} from './collision.mjs';
import {createWallVisibility, nearestWall, worldVertices, setSeeThrough, seeThrough, againstWall, inNearHalf, SEE_THROUGH} from './wall-visibility.mjs';
import {roomConfig, flattenObjects, topMembers} from './room-catalog.mjs';

import {mountJoysticks} from './joystick-ui.mjs';
import {analogDelta} from './placement-motion.mjs';

import {predictDrop, dropStart, dropVerdict, fallFraction} from './drop-placement.mjs';
import {connectGestureBridge, GestureInput, observationPose} from './gesture-bridge.mjs';
import {createGestureCamera} from './gesture-camera.mjs';
import {mountGestureFeedback} from './gesture-feedback.mjs';
import {canGestureActivate, isExplicitExport} from './gesture-target.mjs';
import {Openings, openableOf, ridersOf} from './joints.mjs';
import {readCatalog, readAsset, loadModels, objectLabel, metricScale, savedMeasurement, placementMatrix, sizeInMeters} from './object-import.mjs';
import {mountAddObject} from './add-object-dialog.mjs';
import {shadowSettings} from './lighting-settings.mjs';
import {lightingProfile} from './lighting-profiles.mjs';
import {createRenderMetrics} from './render-metrics.mjs';
import {createImportMaterials} from './import-materials.mjs';
import {forgetImportedObject} from './imported-objects.mjs';
import {disposeObjectTree} from './object-dimensions.mjs';
import {mountWarehouseDrawer} from './warehouse-drawer.mjs';
import {createTimeLighting, timePreset} from './time-lighting.mjs';
import {colorGrading} from './color-grading.mjs';
import {mountLightingPanel} from './lighting-panel.mjs';
import {indoorLighting} from './indoor-lighting.mjs';
import {createWalk} from './walk.mjs';

const $ = (selector) => document.querySelector(selector);
const host = $('#viewport');
const warehouse = mountWarehouseDrawer({panel: $('#object-panel'), content: $('#warehouse-content'),
  toggle: $('#list-toggle'), close: $('#close-list'), onOpenChange: open => workspace.libraryVisibility(open)});
workspace.bindLibrary(warehouse.setOpen);
const gestureFeedbackPanel = mountGestureFeedback($('#gesture-card'));
// The room directory: ?room=<id> for a room of the home page (web/rooms.json); ?scene=<relative
// path> for any other room directory in the repository, e.g. ?scene=../../samples/room3; beside
// a published preview (<room>/preview/editor/) with neither.
const query = new URLSearchParams(location.search);
const lightProfile = lightingProfile(query.get('lighting'));
const enhancedLighting = lightProfile.name !== 'original';
const sceneParam = query.get('scene'), roomParam = query.get('room');
async function roomDirectory() {
  if (!roomParam) return {dir: sceneParam && !/^[a-z]+:|^\/\//i.test(sceneParam) ? sceneParam.replace(/\/+$/, '') : '../..', name: null};
  const manifest = new URL('../rooms.json', location.href);
  const response = await fetch(manifest, {cache: 'no-cache'});
  if (!response.ok) throw new Error(`房间列表读取失败（${response.status}）`);
  const entry = (await response.json()).rooms.find((room) => room.id === roomParam);
  if (!entry) throw new Error(`房间列表里没有 ${roomParam}`);
  return {dir: new URL(entry.dir, manifest).href.replace(/\/+$/, ''), name: entry.name};
}
const roomReady = roomDirectory();
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
let previewSerial = 0;
// Meshes shown as the drag preview → their preview layer (see material-layers.mjs).
const previewLayers = new Map();

let sceneKey, storageKey, room, floorY, ceilingY, center, roomSize, roomBounds, placement, collision, wallVisibility;
let hinged = null, walk = null, walkFrom = 'edit', walkAimAt = 0;
let motionNotice = null;
let wallRelocation = null, wallGhost = null;
const wallGhostSources = new Set();
const wallChoiceMeshes = [];
const editingWallMeshes = [];
let translucentEditingWall = null;
let placementStates = new Map();
let selected = null, hovered = null, pendingFrame = false, hold = null, pointerStart = null;
let toastTimer, lastHoverTime = 0, activeView = 'overview', ready = false;
const entities = new Map();
const ceilingObjects = [], selectedMeshes = [];
const raycaster = new THREE.Raycaster();
const scene = new THREE.Scene();
scene.background = new THREE.Color(getComputedStyle(host).getPropertyValue('--rc-canvas').trim());
const orbitCamera = new THREE.PerspectiveCamera(45, 1, .02, 3000);
const planCamera = new THREE.OrthographicCamera(-5, 5, 4, -4, .02, 3000);
let camera = orbitCamera;
camera.aspect = 1;
let cameraSpan = 7.8;
const selectionBox = new THREE.Box3();
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

let renderer, controls, joysticks, joystickBefore, groundGrid, hasEdited = false;
let staticLighting = null, orbitActive = false;
let renderMetrics = null;
let environmentLighting = null, environmentStatus = {state: enhancedLighting && query.get('env') !== 'off' ? 'loading' : 'off'};
let environmentFactory = null;
let lightingStatus = {enabled: false, state: enhancedLighting && query.get('ao') !== 'off' ? 'loading' : 'off', updates: 0, error: null};
let shadowMode = 'original';
let lightingRig = null, grading = colorGrading(), gradingFrame = 0;
let lightingTime = enhancedLighting ? timePreset(query.get('time')) : 'balanced';
let indoor = indoorLighting({power: query.get('indoor') !== 'off'});
const lightingPanel = mountLightingPanel({root: $('#lighting-menu'), timeRoot: $('#light-menu'), initialTime: lightingTime, initialIndoor: indoor,
  onTime: value => {lightingTime = value; warm = false; lightingRig?.apply(value); requestRender();},
  onIndoor: value => {
    const wasOn = indoor.power;
    indoor = indoorLighting(value); lightingRig?.setIndoor(indoor);
    try {localStorage.setItem(`roomcanvas:indoor-lighting:${sceneKey}`, JSON.stringify(indoor));} catch {}
    if (wasOn || indoor.power) requestRender();
  },
  onGrade: value => {
    grading = colorGrading(value); staticLighting?.setGrading(grading);
    if (gradingFrame || document.hidden) return;
    gradingFrame = requestAnimationFrame(() => {
      gradingFrame = 0;
      // A queued scene frame already picks up the latest grade. Otherwise only re-present
      // its cached beauty/AO; do not invalidate geometry, shadows or the settled scheduler.
      if (pendingFrame || !staticLighting?.snapshot().composite) return;
      renderMetrics.measure('color-grade', () => staticLighting.present());
    });
  },
});
let analogActive = false, validationFrame = 0, validationTimer = 0;
let layoutStamp = 0, tallStamp = -1, tall = new Map(), blockingNear = new Set();
let supportStamp = -1, supported = new Map(), concealedIds = new Set();
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
    // Walking, every wall and tall piece is solid: nothing is cut away for a bird's-eye view.
    const walking = !!walk?.active;
    if (groundGrid) groundGrid.visible = !walking && $('#ground-grid').checked;
    // 近侧墙: near walls, with what hangs on them and the tall pieces in the way, go see-through or out of sight.
    const nearWalls = nearWallMode(), hideNear = nearWalls === 'hidden', cutting = nearWalls !== 'solid';
    if (wallVisibility) {
      const editingWall = selected && placement.isWall(selected) ? placementStates.get(selected)?.wall : null;
      const result = wallVisibility.update(camera.position.clone().sub(controls.target).toArray(), {enabled: !walking && cutting, reveal: !!wallRelocation, revealWalls: editingWall ? [editingWall] : []});
      host.dataset.hiddenWalls = result.hidden.join(',');
      setEditingWall(result.revealed[0] || null);
      if (result.changed) renderer.shadowMap.needsUpdate = true;
      const hidden = new Set(result.hidden);
      // Tall pieces (a wardrobe, a bookcase, a whiteboard) go see-through when they stand against a
      // near wall or in the half of the room nearer the camera. Their boxes are measured again only
      // when the layout changes.
      if (tallStamp !== layoutStamp) {
        tallStamp = layoutStamp;
        tall = new Map();
        for (const [id, entity] of entities) {
          if (layout[id].visible === false || placement.isWall(id)) continue;
          // A book on a bookcase's top shelf reaches 1.6 m, but it follows its bookcase (below).
          if (entities.has(placementStates.get(id)?.support)) continue;
          const box = new THREE.Box3().setFromObject(entity.group);
          if (box.isEmpty() || box.max.y - floorY < 1.6) continue;
          const points = [box.min, box.max].flatMap((a) => [box.min, box.max].flatMap((b) => [[a.x, box.min.y, b.z], [a.x, box.max.y, b.z]]));
          tall.set(id, {points, center: box.getCenter(new THREE.Vector3()).toArray()});
        }
      }
      const concealed = placement.wallTargets().filter((wall) => hidden.has(wall.name));
      const view = camera.position.clone().sub(controls.target).toArray();
      const blocking = new Set();
      for (const [id, {points, center: middle}] of tall) {
        if (walking) continue;
        if (concealed.some((wall) => againstWall(points, wall, {floor: floorY}))
            || (cutting && inNearHalf(middle, [center.x, center.y, center.z], view, blockingNear.has(id)))) blocking.add(id);
      }
      blockingNear = blocking;
      // On a near wall (a painting) or against one: see-through, unless it is the piece being arranged.
      const faint = new Set([...entities.keys()].filter((id) => id !== selected
        && ((placement.isWall(id) && hidden.has(placementStates.get(id)?.wall)) || blockingNear.has(id))));
      // What rests on such a piece (books in a bookcase, a bag on a wall ledge) goes with it,
      // instead of floating where the piece was. Supports come from the placement check.
      if (supportStamp !== layoutStamp) {
        supportStamp = layoutStamp; supported = new Map();
        for (const [id, state] of placementStates) if (entities.has(state?.support) && state.support !== id) {
          if (!supported.has(state.support)) supported.set(state.support, []);
          supported.get(state.support).push(id);
        }
      }
      for (const queue = [...faint]; queue.length;) for (const child of supported.get(queue.pop()) || []) {
        if (child !== selected && !faint.has(child)) {faint.add(child); queue.push(child);}
      }
      concealedIds = faint;
      for (const [id, entity] of entities) {
        const visible = layout[id].visible !== false && !wallGhostSources.has(id);
        if (entity.group.visible !== visible) {entity.group.visible = visible; renderer.shadowMap.needsUpdate = true;}
        if (setSeeThrough(entity.group, faint.has(id), hideNear ? 0 : SEE_THROUGH)) renderer.shadowMap.needsUpdate = true;
      }
    }
    lightingRig?.syncOccluders();
    updateSelectionVisuals();
    const view = walking ? walk.camera : camera;
    staticLighting?.setCamera(view);
    renderMetrics.measure('interactive', () => {if (staticLighting) staticLighting.render(); else renderer.render(scene, view);});
    lightingPanel.availability({time: enhancedLighting && !!lightingRig, grading: enhancedLighting && !!staticLighting?.snapshot().composite});
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
    arrows.forEach(arrow => {arrow.visible = false;});
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
  const supportY = Number.isFinite(state?.height) ? state.height : floorY;
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
  layoutStamp++;
  if (placement) placementStates = new Map(ids.filter(id => layout[id].visible !== false).map((id) => [id, placement.assess(id, layout)]));
  if (pending) refreshSession();
  updateDropProjection();
  for (const row of $('#object-list').querySelectorAll('[data-object]')) {
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
  $('#redo').disabled = !history.future.length;
  $('#selected-count').textContent = selected ? '1' : '0';
  $('#selection-fieldset').disabled = !selected || !!falling;
  $('#empty-selection').hidden = !!selected;
  $('#selection-controls').hidden = !selected;
  $('.rc-controls').hidden = !selected;
  $('#focus').disabled = !selected;
  $('#reset-object').disabled = !selected || !!falling;
  updateSessionUI();
  const support = placementStates.get(selected)?.support;
  joysticks?.setState({visible: !!selected && mode === 'edit', enabled: !!selected && mode === 'edit' && !falling, wall: selected && placement?.isWall(selected), support: entities.get(support)?.name || '地面', landing:dropPlan ? dropPlan.label || (dropPlan.ok ? '地面' : '无可用落点') : ''});
  workspace.update({ready, selected, pending: !!pending, busy: !!falling, mode, wall: !!selected && placement?.isWall(selected), view: activeView});
  if (!selected) {
    $('#selected-name').textContent = '挑一件物品，试着摆放';
    $('#selected-category').textContent = '从房间或下方物品栏选择';
    return;
  }
  const entity = entities.get(selected);
  const value = (wallRelocation?.candidate || layout)[selected];
  $('#selected-name').textContent = entity.name;
  $('#selected-category').textContent = entity.category;
  $('#selection-label').textContent = entity.name;
  updateFurnitureReadouts(entity.dimensions, value);
  const wall = placement?.isWall(selected);
  const changingWall = !!wallRelocation;
  $('#rotate-left').disabled = $('#rotate-right').disabled = !!wall;
  $('#rotate-left').title = $('#rotate-right').title = wall ? '壁挂物件保持安装朝向' : '旋转 15°';
  $('#direction-note').textContent = wall ? '上下左右沿墙移动 · 前后按当前视角换墙' : '按当前视角移动 · 可调整高度';
  $('.control-shortcut').textContent = wall ? '↑ ↓ ← → · W / S 换墙' : '↑ ↓ ← →';
  $('.direction-pad').setAttribute('aria-label', wall ? '沿墙上下左右移动选中物品' : '沿地面移动选中物品');
  $('.height-buttons').setAttribute('aria-label', wall ? '按当前视角前后换墙' : '调整选中物品的高度');
  $('.height-heading span').textContent = wall ? '前后换墙 · 保持高度' : '高度微调';
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
  $('#wall-section').hidden = !wall;
  $('#wall-current').textContent = wallRelocation?.candidate ? `${wallLabel(wallRelocation.target)} · 预览` : state?.wall ? wallLabel(state.wall) : '等待贴合墙面';
  $('#change-wall').textContent = changingWall ? '取消换墙' : '点选换墙';
  $('#change-wall').setAttribute('aria-expanded', String(changingWall));
  $('#wall-picker-controls').hidden = !changingWall;
  for (const selector of ['.move-section', '.height-section', '.placement-section']) $(selector).hidden = changingWall;
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

// The wall a hanging piece is being arranged on, faint so the piece shows (a near wall too).
const EDITING_WALL = {material: (material) => Object.assign(material.clone(), {transparent: true, opacity: .18, depthWrite: false, side: THREE.DoubleSide})};
// Every wall, while choosing which one a hanging piece moves to.
const WALL_CHOICE = {material: (material) => Object.assign(material.clone(), {transparent: true, opacity: .18, depthWrite: false, clippingPlanes: [], side: THREE.DoubleSide})};
function setEditingWall(name) {
  if (name === translucentEditingWall) return;
  for (const mesh of editingWallMeshes) setLayer(mesh, 'editingWall', null);
  editingWallMeshes.length = 0;
  translucentEditingWall = name;
  if (name) room.getObjectByName(name)?.traverse(mesh => {
    if (!mesh.isMesh) return;
    setLayer(mesh, 'editingWall', EDITING_WALL);
    editingWallMeshes.push(mesh);
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
  for (const mesh of wallChoiceMeshes) setLayer(mesh, 'wallChoice', null);
  wallChoiceMeshes.length = 0;
  wallRelocation = null;
  syncNearWallOptions();
  host.style.cursor = '';
  requestRender();
}

// 近侧墙: 'solid', 'faint' (see-through) or 'hidden' (the default).
const nearWallInputs = () => document.querySelectorAll('input[name="near-walls"]');
const nearWallMode = () => document.querySelector('input[name="near-walls"]:checked')?.value || 'hidden';
function setNearWallMode(value) {for (const input of nearWallInputs()) input.checked = input.value === value;}
function syncNearWallOptions(disabled = false) {for (const input of nearWallInputs()) input.disabled = disabled;}

function beginWallRelocation() {
  finishHold();
  if (!selected || !placement.isWall(selected)) return;
  if (wallRelocation) return;
  setEditingWall(null);
  if (pending) pending.locked = false;
  wallRelocation = {id: selected, candidate: null, valid: false, target: null, message: '请选择目标墙面。中键拖动可调整视角。'};
  motionNotice = null; hovered = null;
  $('#wall-target').value = '';
  // Reveal complete walls while choosing; restore the user's original cutaway on exit.
  for (const root of room.children.filter((object) => /^Wall\d+$/.test(object.userData.name || object.name))) root.traverse((mesh) => {
    if (!mesh.isMesh) return;
    setLayer(mesh, 'wallChoice', WALL_CHOICE);
    wallChoiceMeshes.push(mesh);
  });
  syncNearWallOptions(true);
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
    showToast('请先在能容纳物品的墙面上选择位置');
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
  const message = !carried.ok ? carried.message : !contact.ok ? `这里会碰到${contact.other?.name || '其他物品'}，请在墙上另选一个位置。` : `${wallLabel(name)} · 可以放置。可用连续拖动工具调整，满意后确认。`;
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

const SELECTED = createSelectionHighlight(THREE);
function restoreMaterials() {
  for (const mesh of selectedMeshes) setLayer(mesh, 'selected', null);
  selectedMeshes.length = 0;
}

function select(id, announce = true) {
  finishHold();
  endWallRelocation();
  if (id !== null && !entities.has(id)) return;
  restoreMaterials();
  // The piece being arranged is shown solid, also against a see-through near wall.
  if (id) setSeeThrough(entities.get(id).group, false);
  selected = id;
  motionNotice = null;
  hovered = null;
  host.style.cursor = '';
  dropProjection.visible = dropGuide.visible = false; $('#drop-label').hidden = true;
  arrows.forEach((arrow) => {arrow.visible = false;});
  $('#selection-label').hidden = !id;
  for (const row of $('#object-list').querySelectorAll('[data-object]')) {
    const active = row.dataset.object === id;
    row.classList.toggle('active', active);
    row.setAttribute('aria-pressed', String(active));
  }
  if (id) {
    entities.get(id).group.traverse((mesh) => {
      if (!mesh.isMesh || mesh.userData.contactOnly) return;
      setLayer(mesh, 'selected', SELECTED);
      selectedMeshes.push(mesh);
    });
    $('#selection-label').classList.remove('just-selected');
    requestAnimationFrame(() => $('#selection-label').classList.add('just-selected'));
    if (announce) $('#status').textContent = `已选中${entities.get(id).name}，拖动或使用右侧连续拖动工具调整`;
  } else if (announce) $('#status').textContent = '点选物品，开始布置房间';
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
  if (!pending) beginSession(selected);
  if (pending) {pending.locked = true; if (motionNotice?.previewInvalid) layout = copyLayout(pending.lastReachable);}
  const frame = placement.isWall(selected) ? placement.wallFrame(selected, layout) : null;
  if (placement.isWall(selected) && ['forward', 'back'].includes(direction)) {changeWallInDirection(direction); return;}
  const axes = frame ? wallBasis(frame.tangent, basis()) : basis();
  if (!editObject((next) => move(next, selected, direction, Number($('#step').value), axes), direction)) finishHold();
}

function editObject(change, direction) {
  if (!selected || falling) return false;
  if (!pending) beginSession(selected);
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
    const name = typeof contact.other === 'string' ? (entities.get(contact.other)?.name || contact.other) : contact.other?.name || '其他物品';
    motionNotice = {id: selected, contactInvalid: !!installing, message: installing ? `这里会碰到${name}，请继续调整位置或高度` : restoringMount ? `原安装位置会碰到${name}，已保留当前位置` : `碰到${name}，已停止；请调整方向或高度`, other: contact.other, fraction: contact.fraction};
    showToast(motionNotice.message);
  }
  applyLayout();
  return !contact.blocked;
}

function startHold(direction, owner) {
  if (!ready || !selected || hold || wallRelocation) return;
  if (!pending) beginSession(selected);
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
  // The full stage stays fixed while panels open over it; only a real viewport resize refits projection.
  camera.aspect = width / height;
  if (camera.isOrthographicCamera) {
    camera.left = -cameraSpan * camera.aspect / 2; camera.right = cameraSpan * camera.aspect / 2;
    camera.top = cameraSpan / 2; camera.bottom = -cameraSpan / 2;
  }
  camera.clearViewOffset();
}

function useCamera(projection) {
  camera = projection === 'orthographic' ? planCamera : orbitCamera;
  controls.object = camera;
  alignCameraToStage();
}

function view(mode) {
  if (!ready) return;
  finishHold();
  activeView = mode;
  useCamera(mode === 'top' ? 'orthographic' : 'perspective');
  const span = Math.max(roomSize.x, roomSize.z);
  camera.up.set(0, 1, 0);
  camera.zoom = 1;
  cameraSpan = span * (host.clientWidth <= 740 ? 1.18 : 1.08) / Math.min(camera.aspect, 1);
  const distance = Math.max(12, roomSize.length() * 2);
  const target = new THREE.Vector3(center.x, floorY + Math.min(roomSize.y * .4, 1.2), center.z);
  if (mode === 'top') {
    target.y = floorY;
    camera.position.copy(target).add(new THREE.Vector3(0, distance, .001));
  } else if (mode === 'focus' && selected) {
    const bounds = new THREE.Box3().setFromObject(entities.get(selected).group);
    bounds.getCenter(target);
    const size = bounds.getSize(new THREE.Vector3());
    cameraSpan = Math.max(1.5, size.length() * 1.3) / Math.min(camera.aspect, 1);
    frameWorkspaceCamera(THREE, camera, {bounds: bounds.clone().expandByScalar(.08), target, direction: new THREE.Vector3(1, .9, 1)});
  } else {
    frameWorkspaceCamera(THREE, camera, {bounds: roomBounds, target, coverage: .94,
      direction: new THREE.Vector3(Math.sin(1.0)*Math.sin(.62), Math.cos(1.0), Math.sin(1.0)*Math.cos(.62))});
  }
  controls.target.copy(target);
  controls.update();
  alignCameraToStage();
  camera.updateMatrixWorld();
  for (const id of ['overview', 'top', 'focus']) {
    $(`#${id}`).classList.toggle('active', id === mode);
    $(`#${id}`).setAttribute('aria-pressed', String(id === mode));
  }
  workspace.update({view: activeView});
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
    if (!visible || seeThrough(hit.object)) continue;
    const material = Array.isArray(hit.object.material) ? hit.object.material[hit.face.materialIndex] : hit.object.material;
    if (material.clippingPlanes?.some((plane) => plane.distanceToPoint(hit.point) < 0)) continue;
    return hit.object.userData.editorId || null;
  }
  return null;
}

// A ray hit on something shown and solid: not hidden, see-through or clipped away.
function solidHit(hit) {
  for (let object = hit.object; object; object = object.parent) if (!object.visible) return false;
  if (seeThrough(hit.object)) return false;
  const material = Array.isArray(hit.object.material) ? hit.object.material[hit.face.materialIndex] : hit.object.material;
  return !material.clippingPlanes?.some((plane) => plane.distanceToPoint(hit.point) < 0);
}

// The part that opens at a screen point ({x, y} from -1 to 1), in 预览 or 漫游 (see joints.mjs).
function openableAt(at, view = camera) {
  if (!ready || !hinged) return null;
  view.updateMatrixWorld();
  raycaster.setFromCamera(new THREE.Vector2(at.x, at.y), view);
  for (const hit of raycaster.intersectObject(room, true)) if (solidHit(hit)) return openableOf(hit.object);
  return null;
}

function pickOpenable(clientX, clientY) {
  const rect = host.getBoundingClientRect();
  return openableAt({x: (clientX - rect.left) / rect.width * 2 - 1, y: -(clientY - rect.top) / rect.height * 2 + 1});
}

function bindEvents() {
  $('#ground-grid').onchange = requestRender;
  const toolsMenu = $('#tools-menu');
  document.addEventListener('click', event => {if (!toolsMenu.contains(event.target)) toolsMenu.open = false;});
  toolsMenu.addEventListener('keydown', event => {if (event.key === 'Escape') {toolsMenu.open = false; event.stopPropagation();}});
  $('#change-wall').onclick = () => {
    if (!pending && selected) beginSession(selected);
    if (wallRelocation) {endWallRelocation(); if (pending) pending.locked = true; updateInspector(); $('#status').textContent = '已取消换墙，原位置保持不变';}
    else beginWallRelocation();
  };
  $('#wall-target').onchange = () => {
    const target = placement.wallTargets().find((wall) => wall.name === $('#wall-target').value);
    if (!wallRelocation) return;
    if (!target) {
      clearWallGhost();
      wallRelocation = {...wallRelocation, candidate: null, valid: false, target: null, message: '请选择目标墙面。中键拖动可调整视角。'};
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
  window.addEventListener('blur', finishHold);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {staticLighting?.pause(); finishHold();}
    else {staticLighting?.resume(); requestRender();}
  });
  $('#step').addEventListener('change', finishHold);
  $('#rotate-left').onclick = () => act(() => editObject((next) => rotate(next, selected, Math.PI / 12), 'rotate'));
  $('#rotate-right').onclick = () => act(() => editObject((next) => rotate(next, selected, -Math.PI / 12), 'rotate'));
  $('#settle-object').onclick = () => act(() => {if (editObject(() => {}, 'settle')) showToast(placementStates.get(selected).label);});
  $('#reset-object').onclick = () => act(() => editObject((next) => {next[selected] = {x: 0, y: 0, z: 0, yaw: 0};}, 'reset'));
  $('#reset-layout').onclick = async () => {
    if (!await workspace.confirm('恢复原始布置？', '房间中的物品将回到扫描时的位置，后来添加的物品会被收起。完成后可以撤销。', '恢复原始布置')) return;
    joysticks?.stop(); cancelSession(false); select(null, false); hasEdited = true;
    act(() => {layout = {...initialLayout(roomIds), ...Object.fromEntries(Object.keys(addedPart(layout)).map((id) => [id, stored()]))};});
    persist(); showToast('已恢复原始布置，可撤销'); $('#project-menu').open = false;
  };
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
  $('#redo').onclick = redo;
  $('#close-inspector').onclick = () => {if (pending) cancelSession(); else select(null);};
  $('#exit-walk').onclick = () => setMode('preview');
  document.addEventListener('keydown', (event) => {
    if (event.target.closest('dialog')) return;
    if (mode === 'walk') return;
    if (ready && pending && event.key === 'Escape') {event.preventDefault(); cancelSession(); return;}
    if (ready && event.key === 'Escape' && wallRelocation) {
      event.preventDefault(); endWallRelocation(); updateInspector(); $('#status').textContent = '已取消换墙，原位置保持不变'; return;
    }
    if (!ready || event.target.closest('input,select,textarea,[contenteditable="true"]')) return;
    if (event.key === '/' && !event.metaKey && !event.ctrlKey) {event.preventDefault(); warehouse.setOpen(true); $('#search').focus(); return;}
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault(); event.shiftKey ? redo() : undo(); return;
    }
    if (event.key === 'Escape') {
      warehouse.setOpen(false); select(null); return;
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
  for (const input of nearWallInputs()) input.onchange = requestRender;
  $('#ceiling').onchange = () => {ceilingObjects.forEach((object) => {object.visible = $('#ceiling').checked;}); renderer.shadowMap.needsUpdate = true; requestRender();};
  $('#import-lighting').checked = query.get('materials') !== 'original';
  $('#import-lighting').onchange = () => {
    if (pending) {$('#import-lighting').checked = !$('#import-lighting').checked; showToast('请先确认或取消当前摆放，再切换受光模式'); return;}
    select(null);
    const imported = [...entities.values()].filter(entity => entity.importMaterials);
    for (const entity of imported) entity.importMaterials.setMode($('#import-lighting').checked ? 'pbr' : 'original');
    if (imported.length) renderFurnitureThumbnails(imported);
    renderer.shadowMap.needsUpdate = true; requestRender();
  };
  $('#export-layout').onclick = (event) => {
    if (!ready || !isExplicitExport(event)) return;
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
  // Only a drag that starts on an already selected object moves it. A first click only inspects.
  renderer.domElement.addEventListener('pointerdown', (event) => {
    if (event.button === 1) event.preventDefault(); // Rotate the camera without the browser's middle-button autoscroll.
    if (event.button !== 0 || !event.isPrimary) {pointerStart = null; return;}
    pointerStart = {x: event.clientX, y: event.clientY, id: event.pointerId, dragged: false};
    if (mode === 'edit' && selected && !falling && !wallRelocation && (!pending || pending.locked) && pick(event.clientX, event.clientY) === selected) {
      pointerStart.moveObject = selected;
      // Use the same floor projection at press and drag, so grabbing an edge does not jump.
      const {point} = placementPoint(event.clientX, event.clientY), entity = entities.get(selected);
      pointerStart.grab = point ? {x: point.x - entity.origin.x - layout[selected].x, z: point.z - entity.origin.z - layout[selected].z} : null;
      controls.enabled = false;
      renderer.domElement.setPointerCapture(event.pointerId);
    }
  }, {capture: true});
  renderer.domElement.addEventListener('pointermove', (event) => {
    if (mode === 'walk') return;
    if (pointerStart && Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 5) pointerStart.dragged = true;
    if (pointerStart?.moveObject && pointerStart.dragged && event.buttons) {
      if (!pending) beginSession(pointerStart.moveObject);
      workspace.setTool('move'); analogActive = true;
      followPointer(event.clientX, event.clientY, true, pointerStart.grab);
      host.style.cursor = 'grabbing';
      return;
    }
    if (event.buttons || event.pointerType !== 'mouse') return;
    if (pending && !pending.locked) {
      if (performance.now() - lastHoverTime < 60) return;
      lastHoverTime = performance.now(); followPointer(event.clientX, event.clientY); return;
    }
    if (performance.now() - lastHoverTime < 45) return;
    lastHoverTime = performance.now();
    if (wallRelocation) {host.style.cursor = pickWall(event.clientX, event.clientY) ? 'crosshair' : ''; return;}
    if (mode === 'preview') {showOpenHint(pickOpenable(event.clientX, event.clientY), event.clientX, event.clientY); return;}
    const id = pick(event.clientX, event.clientY);
    host.style.cursor = id ? 'pointer' : '';
    hovered = id;
    // Hover only changes the DOM cursor. Keep the settled frame and its AO cache intact.
  });
  renderer.domElement.addEventListener('pointerup', (event) => {
    if (mode === 'walk') {pointerStart = null; return;}
    if (pointerStart?.id === event.pointerId && pointerStart.moveObject) {
      const moved = pointerStart.dragged;
      pointerStart = null; analogActive = false; releaseOrbit();
      if (renderer.domElement.hasPointerCapture(event.pointerId)) renderer.domElement.releasePointerCapture(event.pointerId);
      if (moved) {if (pending) pending.locked = true; validateAfterRender();}
      return;
    }
    if (pointerStart?.id === event.pointerId && !pointerStart.dragged && event.button === 0) {
      if (pending && wallRelocation) {
        const target = pickWall(event.clientX, event.clientY);
        if (target) {previewWall(target.name, target.point); lockWallPreview();}
        else showToast('请点击墙面实体部分；中键拖动可以调整视角');
      } else if (pending && !pending.locked) {
        followPointer(event.clientX, event.clientY);
        pending.locked = true; updateInspector();
      } else if (wallRelocation) {
        const target = pickWall(event.clientX, event.clientY);
        if (target) previewWall(target.name, target.point); else showToast('请点击墙面实体部分；中键拖动可以调整视角');
      } else if (mode === 'edit') {const id = pick(event.clientX, event.clientY); if (id) inspectObject(id); else if (!pending) select(null);}
      else if (mode === 'preview') {const part = pickOpenable(event.clientX, event.clientY); if (part) {hinged.toggle(part); showOpenHint(part, event.clientX, event.clientY);}}
    }
    pointerStart = null;
  });
  const finishPointerDrag = () => {
    const moved = pointerStart?.moveObject && pointerStart.dragged;
    pointerStart = null; analogActive = false; releaseOrbit();
    if (moved && pending) {pending.locked = true; validateAfterRender();}
  };
  renderer.domElement.addEventListener('pointercancel', finishPointerDrag);
  renderer.domElement.addEventListener('lostpointercapture', () => {if (pointerStart?.moveObject) finishPointerDrag();});
  window.addEventListener('blur', finishPointerDrag);
  renderer.domElement.addEventListener('pointerleave', () => {hovered = null; hideOpenHint();});
  window.addEventListener('pagehide', () => {joysticks?.stop(); finishHold(); persist();});
}

function groupScene(gltf, originalMatrices) {
  // Validate all required names first; never silently publish a partly editable scene.
  const assigned = new Set();
  for (const spec of config.catalog) for (const name of spec.roots) {
    if (assigned.has(name)) throw new Error(`物品重复归组 ${name}`);
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
    entities.set(spec.id, {...spec, group, origin, sizeLabel, dimensions: dimensions.toArray()});
  }
  room.updateMatrixWorld(true);
  let groupingError = 0;
  for (const [object, matrix] of originalMatrices) {
    matrix.elements.forEach((value, i) => {groupingError = Math.max(groupingError, Math.abs(value - object.matrixWorld.elements[i]));});
  }
  if (groupingError > 1e-6) throw new Error('物品归组改变了原始位置');
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
    row.setAttribute('aria-label', `${entity.name}，查看与布置`);
    row.innerHTML = `<span class="warehouse-state">在房间</span><img class="object-thumb" alt="" width="${THUMBNAIL_SIZE.width}" height="${THUMBNAIL_SIZE.height}"><span class="object-copy"><strong>${entity.name}</strong><small>${entity.category}</small></span><span class="object-dot" aria-hidden="true"></span>`;
    row.onclick = () => {
      inspectObject(entity.id);
    };
    let card = row;
    if (entity.added) {
      card = document.createElement('div'); card.className = 'rc-imported-card';
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'rc-remove-object';
      remove.dataset.removeObject = entity.id;
      remove.setAttribute('aria-label', `删除${entity.name}这一份`);
      remove.title = '删除这一份物品，保留重建结果';
      remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/></svg>';
      remove.onclick = () => removeImportedObject(entity.id);
      card.append(row, remove);
    }
    if (first) $('#object-list').prepend(card); else $('#object-list').appendChild(card);
}

function inspectObject(id) {
  if (!ready || falling) return;
  if (pending) {showToast('请先确认或取消当前调整，再选择另一件物品'); return;}
  if (mode !== 'edit') setMode('edit');
  if (workspace.density === 'simple' || innerWidth <= 1100) warehouse.setOpen(false);
  if (layout[id].visible === false) {workspace.setTool('move'); beginSession(id);}
  else select(id);
}

function removeImportedObject(id) {
  if (!ready || !entities.get(id)?.added) return;
  if (falling || gesture || gestureView || gestureScale || analogActive || hold || (pending && pending.id !== id)) {
    showToast('请先结束当前操作，再删除这份物品'); return;
  }
  cancelSession(false); select(null, false); cancelValidation(); setMode('edit');
  const entity = forgetImportedObject(id, {entities, ids, layout, placementSpecs, history});
  const row = $(`[data-object="${id}"]`);
  (row.closest('.rc-imported-card') || row).remove();
  entity.group.removeFromParent();
  setSeeThrough(entity.group, false);
  entity.importMaterials.dispose(); disposeObjectTree(entity.group);
  placementStates.delete(id); dropPlan = null;
  placement = createPlacement(THREE, room, entities, placementSpecs, floorY, ceilingY, {openings: config.openings});
  rebuildCollision(); applyLayout(); persist();
  if ($('#search').value) $('#search').dispatchEvent(new Event('input'));
  $('#status').textContent = `已删除${entity.name}这一份，重建结果仍保留`;
  showToast('已删除这一份，可从“导入物品”重新添加');
}

function renderFurnitureThumbnails(list = entities.values()) {
  list = [...list];
  // Render the actual grouped model, sharing its geometry/materials without mutating them.
  // One temporary context serves the entire shelf and is released after rendering.
  const previewRenderer = new THREE.WebGLRenderer({antialias: true, alpha: true, preserveDrawingBuffer: true});
  previewRenderer.setClearColor(0x000000, 0);
  previewRenderer.setSize(THUMBNAIL_SIZE.width, THUMBNAIL_SIZE.height);
  previewRenderer.outputColorSpace = renderer.outputColorSpace;
  previewRenderer.toneMapping = renderer.toneMapping;
  previewRenderer.toneMappingExposure = renderer.toneMappingExposure;
  const previewScene = new THREE.Scene();
  (lightingRig?.previewLights() || scene.children.filter(object => object.isLight).map(light => light.clone())).forEach(light => previewScene.add(light));
  const previewCamera = new THREE.PerspectiveCamera(36, THUMBNAIL_SIZE.width / THUMBNAIL_SIZE.height, .01, 1000);
  let previewEnvironment = null;
  try {
    // Render-target textures belong to one WebGL context. Generate a tiny environment
    // in the preview context only for an explicit imported-PBR thumbnail batch.
    if (environmentFactory && scene.environment && list.some(entity => entity.importMaterials?.snapshot().mode === 'pbr')) {
      try {previewEnvironment = environmentFactory(previewRenderer, previewScene, {intensity: scene.environmentIntensity});}
      catch (error) {console.warn('缩略图环境不可用，继续使用原灯光。', error);}
    }
    for (const entity of list) {
      const bounds = new THREE.Box3().setFromObject(entity.group);
      const target = bounds.getCenter(new THREE.Vector3());
      const size = bounds.getSize(new THREE.Vector3());
      const model = entity.group.clone(true);
      model.matrixAutoUpdate = false;
      model.matrix.copy(entity.group.matrixWorld).premultiply(new THREE.Matrix4().makeTranslation(-target.x, -target.y, -target.z));
      previewScene.add(model);
      frameThumbnailCamera(THREE, previewCamera, size);
      previewRenderer.render(previewScene, previewCamera);
      $(`[data-object="${entity.id}"] .object-thumb`).src = previewRenderer.domElement.toDataURL('image/png');
      previewScene.remove(model);
    }
  } finally {
    previewEnvironment?.dispose();
    previewRenderer.dispose();
    previewRenderer.forceContextLoss();
  }
}

function restoreGhostMaterials() {
  for (const mesh of previewLayers.keys()) setLayer(mesh, 'preview', null);
  previewLayers.clear();
  if (renderer) renderer.shadowMap.needsUpdate = true;
}

// A piece still where it was, resting there, needs no new drop check: that pose was checked
// when it was placed. Selecting it, or confirming without moving it, is then immediate.
function planDrop(options) {
  const before = pending.before[selected], now = layout[selected], state = placementStates.get(selected);
  const inPlace = before.visible !== false && state?.state === 'stable' && ['x', 'y', 'z', 'yaw'].every((key) => Math.abs((now[key] || 0) - (before[key] || 0)) < 1e-9);
  if (!inPlace) return background?.ready && !options?.previewOnly ? backgroundDrop() : predictDrop(selected, layout, placement, collision, options);
  const label = state.label.replace(/^已放稳 · /, '');
  return {ok: true, checked: true, candidate: copyLayout(layout), moved: [selected], state, height: state.height, label, distance: 0, message: `保持在${label}`};
}

// The full collision check of a drop runs in collision-worker.mjs, so a heavy piece does not freeze
// the room or the hand. Until its answer for this exact layout arrives the plan is unchecked: shown
// as the expected landing, not confirmable. Only the latest request is kept while one runs.
let background = null;
function startBackgroundCollision(owners) {
  const generation = (background?.generation || 0) + 1;
  background ||= {worker: new Worker(new URL('./collision-worker.mjs', import.meta.url), {type: 'module'}), tickets: 0, busy: null, queued: null};
  Object.assign(background, {generation, ready: false, busy: null, queued: null});
  const {owners: packed, transfer} = packOwners(owners);
  background.worker.onmessage = ({data}) => {
    if (data.generation !== background.generation) return;
    if (data.type === 'built') {background.ready = true; return;}
    const job = background.busy;
    background.busy = null;
    if (job?.ticket === data.ticket) job.resolve(data);
    sendBackground();
  };
  background.worker.onerror = (error) => {console.error(error); background.ready = false;};
  background.worker.postMessage({type: 'build', generation, owners: packed, keepAuthoredOverlaps: true}, transfer);
}
function sendBackground() {
  if (background.busy || !background.queued) return;
  const job = background.busy = background.queued;
  background.queued = null;
  background.worker.postMessage({type: 'drop', generation: background.generation, ticket: job.ticket, candidate: job.candidate, moved: job.moved, source: job.source});
}
function backgroundDrop() {
  const key = JSON.stringify([selected, layout]);
  if (pending.verdict?.key === key) return pending.verdict.plan;
  const start = dropStart(selected, layout, placement);
  if (start.result) return start.result;
  const {base} = start, session = pending;
  if (session.checking !== key) {
    // A confirmation waiting for an earlier pose does not carry over to a new one.
    session.checking = key; session.placeWhenChecked = false;
    background.queued?.resolve(null);
    new Promise((resolve) => {background.queued = {ticket: ++background.tickets, candidate: base.candidate, moved: base.moved, source: copyLayout(layout), resolve}; sendBackground();})
      .then((answer) => {
        if (!answer || pending !== session || session.checking !== key) return;
        session.checking = null;
        session.verdict = {key, plan: dropVerdict(base, answer.contact, answer.sweep)};
        if (analogActive || falling || JSON.stringify([selected, layout]) !== key) return;
        applyLayout();
        if (session.placeWhenChecked && pending === session) {
          session.placeWhenChecked = false;
          if (session.valid) confirmSession(); else showToast(session.message);
        }
      });
  }
  return {...base, ok: true, checked: false, message: `预计落到${base.state.label.replace(/^已放稳 · /, '')} · 正在检查碰撞`};
}

function refreshSession() {
  if (!pending) return;
  const state = placementStates.get(selected);
  const installing = pending.before[selected].visible === false;
  dropPlan = pending.gravity ? planDrop({previewOnly:analogActive}) : null;
  const contact = !analogActive && !pending.gravity && (installing || placement.isWall(selected)) ? collision.checkPlacement(layout, [selected]) : null;
  const valid = !analogActive && (pending.gravity ? dropPlan.ok && dropPlan.checked !== false : state?.state === 'stable' && !motionNotice?.previewInvalid && !motionNotice?.contactInvalid && (!contact || contact.ok));
  if (valid) pending.lastReachable = copyLayout(layout);
  pending.update(layout, valid, pending.gravity ? dropPlan.message : contact && !contact.ok ? `这里会碰到${contact.other?.name || '其他物品'}，请选择其他位置` : motionNotice?.message || state?.label || '等待落位');
  const moved = ids.filter(id => id === selected || ['x','y','z','yaw'].some(key => Math.abs((layout[id][key] || 0) - (pending.before[id][key] || 0)) > 1e-9));
  const color = analogActive || (dropPlan?.checked === false && dropPlan.ok) ? 0xb39a62 : valid ? 0x62c6b1 : 0xed766b;
  const activeMeshes = new Set();
  for (const id of moved) entities.get(id).group.traverse(mesh => {
    if (!mesh.isMesh || mesh.userData.contactOnly) return;
    activeMeshes.add(mesh);
    const layer = previewLayers.get(mesh);
    if (!layer) {
      // The layer remembers its colour: when a layer under it changes, it is made again.
      const fresh = {color, castShadow: false, material() {return new THREE.MeshBasicMaterial({color: this.color, transparent: true, opacity: .34, depthWrite: false, side: THREE.DoubleSide});}};
      previewLayers.set(mesh, fresh); setLayer(mesh, 'preview', fresh);
      renderer.shadowMap.needsUpdate = true;
    } else if (layer.color !== color) {
      // The preview is the top layer and replaces the material outright, so what shows is its own.
      layer.color = color;
      for (const material of [mesh.material].flat()) material.color.setHex(color);
    }
  });
  for (const mesh of [...previewLayers.keys()]) {
    if (activeMeshes.has(mesh)) continue;
    setLayer(mesh, 'preview', null); previewLayers.delete(mesh);
    renderer.shadowMap.needsUpdate = true;
  }
}

function updateSessionUI() {
  updatePlacementPanel({pending, wall:selected && placement?.isWall(selected), wallRelocation, value:selected && layout[selected]});
  $('#store-object').hidden = !selected || (pending?.before[selected] || layout[selected])?.visible === false;
  $('#store-object').disabled = !!falling;
  $('#settle-object').hidden = !!pending?.gravity;
  if (pending?.gravity) {
    $('#confirm-placement').textContent = falling ? '正在放置…' : dropPlan?.checked === false && dropPlan.ok ? '检查中…' : '确认放置';
    $('#confirm-placement').disabled = !!falling || !pending.valid;
    $('#interaction-help').textContent = '拖动物品或使用右侧工具调整 · Enter 确认 · Esc 取消';
  } else $('#confirm-placement').textContent = '确认放置';
  // With gestures on, the hint says how the hand works.
  if (handsOn()) $('#interaction-help').textContent = GESTURE_HELP[gestureMode];
}

function beginSession(id) {
  if (!ready || !entities.has(id)) return;
  cancelSession(false);
  setMode('edit');
  select(id, false);
  pending = new PlacementSession(layout, id, true);
  pending.gestureId = String(++previewSerial);
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
    // Still being checked in the background: drop it as soon as the answer allows.
    if (dropPlan.checked === false) {pending.placeWhenChecked = true; showToast('正在检查碰撞，检查完自动放下'); applyLayout(); return;}
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
  workspace.completed();
  $('#status').textContent = `已放置${name} · 可撤销或重新摆放`;
  showToast('物品已放置，布局已保存');
}

// 抓取和相机环绕后的重定位必须使用同一投影，否则承托面高度会造成跳动。
function placementPoint(clientX, clientY) {
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
  return {point, target};
}

function followPointer(clientX, clientY, force = false, grab = null) {
  if (!pending || (pending.locked && !force)) return;
  if (placement.isWall(selected)) {
    if (!wallRelocation) beginWallRelocation();
    const hit = pickWall(clientX, clientY);
    if (hit) previewWall(hit.name, hit.point);
    updateSessionUI();
    return;
  }
  const {point, target} = placementPoint(clientX, clientY);
  if (!point) return;
  const before = pending.lastReachable, next = copyLayout(before), entity = entities.get(selected);
  delete next[selected].visible;
  // grab: where on the piece the hand took hold, so it does not jump to centre under the hand.
  next[selected].x = point.x - entity.origin.x - (grab?.x || 0);
  next[selected].z = point.z - entity.origin.z - (grab?.z || 0);
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
    if (contact.blocked) motionNotice = {id:selected, previewInvalid:relocating, message:`碰到${contact.other?.name || '物品'}，请调整预览位置`};
    if (!contact.blocked || pending.before[selected].visible !== false) pending.lastReachable = copyLayout(layout);
  }
  applyLayout();
  host.style.cursor = pending.valid ? 'crosshair' : 'not-allowed';
}

const OPEN_HELP = '点击门窗体验开合 · 中键拖动旋转 · 右键拖动平移 · 滚轮缩放';
function setMode(nextMode) {
  if (nextMode === 'walk' && !walk) return;
  if (pending && nextMode !== 'edit') {showToast('请先确认或取消当前调整，再进入体验'); return;}
  hideOpenHint();
  if (nextMode !== 'edit') {cancelSession(false); select(null, false); warehouse.setOpen(false);}
  // Furniture is placed against the closed shapes; doors shut on the way back to arranging.
  else hinged?.closeAll();
  if (nextMode === 'walk' && !walk.active) {walkFrom = mode; enterWalk();}
  else if (nextMode !== 'walk' && walk?.active) exitWalk();
  mode = nextMode;
  if (mode === 'walk') walkHelp();
  else if (hinged?.parts.length) $('#interaction-help').textContent = mode === 'preview' ? OPEN_HELP : handsOn() ? GESTURE_HELP[gestureMode] : MOUSE_HELP;
  else $('#interaction-help').textContent = handsOn() ? GESTURE_HELP[gestureMode] : MOUSE_HELP;
  $('#rc-placement-demo').dataset.mode = mode;
  alignCameraToStage();
  for (const button of document.querySelectorAll('button[data-mode]')) button.setAttribute('aria-pressed', String(button.dataset.mode === mode || button.dataset.mode === 'preview' && mode === 'walk'));
  workspace.update({mode});
  requestRender();
}

// The orbiting camera comes back when nothing else is steering the view: not while walking (the
// gesture page can still send gestures then), nor while a hand still turns or scales the scene.
function releaseOrbit() {controls.enabled = !walk?.active && !gesture && !gestureView && !gestureScale;}

// 漫游: the ceiling is shown (as in the room itself), gestures and the orbiting camera rest.
function enterWalk() {
  if (gestureCamera?.on) {gestureCamera.stop(); showGestures(false);}
  controls.enabled = false;
  for (const object of ceilingObjects) object.visible = true;
  renderer.shadowMap.needsUpdate = true;
  walk.resize(host.clientWidth, host.clientHeight);
  walk.enter();
}
function exitWalk() {
  walk.exit();
  releaseOrbit();
  for (const object of ceilingObjects) object.visible = $('#ceiling').checked;
  renderer.shadowMap.needsUpdate = true;
  hideOpenHint();
}
function walkHelp() {
  $('#interaction-help').textContent = 'WASD / 方向键走动 · Shift 快走 · Q / E 升高、降低视线 · 中键拖动转头 · 点门、柜门开关 · Esc 退出';
}
function walkAim(at, event) {
  if (performance.now() - walkAimAt < 120) return;
  walkAimAt = performance.now();
  showOpenHint(openableAt(at, walk.camera), event.clientX, event.clientY);
}

// Over something that opens, in 预览 and 漫游: a hand, and beside it what it is and what a click does.
function openHintText(part) {
  const {node, object, type, axis} = part.joint, open = hinged.isOpen(part);
  const category = config.label(object);
  const name = /drawer/i.test(node) ? '抽屉' : /lift/i.test(node) ? '升降桌面' : /lid|fallboard/i.test(node) ? '盖板'
    : category === '门' || category === '窗户' ? category : /door/i.test(node) ? '柜门' : category;
  const lifts = type === 'prismatic' && Math.abs(axis[1]) > .9;
  return `${name} · 点击${lifts ? (open ? '降下' : '升起') : open ? '关上' : '打开'}`;
}
function showOpenHint(part, clientX, clientY) {
  host.style.cursor = part ? 'pointer' : '';
  const hint = $('#open-hint');
  hint.hidden = !part;
  if (!part) return;
  hint.textContent = openHintText(part);
  const rect = host.getBoundingClientRect();
  hint.style.left = `${clientX - rect.left + 14}px`; hint.style.top = `${clientY - rect.top + 18}px`;
}
const hideOpenHint = () => {$('#open-hint').hidden = true; host.style.cursor = '';};

function storeObjects(id = null) {
  cancelSession(false);
  act(() => {
    const targets = id ? placement.carry(id, layout, copyLayout(layout)).moved || [id] : ids;
    for (const item of targets) layout[item] = {...layout[item], visible:false};
  });
  select(null, false);
  workspace.showStored();
  if (!id) warehouse.setOpen(true);
  showToast(id ? '已收纳，可在物品库放回或撤销' : '物品已全部收起，可在物品库放回或撤销');
}

function bindPlacementEvents() {
  bindPlacementPanel({
    confirm: confirmSession,
  cancel: cancelSession,
    cancel: () => cancelSession(),
    lock: () => {
      if (!pending) return;
      if (wallRelocation) {lockWallPreview(); return;}
      pending.locked = !pending.locked;
      if (!pending.locked && placement.isWall(selected)) beginWallRelocation();
      updateSessionUI();
    },
    store: () => storeObjects(selected),
    clear: async () => {
      if (!await workspace.confirm('收起全部物品？', '可移动物品会进入物品库的“已收纳”，房间结构保留。之后可以逐件放回，也可以撤销。', '全部收起')) return;
      storeObjects(); $('#project-menu').open = false;
    },
    setMode,
  });
}

// 右手操作家具、左手环绕独立进行；双手缩放时相机只接受缩放。
// 松手只固定预览；显式确认才落下和保存，丢手也不提交。
let gestureMode = 'move', gesture = null, gestureFrame = 0, gestureView = null, gestureScale = null, handHover = null;
const handPointer = Object.assign(document.createElement('div'), {className: 'rc-hand-pointer', hidden: true});
const leftPointer = Object.assign(document.createElement('div'), {className: 'rc-hand-pointer rc-left-pointer', hidden: true});
const fingerOverlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
fingerOverlay.classList.add('rc-finger-overlay'); fingerOverlay.setAttribute('aria-hidden', 'true');
for (const role of ['operator','helper']) {
  const group = document.createElementNS(fingerOverlay.namespaceURI, 'g'); group.dataset.hand = role;
  group.innerHTML = '<line/><circle data-tip="thumb" r="6"/><circle data-tip="index" r="6"/>';
  group.style.display = 'none'; fingerOverlay.appendChild(group);
}
document.body.append(fingerOverlay, handPointer, leftPointer);
const GESTURE_HELP = {view: '观察：左手捏合环绕，松开固定视角',
  move: '1 平面移动：保持当前高度，松手保留预览；右手拇指向上约 0.5 秒确认，向下取消并回原位',
  height: '2 上下移动：松手保持悬空，可切到 1 平移；右手竖拇指约 0.5 秒确认',
  scale: '3 场景缩放：双手捏合后拉开或靠近；缩放期间暂停左手环绕',
  rotate: '4 连续旋转：右手横移一画面宽度对应 1080°；松手预览，右手竖拇指确认'};
// The middle of the camera image covers the whole editor, so a hand reaches the page's edges
// without going to the image's edges, where hand tracking is least reliable.
const HAND_GAIN = 1.3;
const handPoint = ({u, v}) => ({u: Math.min(1, Math.max(0, (u - .5) * HAND_GAIN + .5)), v: Math.min(1, Math.max(0, (v - .5) * HAND_GAIN + .5))});
function handClient(hand) {
  const {u, v} = handPoint(hand);
  return {x: u * innerWidth, y: v * innerHeight};
}
// What the hand points at: a warehouse card, a control, the room, or a panel's background.
// A hand pointer shakes and slips as the fingers close, so a control within HAND_REACH pixels
// counts as pointed at, and a pinch that starts just off a control presses the one the hand was
// on a moment before (see gesturePort.begin).
const HAND_REACH = 24, HAND_SLIP_MS = 300, HAND_AIM_MS = 250, CONTROLS = 'button, summary, a[href], label, .object-row';
const asTarget = (element) => element.matches('.object-row') ? {kind: 'shelf', element, id: element.dataset.object} : {kind: 'control', element};
function nearestControl(x, y) {
  let best = null, distance = HAND_REACH;
  for (const element of document.querySelectorAll(CONTROLS)) {
    if (!canGestureActivate(element)) continue;
    const r = element.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const d = Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
    if (d < distance) {best = element; distance = d;}
  }
  return best;
}
// reach: let a nearby control win, except over furniture (the toolbar floats over the room) and
// never while dragging a piece.
function handTarget({x, y}, reach = true) {
  const element = document.elementFromPoint(x, y);
  const control = element?.closest('.object-row') || element?.closest(CONTROLS);
  if (control) return canGestureActivate(control) ? asTarget(control) : {kind: 'none'};
  const panel = !element || element.closest('.rc-controls, .rc-tools, .rc-view-tools, .rc-menu-panel, .rc-help, .rc-shelf, .rc-gesture-card, header, footer');
  const room = !panel && !!element.closest('.rc-stage');
  const near = reach && nearestControl(x, y);
  if (near && !(room && pick(x, y))) return asTarget(near);
  return room ? {kind: 'room'} : {kind: 'none'};
}
// The control the hand rested on (since: when it arrived; at: last frame on it). A pinch presses
// it when the fingers slip off onto empty space, or onto a neighbour after resting on it a while.
let lastHover = null;
function pinchTarget(point) {
  const target = handTarget(point), now = performance.now();
  const recent = lastHover && canGestureActivate(lastHover.target.element) && now - lastHover.at < HAND_SLIP_MS;
  if (recent && (target.kind === 'room' || target.kind === 'none' || lastHover.at - lastHover.since >= HAND_AIM_MS)) return lastHover.target;
  return target;
}
function pressControl(target) {
  if (!canGestureActivate(target.element)) return;
  target.element.click();
}
function gestureStep(step) {
  if (!gesture) return;
  gesture.step = step;
  // Frames arrive faster than a heavy piece can be checked; apply only the latest one.
  gestureFrame ||= requestAnimationFrame(() => {gestureFrame = 0; const next = gesture?.step; if (next) {gesture.step = null; next();}});
}
function endGesture() {
  cancelAnimationFrame(gestureFrame); gestureFrame = 0;
  gesture = null; analogActive = false; releaseOrbit();
  delete handPointer.dataset.label;
}
// 与移动使用同一承托面投影，保持手与物体的抓取偏移。
function surfaceUnder({x, y}) {return placementPoint(x, y).point;}
// 换拿家具不能隐式确认当前悬空预览。
function canTakeAnotherPiece() {
  if (!pending) return true;
  const name = entities.get(pending.id).name;
  showToast(`请先确认${name}的预览或取消，再拿另一件物品`);
  return false;
}
// Both projections report the visible world span at the orbit target.
function cameraState() {
  controls.update(); camera.updateMatrixWorld();
  const orbit = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
  return {theta: orbit.theta, phi: orbit.phi, radius: orbit.radius, zoom: camera.zoom, minPhi: Math.min(.02, orbit.phi), maxPhi: controls.maxPolarAngle,
    target: controls.target.toArray(), right: new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).toArray(),
    up: new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).toArray(),
    ...workspaceViewSize(camera, orbit.radius)};
}
function applyCamera(pose) {
  controls.target.fromArray(pose.target);
  camera.position.setFromSpherical(new THREE.Spherical(pose.radius, pose.phi, pose.theta)).add(controls.target);
  camera.zoom = pose.zoom; camera.updateProjectionMatrix();
  controls.update();
  // 左手环绕后会立即重算右手抓取偏移，不能等到渲染才同步相机矩阵。
  // OrbitControls 的 lookAt 更新朝向，但射线投影读取的是 matrixWorld。
  camera.updateMatrixWorld();
  requestRender();
}
function flushGestureMotion() {
  cancelAnimationFrame(gestureFrame); gestureFrame = 0;
  const step = gesture?.step; if (gesture) gesture.step = null; step?.();
}
function rebaseGesture() {
  if (!gesture || gesture.kind !== 'move' || !gesture.lastHand || gesture.carrying) return;
  const under = surfaceUnder(handClient(gesture.lastHand)), entity = entities.get(gesture.id);
  if (under) gesture.grab = {x:under.x - entity.origin.x - layout[gesture.id].x, z:under.z - entity.origin.z - layout[gesture.id].z};
}
const gesturePort = {
  blocked: () => !ready || !!falling || !!pending?.placeWhenChecked,
  mode: () => gestureMode,
  begin(hand, kind) {
    const point = handClient(hand), target = pinchTarget(point);
    if (target.kind === 'control') {pressControl(target); return false;}
    if (target.kind === 'none') return false;
    const track = {step: null, kind, start: {u: hand.u, v: hand.v}};
    if (target.kind === 'shelf') {
      if (kind !== 'move') {showToast('从物品库拖出请先切到移动模式（左手 1）'); return false;}
      if (pending?.id !== target.id && !canTakeAnotherPiece()) return false;
      // The piece hangs on the hand; it enters the room only when the hand does.
      warehouse.setOpen(false);
      gesture = {...track, id: target.id, carrying: true};
      handPointer.dataset.label = entities.get(target.id).name;
      $('#status').textContent = `拖着${entities.get(target.id).name} · 移进房间`;
      return true;
    }
    let id = pick(point.x, point.y);
    // A pinch on the preview, or on empty floor while there is one, keeps working on it.
    if (pending && (!id || id === pending.id)) id = pending.id;
    if (!id) {$('#status').textContent = '没有指到物品：指向物品或物品库卡片后再捏合'; return false;}
    if (kind === 'rotate' && placement.isWall(id)) {showToast('壁挂物件保持安装朝向'); return false;}
    const placing = pending?.id === id;
    if (!placing && !canTakeAnotherPiece()) return false;
    if (!placing) beginSession(id);
    if (!pending) return false;
    analogActive = true; controls.enabled = false;
    const under = surfaceUnder(point), entity = entities.get(id);
    const grab = under && {x: under.x - entity.origin.x - layout[id].x, z: under.z - entity.origin.z - layout[id].z};
    gesture = {...track, id, grab, yaw: layout[id].yaw, height:layout[id].y || 0, lastHand:hand};
    $('#status').textContent = `${kind === 'move' ? '移动' : kind === 'height' ? '调整高度：' : '旋转'}${entity.name} · 松手保留预览，确认后放置`;
    return true;
  },
  move(hand) {
    if (!gesture) return;
    const point = handClient(hand);
    if (handTarget(point, false).kind !== 'room') return;
    if (gesture.carrying) {
      gesture.carrying = false; delete handPointer.dataset.label;
      beginSession(gesture.id);
      if (!pending) {endGesture(); return;}
      analogActive = true; controls.enabled = false;
    }
    gestureStep(() => {followPointer(point.x, point.y, true, gesture.grab); gesture.lastHand = hand;});
  },
  height(hand) {
    if (!gesture) return;
    const {id, height, start} = gesture, y = height + (start.v - hand.v) * 3;
    gestureStep(() => editObject(next => {next[id].y = y;}, y >= (layout[id].y || 0) ? 'up' : 'down'));
  },
  rotate(angle) {
    if (!gesture) return;
    const {id, yaw} = gesture;
    gestureStep(() => editObject((next) => {next[id].yaw = Math.atan2(Math.sin(yaw + angle), Math.cos(yaw + angle));}, 'rotate'));
  },
  release() {
    if (!gesture) return;
    flushGestureMotion();
    const carrying = gesture?.carrying;
    endGesture();
    if (carrying) {$('#status').textContent = '没有拖进房间，已放回物品库'; return;}
    if (!pending) return;
    pending.pause();
    validateAfterRender();
    $('#status').textContent = '预览已保留 · 可切换模式调整；右手竖拇指约 0.5 秒、放置按钮或 Enter 确认';
  },
  cancel() {
    if (!gesture) return;
    // Discard queued movement on tracking loss; keep the last applied preview uncommitted.
    endGesture();
    if (pending) {pending.pause(); validateAfterRender(); $('#status').textContent = '追踪中断 · 预览已冻结，松手后重新抓取';}
  },
  // The gesture page's “取消当前操作”, or its camera turned off.
  stop() {endGesture(); cancelSession(false);},
  pointer(hand, helper) {
    leftPointer.hidden = !helper?.fingertips;
    if (helper) {
      const p = handPoint(helper); leftPointer.style.left = `${p.u * 100}%`; leftPointer.style.top = `${p.v * 100}%`;
      leftPointer.dataset.pinching = String(!!helper.pinching);
    }
    for (const [role, signal] of [['operator',hand],['helper',helper]]) {
      const group = fingerOverlay.querySelector(`[data-hand="${role}"]`);
      group.style.display = signal?.fingertips ? '' : 'none';
      if (!signal?.fingertips) continue;
      const a = handPoint(signal.fingertips.thumb), b = handPoint(signal.fingertips.index), line = group.querySelector('line');
      for (const [key,value] of Object.entries({x1:a.u,y1:a.v,x2:b.u,y2:b.v})) line.setAttribute(key, `${value * 100}%`);
      for (const [name,p] of [['thumb',a],['index',b]]) {
        const dot = group.querySelector(`[data-tip="${name}"]`); dot.setAttribute('cx', `${p.u * 100}%`); dot.setAttribute('cy', `${p.v * 100}%`);
      }
    }
    handPointer.hidden = !hand?.fingertips;
    // While the fingers are closed the highlight stays on what the pinch began on.
    if (!hand?.pinching || handPointer.hidden) {
      const target = hand && !handPointer.hidden ? handTarget(handClient(hand)) : null;
      const hover = target && target.kind !== 'room' && target.kind !== 'none' ? target.element : null;
      if (hover) {
        const now = performance.now();
        if (lastHover?.target.element === hover && now - lastHover.at < HAND_SLIP_MS) lastHover.at = now;
        else lastHover = {target, since: now, at: now};
      }
      if (handPointer.hidden) lastHover = null;
      if (hover !== handHover) {handHover?.classList.remove('rc-hand-hover'); hover?.classList.add('rc-hand-hover'); handHover = hover;}
    }
    if (!hand) return;
    const {u, v} = handPoint(hand);
    handPointer.style.left = `${u * 100}%`; handPointer.style.top = `${v * 100}%`;
    handPointer.dataset.pinching = String(!!hand.pinching);
  },
  observe: {
    begin(hand, action, role) {
      const target = pinchTarget(handClient(hand));
      if (role !== 'helper' && (target.kind === 'control' || target.kind === 'shelf')) {
        if (target.kind === 'control') pressControl(target);
        else showToast('从物品库拖出请先切到移动模式（左手 1）');
        return false;
      }
      if (gestureView || !ready || (role !== 'helper' && target.kind === 'none')) return false;
      gestureView = {base: cameraState(), start: {u: hand.u, v: hand.v}, action};
      controls.enabled = false; return true;
    },
    update(hand) {
      if (!gestureView) return;
      flushGestureMotion();
      applyCamera(observationPose(gestureView.base, gestureView.start, hand, gestureView.action));
      rebaseGesture();
    },
    finish(cancel) {
      if (!gestureView) return;
      if (cancel) applyCamera(gestureView.base);
      gestureView = null; releaseOrbit();
    },
  },
  scale: {
    begin(right, left) {
      if (!ready || gesture || falling) return false;
      gestureScale = {base:cameraState(), distance:Math.max(.04, Math.hypot(right.u-left.u,right.v-left.v))};
      controls.enabled = false; $('#status').textContent = '双手缩放场景 · 左手环绕已暂停'; return true;
    },
    update(right, left) {
      if (!gestureScale) return;
      const ratio = Math.max(.2, Math.hypot(right.u-left.u,right.v-left.v) / gestureScale.distance);
      // An orthographic camera changes visible size through zoom, not camera radius.
      applyCamera({...gestureScale.base, zoom:Math.max(.3, Math.min(4, gestureScale.base.zoom * ratio))});
    },
    finish(interrupted) {
      gestureScale = null; releaseOrbit();
      $('#status').textContent = interrupted ? '缩放已冻结 · 松手后继续' : '缩放结束 · 左手捏合可继续环绕';
    },
  },
};
// Hand frames come from the gesture page around this editor (gesture-bridge.mjs), or from the
// editor's own camera card (gesture-camera.mjs, the 手势 button); the same input handles both.
const gestureInput = new GestureInput(gesturePort);
const confirmationTarget = () => ({
  previewId: pending?.gestureId ?? null,
  allowed: ready && !!pending && !falling && !pending.placeWhenChecked && !gesture && !gestureScale && !analogActive,
});
const gestureState = () => ({busy: !ready || !!falling || !!pending?.placeWhenChecked,
  phase: falling || pending?.placeWhenChecked ? 'validating' : gesture ? 'preview' : gestureView || gestureScale ? 'observing' : 'idle'});
function setGestureMode(next) {
  gestureMode = next;
  gestureFeedbackPanel.setMode(next);
  if (next === 'view') warehouse.setOpen(false);
  if (next !== 'view' && mode !== 'edit') setMode('edit');
  $('#status').textContent = GESTURE_HELP[next]; $('#interaction-help').textContent = GESTURE_HELP[next];
  for (const button of document.querySelectorAll('[data-gesture-mode]')) button.setAttribute('aria-pressed', String(button.dataset.gestureMode === next));
  return true;
}
const embedded = connectGestureBridge({
  input: gestureInput,
  stop: gesturePort.stop,
  confirm: confirmSession,
  cancel: cancelSession,
  setMode: setGestureMode,
  state: () => ({...gestureState(), mode: gestureMode, selectedId: selected, layoutReady: ready,
    previewId: pending?.gestureId ?? null,
    canConfirm: confirmationTarget().allowed,
    message: $('#status').textContent || '', capabilities: ['observe-pinch-v1', 'dual-hand-v2', 'thumb-confirm-v1', 'thumb-cancel-v1']}),
});
const handsOn = () => !!embedded || !!gestureCamera?.on;

// The camera card: MediaPipe runs in a worker on this computer; no image leaves the browser.
// vendor/vision links to gesture/public/vision; publish.py copies what it points to.
const VISION = new URL('../vendor/vision/', import.meta.url);
let gestureCamera = null;
const MOUSE_HELP = $('#interaction-help').textContent;
function showGestures(on) {
  $('#rc-placement-demo').dataset.gesture = String(on);
  const button = $('#gesture-toggle');
  button.dataset.cameraActive = String(on);
  button.setAttribute('aria-label', on ? '手势控制，摄像头已开启' : '手势控制面板');
  button.dataset.tooltip = on ? '手势已开启 · 打开 / 收起面板' : '手势 · 打开 / 收起面板';
  $('#stop-gestures').textContent = on ? '关闭手势与摄像头' : '开启手势与摄像头';
  gestureFeedbackPanel.update({lifecycle: on ? 'starting' : 'off', mode: gestureMode});
  if (on) setGestureMode(gestureMode);
  else {
    handPointer.hidden = true; handHover?.classList.remove('rc-hand-hover'); handHover = null;
    $('#interaction-help').textContent = MOUSE_HELP; updateSessionUI();
  }
}
function gestureStatus(text) {
  $('#gesture-status').textContent = text; $('#gesture-status').hidden = !text;
}
async function toggleGestures() {
  if (embedded || $('#stop-gestures').disabled) return;
  if (gestureCamera?.on) {
    gestureCamera.stop(); showGestures(false); gestureStatus(''); return;
  }
  const button = $('#stop-gestures');
  button.disabled = true;
  button.textContent = '正在开启摄像头…';
  gestureStatus('正在开启摄像头…');
  try {
    if (!gestureCamera) {
      const lib = await import('../vendor/gesture/gesture-runtime.js');
      lib.setVisionBase(VISION);
      gestureCamera = createGestureCamera({lib, video: $('#gesture-video'), canvas: $('#gesture-skeleton'), input: gestureInput, ui: {
        feedback: payload => gestureFeedbackPanel.update(payload),
        status: gestureStatus,
      }, port: {mode: () => gestureMode, setMode: setGestureMode, confirmationTarget, confirm: confirmSession, cancel: cancelSession, busy: () => gestureState().busy,
        canSwitch: () => {const state = gestureState(); return !state.busy && state.phase === 'idle';}}});
    }
    if (await gestureCamera.start()) {
      showGestures(true);
      gestureFeedbackPanel.update({lifecycle: 'tracking', mode: gestureMode});
    } else {
      showGestures(false);
      showToast(`手势没有开启：${$('#gesture-status').textContent || '摄像头未就绪'}`);
    }
  } catch (error) {
    console.error(error); showGestures(false); showToast(`手势没有开启：${error.message || error}`);
  } finally {button.disabled = false;}
}
$('#gesture-toggle').onclick = () => workspace.setGesturePanel(!workspace.gesturePanelOpen);
$('#stop-gestures').onclick = () => void toggleGestures();
for (const button of document.querySelectorAll('[data-gesture-mode]')) {
  button.onclick = () => {if (!gestureCamera?.requestMode(button.dataset.gestureMode)) setGestureMode(gestureMode);};
}

// Objects rebuilt by ViewForge, at their measured size. The full model is shown; its light
// preview (same frame, ~1/40 of the triangles) stands in for contact and collision checks.
let addedCount = 0, importAsset = null;
async function openImports() {
  // "添加物体": photos → a new object on the same server, then straight into the room.
  const adder = mountAddObject({toast: showToast, onReady: async (run, asset) => {
    if (![...$('#import-run').options].some((option) => option.value === run)) $('#import-run').prepend(new Option(objectLabel(run), run));
    $('#import-menu').hidden = false; $('#import-run').value = run; void chooseImport();
    warehouse.setOpen(false);
    const {axis, value} = asset.calibration;
    await importRun(run, asset.base, metricScale(asset.base, axis, value), asset.capabilities).catch((error) => {
      console.error(error); showToast(`导入失败：${error.message || error}`);
    });
  }});
  // 补拍 an object rebuilt earlier: more photos, rebuilt on top of that result.
  $('#import-capture').onclick = () => {
    const run = $('#import-run').value;
    if (!run) return;
    $('#import-menu').open = false;
    adder.capture(run, objectLabel(run));
  };
  $('#import-run').onchange = () => void chooseImport();
  $('#import-axis').onchange = $('#import-meters').oninput = describeImport;
  $('#import-object').onclick = () => void importObject().catch((error) => {
    console.error(error); showToast(`导入失败：${error.message || error}`);
  });
  let catalog;
  try {catalog = await readCatalog();} catch {
    $('#add-object-state').textContent = '照片重建 · 服务暂不可用，可重试';
    return;
  }
  if (!catalog.runs?.length) return;
  for (const run of catalog.runs) $('#import-run').appendChild(new Option(objectLabel(run), run));
  $('#import-menu').hidden = false;
  await chooseImport();
}
async function chooseImport() {
  const run = $('#import-run').value;
  importAsset = null; $('#import-object').disabled = $('#import-capture').disabled = true; $('#import-note').textContent = '正在读取尺寸…';
  const asset = await readAsset(run).catch(() => null);
  if ($('#import-run').value !== run) return;
  if (!asset) {$('#import-note').textContent = '读取失败，请检查 ViewForge 隧道'; return;}
  importAsset = {...asset, run};
  $('#import-capture').disabled = false;
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
  $('#import-object').disabled = true;
  try {await importRun(run, base, scale, importAsset.capabilities);} finally {$('#import-object').disabled = false;}
  $('#import-menu').open = false;
}
async function importRun(run, base, scale, capabilities) {
  if (!ready) throw new Error('房间还没加载好');
  $('#status').textContent = `正在载入 ${objectLabel(run)}…`;
  const loader = new GLTFLoader();
  const {full, light} = await loadModels(run, (url) => loader.loadAsync(url));
  cancelSession(false);
  const id = `added-${++addedCount}`, contact = `${id}:contact`;
  const shape = new THREE.Group();
  shape.applyMatrix4(new THREE.Matrix4().fromArray(placementMatrix(base, scale)));
  full.scene.traverse((mesh) => {
    if (!mesh.isMesh) return;
    mesh.userData.collision = false; mesh.raycast = () => {};
    mesh.castShadow = true;
  });
  const importMaterials = createImportMaterials(THREE, full.scene, {mode: $('#import-lighting').checked ? 'pbr' : 'original',
    preservePBR: capabilities?.material_mode === 'pbr'});
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
  const entity = {id, name, category: '导入物品 · 真实尺寸', roots: [contact], group, origin, added: true, importMaterials, dimensions: size,
    sizeLabel: `${size[0].toFixed(2)} × ${size[2].toFixed(2)} × ${size[1].toFixed(2)} ${config.units}`};
  entities.set(id, entity); ids.push(id);
  placementSpecs[id] = {body: [contact]};
  layout[id] = stored();
  for (const past of [...history.past, ...history.future]) past[id] = stored();
  appendWarehouseRow(entity, true); renderFurnitureThumbnails([entity]);
  group.visible = false;
  // Placement and collision index every piece once; rebuild them with the new one (a few seconds).
  placement = createPlacement(THREE, room, entities, placementSpecs, floorY, ceilingY, {openings: config.openings});
  rebuildCollision();
  renderer.shadowMap.needsUpdate = true;
  beginSession(id);
  const spot = freeSpot(id);
  if (spot) {layout[id] = spot; pending.lastReachable = copyLayout(layout); applyLayout();}
  showToast(`已导入${name}：${handsOn() ? '移动模式下指向它捏合拖动' : '移动鼠标摆放，单击锁定'}，确认后放下`);
  if (!handsOn()) pending.locked = false;
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
  renderer.toneMappingExposure = lightProfile.exposure;
  renderMetrics = createRenderMetrics(renderer, {gpu: query.has('lightingLab'), limit: query.has('lightingLab') ? 2400 : 120});
  renderer.domElement.setAttribute('aria-label', '房间三维场景，点选物品或使用物品列表');
  host.appendChild(renderer.domElement);
  controls = new OrbitControls(camera, renderer.domElement);
  // Reserve the left button for object selection and placement, including with modifier keys.
  controls.mouseButtons = {LEFT: null, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN};
  controls.enableDamping = false;
  controls.minZoom = .45; controls.maxZoom = 8;
  controls.minDistance = .2;
  controls.maxDistance = 2000;
  controls.maxPolarAngle = Math.PI / 2 - .015;
  controls.addEventListener('change', requestRender);
  controls.addEventListener('start', finishHold);
  controls.addEventListener('start', () => {orbitActive = true;});
  controls.addEventListener('end', () => {orbitActive = false; requestRender();});
  scene.add(new THREE.HemisphereLight(0xffffff, 0x87919d, lightProfile.hemisphere));
  for (const [position, intensity] of [[[3, 8, 5], lightProfile.key], [[-5, 4, -4], lightProfile.fill]]) {
    const light = new THREE.DirectionalLight(0xffffff, intensity);
    light.position.set(...position); scene.add(light);
  }
  let viewportWidth = 0, viewportHeight = 0;
  const resize = () => {
    const width = host.clientWidth, height = host.clientHeight;
    if (!width || !height || (width === viewportWidth && height === viewportHeight)) return;
    viewportWidth = width; viewportHeight = height;
    camera.aspect = width / height; alignCameraToStage(); camera.updateProjectionMatrix();
    walk?.resize(width, height);
    renderer.setSize(width, height);
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
  // A glTF mesh without normals is flat shaded. Give it its face normals, so the shadow
  // bias (which reads normals) matches a model that stores them, as samples/room3 did.
  room.traverse((mesh) => {if (mesh.isMesh && !mesh.geometry.attributes.normal) {mesh.geometry = mesh.geometry.toNonIndexed(); mesh.geometry.computeVertexNormals();}});
  room.updateMatrixWorld(true);
  // Grouping, and flattening a generated room, must leave every mesh where it was.
  const originalMatrices = new Map();
  room.traverse((object) => {if (object.isMesh) originalMatrices.set(object, object.matrixWorld.clone());});
  flattenObjects(room, config.nodes);
  const bounds = new THREE.Box3().setFromObject(room);
  roomBounds = bounds.clone();
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
  if (enhancedLighting && query.get('shadows') !== 'original') {
    sun.updateWorldMatrix(true, false); sun.target.updateWorldMatrix(true, false);
    sun.shadow.updateMatrices(sun);
    const corners = [0, 1].flatMap(x => [0, 1].flatMap(y => [0, 1].map(z => new THREE.Vector3(
      x ? bounds.max.x : bounds.min.x, y ? bounds.max.y : bounds.min.y, z ? bounds.max.z : bounds.min.z,
    ).applyMatrix4(sun.shadow.camera.matrixWorldInverse).toArray())));
    const fitted = shadowSettings(corners, sun.shadow.mapSize.x);
    if (fitted) {
      Object.assign(sun.shadow.camera, fitted.camera); sun.shadow.camera.updateProjectionMatrix();
      sun.shadow.bias = fitted.bias; sun.shadow.normalBias = fitted.normalBias;
      shadowMode = 'room-bounds';
    }
  }
  const audit = groupScene(gltf, originalMatrices);
  progress.value = 92;
  ceilingY = new THREE.Box3().setFromObject(room.getObjectByName('Wall0')).max.y;
  placement = createPlacement(THREE, room, entities, placementSpecs, floorY, ceilingY, {openings: config.openings});
  groundGrid = createGroundGrid(THREE, {floorY, target: controls.target, walls: placement.wallTargets()});
  scene.add(groundGrid);
  if (enhancedLighting) {
    try {indoor = indoorLighting(JSON.parse(localStorage.getItem(`roomcanvas:indoor-lighting:${sceneKey}`)));} catch {}
    if (query.get('indoor') === 'off') indoor = {...indoor, power: false};
    lightingPanel.setIndoor(indoor);
    lightingRig = createTimeLighting(THREE, {renderer, scene, room, config, walls: placement.wallTargets(), bounds, floorY, ceilingY, profile: lightProfile,
      fitShadows: query.get('shadows') !== 'original', environment: query.get('env') !== 'off', indoor});
    lightingRig.apply(lightingTime);
  }
  renderFurnitureThumbnails();
  for (const wall of placement.wallTargets()) {
    const option = document.createElement('option'); option.value = wall.name; option.textContent = wallLabel(wall.name);
    $('#wall-target').appendChild(option);
  }
  audit.placement = placement.audit;
  rebuildCollision();
  audit.collision = collision.audit;
  wallVisibility = createWallVisibility(room, placement.wallTargets(), {...wallOptions(placement.wallTargets()), conceal: (root, on) => setSeeThrough(root, on, nearWallMode() === 'hidden' ? 0 : SEE_THROUGH)});
  // GLTFLoader may rename a node; the original name is kept in userData.name.
  const named = new Map();
  room.traverse((object) => named.set(object.userData?.name || object.name, object));
  // The other pieces of each part's group (a desk's monitor and cups, a piano's scores) that rest on it.
  const groupOf = new Map(config.nodes.map(({node, group}) => [node, group]));
  hinged = new Openings(THREE, config.joints.filter((joint) => named.has(joint.node)).map((joint) => {
    const node = named.get(joint.node);
    node.updateMatrix();
    const pieces = config.nodes.filter(({node: name, group}) => group === groupOf.get(joint.object) && name !== joint.object && named.has(name))
      .map(({node: name}) => named.get(name));
    const riders = ridersOf(THREE, node, pieces).map((piece) => {piece.updateMatrix(); return {node: piece, rest: piece.matrix.clone()};});
    return {joint, node, rest: node.matrix.clone(), riders};
  }), {render: requestRender, settled: () => {renderer.shadowMap.needsUpdate = true; requestRender();}});
  audit.openParts = hinged.parts.length;
  // The floor's own box keeps the walk indoors where a door or a window has no wall to stop it.
  const floorBox = new THREE.Box3().setFromObject(room.getObjectByName('Floor0'));
  walk = createWalk(THREE, {canvas: renderer.domElement, room, floorY, solid: solidHit,
    bounds: {min: [floorBox.min.x, floorBox.min.z], max: [floorBox.max.x, floorBox.max.z]},
    // Looking around or walking leaves the hint behind; it comes back when the mouse moves again.
    onChange: () => {hideOpenHint(); requestRender();}, onHover: walkAim, onExit: () => setMode(walkFrom),
    onClick: (at) => {const part = openableAt(at, walk.camera); if (part) {hinged.toggle(part); $('#open-hint').textContent = openHintText(part);}}});
  ready = true;
  // Entering a room always shows its authored layout. Merely opening it must
  // not overwrite the last confirmed arrangement in browser storage.
  layout = initialLayout(ids);
  try {$('#resume-layout').disabled = !localStorage.getItem(storageKey);} catch {}
  $('#save-state').textContent = '原始布置 · 确认更改后自动保存';
  joysticks = mountJoysticks($('#adjust-controls'), {
    onStart(kind) {
      if (!ready || !selected || falling || mode !== 'edit') return false;
      if (!pending) beginSession(selected);
      if (!pending) return false;
      workspace.setTool(kind === 'lift' ? 'height' : kind);
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
      releaseOrbit();
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
  $('#status').textContent = `${entities.size} 件物品可布置 · 单击选择，拖动调整`;
  view('overview');
  void openImports();
  // Read-only diagnostics for real-browser verification; no controls or mutable scene exposed.
  window.roomEditor = Object.freeze({
    get ready() {return ready;},
    captureFrame() {renderMetrics.measure('capture', () => {if (staticLighting) staticLighting.capture(); else renderer.render(scene, walk?.active ? walk.camera : camera);}); return renderer.domElement.toDataURL('image/png');},
    projectFloor(x, z) { const p = new THREE.Vector3(x, floorY, z).project(camera), r = host.getBoundingClientRect(); return {x:r.x+(p.x*.5+.5)*r.width,y:r.y+(-p.y*.5+.5)*r.height}; },
    snapshot() {
      room.updateMatrixWorld(true);
      camera.updateMatrixWorld();
      return {scene: sceneKey, formatVersion: VERSION, selected, view: activeView, mode, walk: walk?.snapshot() || null, cameraBasis: basis(), layout: copyLayout(pending ? pending.before : layout),
        projection: camera.isPerspectiveCamera ? 'perspective' : 'orthographic',
        nearWalls: {mode: nearWallMode(), walls: (host.dataset.hiddenWalls || '').split(',').filter(Boolean), concealed: [...concealedIds].sort()},
        pending: pending ? {id: pending.id, locked: pending.locked, valid: pending.valid, message: pending.message, candidate: copyLayout(pending.candidate)} : null, placement: Object.fromEntries(placementStates), motionNotice,
        wallRelocation: wallRelocation ? {target: wallRelocation.target, valid: wallRelocation.valid, message: wallRelocation.message, candidate: wallRelocation.candidate ? copyLayout(wallRelocation.candidate) : null} : null,
        wallTargets: placement.wallTargets().map(({name,center}) => {const p = new THREE.Vector3().fromArray(center).project(camera), rect = host.getBoundingClientRect(); return {name,center,screen:{x:rect.x+(p.x*.5+.5)*rect.width,y:rect.y+(-p.y*.5+.5)*rect.height}};}),
        undo: history.past.length, redo: history.future.length, audit,
        lighting: {...(staticLighting?.snapshot() || lightingStatus), profile: lightProfile.name, time: lightingRig?.snapshot() || {preset: 'balanced'}, grading: {...grading},
          environment: environmentLighting ? {...environmentLighting.snapshot(), intensity: scene.environmentIntensity} : environmentStatus,
          shadows: {mode: shadowMode, mapSize: sun.shadow.mapSize.toArray(), bias: sun.shadow.bias, normalBias: sun.shadow.normalBias,
            camera: Object.fromEntries(['left','right','top','bottom','near','far'].map(key => [key, sun.shadow.camera[key]]))},
          lights: scene.children.filter(object => object.isLight).map(light => ({
          type: light.type, role: light.userData.lightingRole || null, color: light.color.getHexString(), intensity: light.intensity, position: light.position.toArray(), castShadow: light.castShadow, visible: light.visible,
        }))},
        openParts: hinged.parts.map((part) => {
          const box = new THREE.Box3().setFromObject(part.node), p = box.getCenter(new THREE.Vector3()).project(camera), rect = host.getBoundingClientRect();
          const scale = new THREE.Vector3().setFromMatrixScale(part.node.matrixWorld).toArray();
          return {node: part.joint.node, value: part.value, scale, riders: part.riders.map((rider) => rider.node.userData?.name || rider.node.name), screen: {x: rect.x + (p.x * .5 + .5) * rect.width, y: rect.y + (-p.y * .5 + .5) * rect.height}};
        }),
        objects: [...entities.values()].map((entity) => {
          const box = new THREE.Box3().setFromObject(entity.group);
          const projected = box.getCenter(new THREE.Vector3()).project(camera);
          const rect = host.getBoundingClientRect();
          return {id: entity.id, name: entity.name, visible: entity.group.visible, seeThrough: entity.group.userData.seeThrough ? entity.group.userData.seeThroughOpacity : null, roots: entity.roots, origin: entity.origin.toArray(),
            bounds: {min: box.min.toArray(), max: box.max.toArray()},
            members: entity.group.children.map((child) => ({name: child.userData.name || child.name, position: child.getWorldPosition(new THREE.Vector3()).toArray()})),
            screen: {x: rect.x + (projected.x * .5 + .5) * rect.width, y: rect.y + (-projected.y * .5 + .5) * rect.height}};
        }), renderCalls: renderMetrics.last?.calls || 0, geometries: renderer.info.memory.geometries};
    },
  });
  if (query.has('lightingLab')) installLightingLab();
  renderer.domElement.addEventListener('webglcontextlost', (event) => {event.preventDefault(); cancelAnimationFrame(gradingFrame); staticLighting?.dispose(); environmentLighting?.dispose(); lightingRig?.dispose(); renderMetrics.dispose(); finishHold(); persist(); fail('图形上下文已暂停');});
  // Load the optional effect after the editor works. Missing addons must never prevent editing.
  if (enhancedLighting) void (async () => {
    if (query.get('env') !== 'off') {
      try {
        const {createEnvironmentLighting} = await import('./environment-lighting.mjs');
        environmentFactory = createEnvironmentLighting;
        environmentLighting = createEnvironmentLighting(renderer, scene, {intensity: query.get('env') === 'off' ? 0 : scene.environmentIntensity});
        requestRender();
      } catch (error) {
        environmentStatus = {state: 'error', error: String(error)};
        console.warn('环境反射未加载，继续使用原有光照。', error);
      }
    }
    try {
      const {createStaticLighting} = await import('./static-lighting.mjs');
      const N8AOPass = query.get('ao') === 'n8ao' ? (await import('../vendor/n8ao/N8AOPass.js')).N8AOPass : null;
      staticLighting = createStaticLighting({renderer, scene, camera, room, roomSize, metrics: renderMetrics, N8AOPass, grading, enabled: query.get('ao') !== 'off',
        busy: () => !ready || document.hidden || orbitActive || analogActive || !!falling || !!hold || !!gestureView || !!gestureScale || hinged.moving.size > 0 || !!walk?.moving(),
      });
      if (document.hidden) staticLighting.pause();
      requestRender();
    } catch (error) {
      lightingStatus = {enabled: false, state: 'error', updates: 0, error: String(error)};
      console.warn('静态接触暗部未加载，继续使用原有光照。', error);
    }
  })();
}

// Explicit lab mode only. Normal editor sessions expose no scene mutation/test controls.
function installLightingLab() {
  const cameraKeys = projection => ['near', 'far', 'zoom', ...(projection === 'perspective' ? ['fov', 'aspect'] : ['left', 'right', 'top', 'bottom'])];
  function captureState() {
    if (pending || falling || analogActive) throw new Error('请先结束摆放再保存基线');
    return {version: 1, scene: sceneKey, layout: encodeLayout(roomPart(layout), sceneKey),
      camera: {projection: camera.isPerspectiveCamera ? 'perspective' : 'orthographic',
        ...Object.fromEntries(cameraKeys(camera.isPerspectiveCamera ? 'perspective' : 'orthographic').map(key => [key, camera[key]])), position: camera.position.toArray(),
        quaternion: camera.quaternion.toArray(), up: camera.up.toArray(), target: controls.target.toArray(), span: cameraSpan},
      nearWalls: nearWallMode(), ceiling: $('#ceiling').checked, warm, mode, lightingTime, indoor: {...indoor}, grading: {...grading}};
  }
  window.roomLightingLab = Object.freeze({
    captureState,
    restoreState(state) {
      if (state?.version !== 1 || state.scene !== sceneKey) throw new Error('基线与当前模型不匹配');
      const pose = state.camera;
      const projection = pose?.projection || 'orthographic';
      if (!pose || !['orthographic', 'perspective'].includes(projection)
        || [...cameraKeys(projection).map(key => pose[key]), pose.span, ...pose.position, ...pose.quaternion, ...pose.target, ...pose.up].some(v => !Number.isFinite(v)) || pose.zoom <= 0) throw new Error('无效的基线相机');
      const restored = decodeLayout(state.layout, sceneKey, roomIds);
      cancelSession(false); select(null); hinged.closeAll();
      layout = {...restored, ...addedPart(layout)};
      setMode(state.mode === 'preview' ? 'preview' : 'edit');
      // Saved before 近侧墙 had three settings: cut (see-through or not).
      setNearWallMode(state.nearWalls || (state.cut ? 'faint' : 'solid'));
      $('#ceiling').checked = !!state.ceiling;
      for (const object of ceilingObjects) object.visible = !!state.ceiling;
      warm = !!state.warm;
      lightingTime = enhancedLighting ? timePreset(state.lightingTime) : 'balanced'; lightingPanel.setTime(lightingTime);
      indoor = indoorLighting(state.indoor); lightingPanel.setIndoor(indoor); lightingRig?.setIndoor(indoor);
      if (lightingRig) lightingRig.apply(lightingTime, {warm});
      else for (const object of scene.children) if (object.isDirectionalLight) object.color.set(warm ? 0xffd2a5 : 0xffffff);
      grading = colorGrading(state.grading); lightingPanel.setGrade(grading); staticLighting?.setGrading(grading);
      useCamera(projection);
      cameraSpan = pose.span; Object.assign(camera, Object.fromEntries(cameraKeys(projection).map(key => [key, pose[key]])));
      camera.position.fromArray(pose.position); camera.up.fromArray(pose.up); camera.quaternion.fromArray(pose.quaternion);
      controls.target.fromArray(pose.target); camera.updateProjectionMatrix(); controls.update();
      applyLayout(); renderer.shadowMap.needsUpdate = true; requestRender();
    },
    orbit(state, angle) {
      if (!Number.isFinite(angle)) throw new Error('无效角度');
      const target = new THREE.Vector3().fromArray(state.camera.target);
      const offset = new THREE.Vector3().fromArray(state.camera.position).sub(target).applyAxisAngle(new THREE.Vector3(0,1,0), angle);
      controls.target.copy(target); camera.position.copy(target).add(offset); controls.update(); requestRender();
    },
    zoom(value) {if (!(value > 0 && value <= 8)) throw new Error('无效缩放'); camera.zoom = value; camera.updateProjectionMatrix(); requestRender();},
    focusObject(id) {if (!entities.has(id) || pending) throw new Error('请先结束摆放'); select(id,false); view('focus'); select(null);},
    lightResponseProbe(id) {
      if (pending || !entities.has(id)) throw new Error('请先结束摆放');
      const box = new THREE.Box3().setFromObject(entities.get(id).group);
      const p = box.getCenter(new THREE.Vector3()).project(camera);
      const lights = scene.children.filter(object => object.isLight), intensities = lights.map(light => light.intensity), environment = scene.environment;
      const frame = () => {renderer.render(scene,camera); return renderer.domElement.toDataURL('image/png');};
      // Measure the object alone: lit see-through walls or furniture in front would respond to the lights.
      const own = new Set(); entities.get(id).group.traverse(object => own.add(object));
      const hidden = []; scene.traverse(object => {if (object.isMesh && object.visible && !own.has(object)) {object.visible = false; hidden.push(object);}});
      try {
        const lit = frame();
        lights.forEach(light => {light.intensity=0;}); scene.environment=null;
        const dark=frame(), size=renderer.getDrawingBufferSize(new THREE.Vector2());
        return {lit,dark,center:[Math.round((p.x*.5+.5)*size.x),Math.round((-p.y*.5+.5)*size.y)]};
      } finally {for (const object of hidden) object.visible = true; lights.forEach((light,index) => {light.intensity=intensities[index];});scene.environment=environment;renderer.shadowMap.needsUpdate=true;requestRender();}
    },
    metrics: () => renderMetrics.snapshot(),
    resetMetrics: () => renderMetrics.reset(),
    materials() {
      const materials = new Map(); let meshes = 0, missingNormals = 0;
      room.traverse(mesh => {
        if (!mesh.isMesh || mesh.userData.contactOnly) return;
        meshes++; if (!mesh.geometry.attributes.normal) missingNormals++;
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          if (!materials.has(material.uuid)) materials.set(material.uuid, {name: material.name, type: material.type,
            color: material.color?.toArray(), roughness: material.roughness, metalness: material.metalness,
            map: !!material.map, mapColorSpace: material.map?.colorSpace, normalMap: !!material.normalMap,
            transparent: material.transparent, vertexColors: material.vertexColors});
        }
      });
      return {meshes, missingNormals, materials: [...materials.values()],
        imported: [...entities.values()].filter(e => e.importMaterials).map(e => ({id: e.id, ...e.importMaterials.snapshot()}))};
    },
    device() {
      const gl = renderer.getContext(), info = gl.getExtension('WEBGL_debug_renderer_info');
      return {webgl: gl.getParameter(gl.VERSION), renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        three: THREE.REVISION, pixelRatio: renderer.getPixelRatio(), size: renderer.getDrawingBufferSize(new THREE.Vector2()).toArray(),
        toneMapping: renderer.toneMapping, exposure: renderer.toneMappingExposure};
    },
    // Enables the same real import path for a deterministic synthetic/known test asset.
    importObject: (run, base, scale) => importRun(run, base, scale),
  });
}

function rebuildCollision() {
  const owners = collisionOwners(THREE, room, entities, {label: config.label});
  collision = buildCollision(owners, {keepAuthoredOverlaps: true});
  try {startBackgroundCollision(owners);} catch (error) {console.error(error); background = null;}
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
  const modelURL = `${(await roomReady).dir}/Room.glb`;
  try {
    const head = await fetch(modelURL, {method: 'HEAD', cache: 'no-store'});
    const stamp = head.ok && (head.headers.get('etag') || [head.headers.get('last-modified'), head.headers.get('content-length')].filter(Boolean).join(' '));
    return stamp ? `${modelURL}?v=${encodeURIComponent(stamp)}` : modelURL;
  } catch {return modelURL;}
}

// What can be moved, and how, comes from the room's room_objects.json (web/scripts/room_objects.py).
async function loadRoomConfig() {
  const {dir, name} = await roomReady;
  const response = await fetch(`${dir}/room_objects.json`, {cache: 'no-cache'});
  if (!response.ok) throw new Error(`物品清单读取失败（${response.status}）`);
  const room = roomConfig(await response.json());
  return name ? {...room, title: name} : room;
}

const roomConfigReady = loadRoomConfig();
// From the repository the brand leads back to the home page; the reconstruction viewer only
// exists beside a published preview.
if (sceneParam || roomParam) $('a[href="../?model=authored"]').hidden = true;
else $('#home-link').removeAttribute('href');
roomConfigReady.then(({title}) => {
  document.title = `RoomCanvas · ${title}`;
  $('.rc-project strong').textContent = title;
}, () => {});

// Inside the gesture page the tools move to where a right hand reaches them (editor.css, data-gesture).
if (embedded) {$('#rc-placement-demo').dataset.gesture = 'true'; $('#gesture-toggle').hidden = true;}
load().catch(fail);
