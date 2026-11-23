// The replay's 3D view: scan point cloud and layout boxes first, then whichever room model the
// timeline has reached (assembled room, each acceptance round, final). A newer model fades in over
// the previous one, and each object that appears takes shape once the camera has moved in close to it. The
// camera follows smoothly; near walls fade so the room stays readable.
import * as THREE from 'three';
import {Materializer, prefetch, shown} from './materialize.mjs';
import {disposeModel} from './resources.mjs';
import {createTimeLighting} from '../editor/time-lighting.mjs';
import {surfaceBox} from '../editor/physical-lighting.mjs';
import {namedLuminaires} from '../editor/room-luminaires.mjs';
import {lightingProfile} from '../editor/lighting-profiles.mjs';
import {DECAL_OFFSET, offsetDecals} from '../editor/decals.mjs';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';

// SmoothDamp: time-based, velocity stays continuous (eases in and out, follows a moving goal).
function smoothDamp(cur, goal, vel, smoothTime, maxSpeed, dt) {
  const omega = 2 / smoothTime, x = omega * dt, k = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const maxChange = maxSpeed * smoothTime;
  const change = Math.min(Math.max(cur - goal, -maxChange), maxChange), to = cur - change;
  const temp = (vel + omega * change) * dt;
  let v = (vel - omega * temp) * k, out = to + (change + temp) * k;
  if ((goal - cur > 0) === (out > goal)) {out = goal; v = 0;}
  return [out, v];
}
const SPIN = 0.058; // rad/s
const FADE_SECONDS = 2;
const WALLISH = /^(Wall\d|Door\d|Window\d)|Drape|Sheer|Curtain|Panorama|Bulkhead/i;
const WINDOW = /^Window(\d+)$/i, BACKDROP = /^(?:Window)?DaylightBackdrop(\d*)$/i;
const HIDDEN = /^Ceiling/i;
const SHELL = /^(Floor|Wall)\d+$/;
const CLOSE_POLAR = 1.0;  // rad from straight down: looking at an object a little from above
const HIGH_POLAR = 0.7;   // a steeper look, over what stands in front
const MAX_WAIT = 2200;    // ms an object waits for the camera before taking shape anyway
const MAX_GROUP = 40;     // more objects appearing at once than this is the whole model being shown: no forming
const NEAR_SHARE = 0.02, NEAR_MIN = 0.05, NEAR_MAX = 0.5;  // camera near plane, as a share of the distance to the target
const CASCADE_STEP = 0.25, CASCADE_SECONDS = 4;  // objects appearing together start this far apart, all within

// Older replay caches have no placement manifest. In the seed, instances of the same chair asset
// share their triangle indices and colour image. The pipeline numbers groups by their lowest chair number.
function cachedChairClusters(root, ids = [], scanChairs) {
  const clusters = [...ids].filter(id => /^ChairCluster\d+$/.test(id));
  const chairs = root.children.filter(o => /^Chair\d+$/.test(o.name))
    .sort((a, b) => Number(a.name.slice(5)) - Number(b.name.slice(5)));
  const placed = {};
  for (const chair of chairs) {
    const cluster = chair.userData.source_glb?.match(/(?:^|\/)(ChairCluster\d+)\.glb$/)?.[1];
    if (cluster) (placed[cluster] ??= []).push(chair.name);
  }
  if (Object.keys(placed).length || !scanChairs || chairs.length !== scanChairs.size ||
      !chairs.every(chair => scanChairs.has(chair.name))) return placed;
  const groups = new Map();
  for (const chair of chairs) {
    const meshes = [];
    chair.traverse(o => {if (o.isMesh && !o.userData.mask) meshes.push(o);});
    if (meshes.length !== 1) return {};
    const mesh = meshes[0], index = mesh.geometry.index, source = mesh.material.map?.source;
    if (!index || !source) return {};
    const key = `${index.id}/${source.uuid}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(chair.name);
  }
  const members = Object.fromEntries([...groups.values()].map((names, i) => [`ChairCluster${i}`, names]));
  return groups.size === clusters.length && clusters.every(id => members[id]) ? members : {};
}

function sceneNames(id, chairClusters) {
  if (/^ChairCluster\d+$/.test(id)) return chairClusters?.[id] || [];
  const opening = id.match(/^Wall\d+_(Door|Window|Opening)_(\d+)$/);
  return opening ? [opening[1] + opening[2]] : [];
}

const originalName = node => node.userData.name || node.name;
const nameIndexes = new WeakMap();
function namedNodes(root) {
  if (!nameIndexes.has(root)) {
    const names = new Map();
    root.traverse(node => {
      const name = originalName(node);
      if (name && !names.has(name)) names.set(name, node);
    });
    nameIndexes.set(root, names);
  }
  return nameIndexes.get(root);
}

function nodesFor(root, id) {
  const top = root.children;
  const direct = top.filter((o) => originalName(o) === id);
  if (direct.length) return direct;
  const names = sceneNames(id, root.userData.chairClusters);
  return top.filter(o => names.includes(originalName(o)));
}

// A model node by its name, or the room objects a pipeline id stands for (a chair cluster's chairs, a door).
function partsOf(root, key) {
  if (!root) return [];
  const node = namedNodes(root).get(key);
  return node ? [node] : nodesFor(root, key);
}

// A world box only locates the opening reliably for axis-aligned panes. Check the actual
// triangles once at load time: an exporter can bake the wall rotation into the vertices.
function openingBox(part) {
  const box = new THREE.Box3(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  function aligned(o) {
    if (BACKDROP.test(o.name)) return true;
    if (o.isMesh) {
      const {position} = o.geometry.attributes, index = o.geometry.index;
      if (!position) return false;
      const vertex = (v, i) => v.fromBufferAttribute(position, index ? index.getX(i) : i).applyMatrix4(o.matrixWorld);
      for (let i = 0, count = index?.count ?? position.count; i < count; i += 3) {
        vertex(a, i); vertex(b, i + 1); vertex(c, i + 2);
        b.sub(a).cross(c.sub(a)).normalize();
        if (Math.abs(b.x) > 1e-5 && Math.abs(b.z) > 1e-5) return false;
      }
      box.union(surfaceBox(THREE, o));
    }
    return o.children.every(aligned);
  }
  return aligned(part) && !box.isEmpty() ? box : null;
}

function sameOpening(a, b) {
  if (!a || !b || !a.intersectsBox(b)) return false;
  const size = a.getSize(new THREE.Vector3()).max(b.getSize(new THREE.Vector3()));
  const along = size.x >= size.z ? 'x' : 'z';
  return [along, 'y'].every(axis => {
    const overlap = Math.min(a.max[axis], b.max[axis]) - Math.max(a.min[axis], b.min[axis]);
    return overlap > 0 && overlap >= 0.5 * size[axis];
  });
}

function sameModelPath(a, b) {
  while (!a.userData.replayRoot && !b.userData.replayRoot) {
    if (!a.name || a.name !== b.name) return false;
    a = a.parent; b = b.parent;
  }
  return !!(a.userData.replayRoot && b.userData.replayRoot);
}

// Accept at most one possible plate. A plate elsewhere in the model with an ambiguous
// name is enough to leave this opening on the ordinary fade.
function windowParts(part, backdrops) {
  const number = WINDOW.exec(part.name)[1];
  const plates = backdrops.filter(o => {
    const id = BACKDROP.exec(o.name)[1];
    return !id || id === number || part.getObjectById(o.id);
  });
  if (!plates.length) return [part];
  if (plates.length !== 1) return [];
  const [plate] = plates, id = BACKDROP.exec(plate.name)[1];
  if (id && id !== number) return [];
  if (!part.getObjectById(plate.id)) {
    if (plate.parent !== part.parent) return [];
    if (!id && part.parent.children.filter(o => WINDOW.test(o.name)).length !== 1) return [];
  }
  return [part, plate];
}

// Alpha-blended cloth can hang inside the same window as a pane with an unnamed material.
function blendedPane(mesh, material, windowRoots) {
  const glass = /glass|glaz|pane(?!l)/i, fabric = /sheer|curtain|drape|cloth|blind/i;
  if (fabric.test(material.name)) return false;
  if (glass.test(material.name)) return true;
  for (let node = mesh; node; node = node.parent) {
    const name = node.userData.name || node.name;
    if (fabric.test(name)) return false;
    if (glass.test(name) || windowRoots.has(node)) return true;
  }
  return false;
}

// A new mount can surround an object already present in the seed. Only the mount's new branches
// follow its reveal time; the transform chain to the old object must stay visible throughout.
function revealParts(root, names, seedNames) {
  const retained = new Set(), ancestors = new Set();
  root.traverse(o => {
    if (!seedNames.has(originalName(o)) || HIDDEN.test(o.name)) return;
    retained.add(o);
    for (let p = o.parent; p && p !== root; p = p.parent) ancestors.add(p);
  });
  function parts(node) {
    if (retained.has(node)) {node.visible = true; return [];}
    if (!ancestors.has(node) || HIDDEN.test(node.name)) return [node];
    node.visible = true;
    const children = node.children.filter(o => !o.userData.mask);
    if (!node.isMesh) return children.flatMap(parts);
    // Keep the mesh's local frame for its children. Only its geometry (and depth mask) forms.
    const frame = new THREE.Group();
    frame.name = node.name;
    frame.userData.name = originalName(node);
    namedNodes(root).set(frame.userData.name, frame);
    delete node.userData.name;
    if (node.matrixAutoUpdate) node.updateMatrix();
    frame.applyMatrix4(node.matrix);
    frame.matrixAutoUpdate = node.matrixAutoUpdate;
    node.parent.add(frame);
    frame.add(node, ...children);
    node.name = '';
    node.position.set(0, 0, 0); node.quaternion.identity(); node.scale.setScalar(1); node.updateMatrix();
    return [node, ...children.flatMap(parts)];
  }
  return names.map(name => {
    const node = namedNodes(root).get(name);
    // The schedule controls the named part itself, even if a previous version reused its name.
    // Seed descendants inside a newly added support keep their visible transform chain.
    return [name, node ? (retained.has(node) ? [node] : parts(node)) : []];
  });
}

async function loadModel(url, digest, signal) {
  const loader = new GLTFLoader();
  if (!digest) return loader.loadAsync(url);
  // The file may have changed again between the timeline poll and this GET.
  const hash = btoa(String.fromCharCode(...digest.match(/../g).map(byte => parseInt(byte, 16))));
  const response = await fetch(`${url}?sha256=${digest}`, {integrity: `sha256-${hash}`, signal});
  if (!response.ok) throw new Error(`model HTTP ${response.status}`);
  return loader.parseAsync(await response.arrayBuffer(), THREE.LoaderUtils.extractUrlBase(url));
}

function versionName(key, {interpolated: partial, modelEvent}) {
  if (!key) return '';
  if (key === 'seed') return partial ? '第一版房间 · 按记录推算' : '第一版房间';
  if (key === 'final') return partial ? '组装中的房间 · 按记录推算' : '最终房间';
  if (/^round\d+$/.test(key)) return modelEvent?.round ? `检查第 ${modelEvent.round} 轮` : '检查时的房间';
  if (key === 'small_objects') return '小物品重建后';
  if (key === 'articulated' || key.startsWith('articulated:')) {
    if (modelEvent?.joints > 0) return modelEvent.published ? '发布版（可开合）' : '已装配可开合部件';
    return modelEvent?.published ? '发布版' : '开合处理后';
  }
  return '搭建中的房间';
}

export class RoomView {
  // files(rel) -> URL of an allowlisted run file; scaffold = {points, layout} URLs or null.
  constructor(container, {files, scaffold, background = getComputedStyle(container).getPropertyValue('--rc-canvas').trim(),
    palette = {pointsLo: 0x46523f, pointsHi: 0x9a8457, wall: 0x3e4739, box: 0x8a6a2e, built: 0xb07d2c}} = {}) {
    this.container = container;
    this.files = files;
    this.palette = palette;
    const r = this.renderer = new THREE.WebGLRenderer({antialias: true});
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    r.localClippingEnabled = true;
    container.appendChild(r.domElement);
    r.domElement.style.display = 'block';
    const scene = this.scene = new THREE.Scene();
    scene.background = new THREE.Color(background);
    const environment = new RoomEnvironment(), generator = new THREE.PMREMGenerator(r);
    this.environmentTarget = generator.fromScene(environment, 0.04);
    scene.environment = this.environmentTarget.texture;
    environment.dispose(); generator.dispose();
    scene.environmentIntensity = 0.55;
    const hemisphere = new THREE.HemisphereLight(0xffffff, 0x8a8170, 1.1);
    scene.add(hemisphere);
    const sun = new THREE.DirectionalLight(0xfff4e6, 1.4);
    sun.position.set(-3, 6, 2);
    scene.add(sun);
    // The editor's lighting rig expects a fill light after the sun; off until the room is lit like the editor.
    const fill = new THREE.DirectionalLight(0xffffff, 0);
    fill.visible = false;
    scene.add(fill);
    this.lights = {hemisphere, sun, fill};
    r.shadowMap.enabled = true;
    r.shadowMap.autoUpdate = false;  // as in the editor: the rig redraws shadows when the lights change
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    this.rig = null;
    this.wantPhysical = false;
    this.wallFaces = [];
    this.center = new THREE.Vector3();
    this.radius = 4;
    const cam = this.camera = new THREE.PerspectiveCamera(38, 1, 0.05, 200);
    this.defaultPolar = 0.9;
    const c = this.controls = new OrbitControls(cam, r.domElement);
    c.enableDamping = true;
    c.maxPolarAngle = Math.PI * 0.47;
    this.frame(new THREE.Box3(new THREE.Vector3(-2, -1.5, -2), new THREE.Vector3(2, 1.2, 2)));
    this.watchOrbit();
    this.vel = {theta: 0, phi: 0, dist: 0, target: new THREE.Vector3()};
    this.playing = false;
    this.atEnd = false;
    this.wantSpin = false;
    this.paused = false;
    this.speed = 1;         // playback speed the viewer chose
    this.rate = 1;          // the speed right now: sped up, the replay still slows down for what is worth watching
    this.time = 1;          // ms on the view's own clock, which runs at that speed
    this.userHeld = false;
    this.userMoved = false;
    this.aimTo = null;
    this.focusTo = null;
    this.wallFades = [];
    this.models = {};       // key -> {root, mask}
    this.retiring = new Set(); // bounded by in-flight shader compilation
    this.retryAt = {};      // key -> when a failed model load may be tried again
    this.wanted = null;
    this.current = null;    // model key fully shown
    this.incoming = null;   // model key fading in
    this.mix = 1;
    this.state = null;
    this.objectIds = new Set();
    this.boxes = {};
    this.forming = new Materializer(scene);
    this.calm = matchMedia('(prefers-reduced-motion: reduce)');
    this.formTag = Object.assign(document.createElement('div'), {className: 'forming', hidden: true});
    container.appendChild(this.formTag);
    this.versionTag = container.querySelector('.room-version');
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.scaffoldController = new AbortController();
    this.resize();
    this.scaffoldUrls = scaffold;
    this.ensureScaffold();
    const loop = () => {if (this.disposed) return; this.animationFrame = requestAnimationFrame(loop); this.tick();};
    loop();
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // Centre the orbit on a room-sized box, from a three-quarter view above.
  frame(box) {
    box.getCenter(this.center);
    this.room = box.clone();
    const size = box.getSize(new THREE.Vector3());
    this.radius = Math.max(size.x, size.z, 3);
    const offset = new THREE.Vector3(1, 1.05, 1.08).normalize().multiplyScalar(this.radius * 2.15);
    this.defaultDist = offset.length();
    this.defaultPolar = new THREE.Spherical().setFromVector3(offset).phi;
    // A late layout refines the overview, but keeps the model's or the viewer's framing.
    if (this.modelsFramed || this.userMoved) return;
    this.camera.position.copy(this.center).add(offset);
    this.controls.target.copy(this.center);
    if (this.orbitStart) {
      this.orbitStart.position.copy(this.camera.position);
      this.orbitStart.target.copy(this.controls.target);
    }
  }

  // Load the point cloud and layout once they exist; a live job may not have them yet, so callers retry.
  ensureScaffold() {
    if (this.disposed || !this.scaffoldUrls || this.scaffoldReady || this.scaffoldLoading) return;
    this.scaffoldLoading = this.loadScaffold(this.scaffoldUrls).catch(() => {}).finally(() => (this.scaffoldLoading = null));
  }

  async loadScaffold({points, layout, colors}) {
    const get = async (url) => {
      const r = await fetch(url, {signal: this.scaffoldController.signal});
      if (!r.ok) throw new Error(`${url}: ${r.status}`);
      return r;
    };
    const [buf, plan] = await Promise.all([get(points).then((r) => r.arrayBuffer()), get(layout).then((r) => r.json())]);
    if (this.disposed) return;
    this.wallFaces = wallFaces(plan);
    const room = new THREE.Box3();
    plan.walls.forEach((w) => room.expandByPoint(new THREE.Vector3(w.a[0], plan.floor, w.a[1])).expandByPoint(new THREE.Vector3(w.b[0], plan.floor + w.h, w.b[1])));
    if (!room.isEmpty()) this.frame(room);
    const pos = new Float32Array(buf), n = pos.length / 3, col = new Float32Array(pos.length);
    const lo = new THREE.Color(this.palette.pointsLo), hi = new THREE.Color(this.palette.pointsHi), tmp = new THREE.Color();
    const h0 = room.isEmpty() ? -1.5 : room.min.y, h1 = room.isEmpty() ? 1.3 : room.max.y;
    for (let i = 0; i < n; i++) {
      tmp.copy(lo).lerp(hi, Math.min(Math.max((pos[i * 3 + 1] - h0) / (h1 - h0 || 1), 0), 1));
      col.set([tmp.r, tmp.g, tmp.b], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.points = new THREE.Points(g, this.unfolding(g, room.isEmpty() ? new THREE.Box3().setFromBufferAttribute(g.attributes.position) : room));
    this.pointCount = n;
    // The scan's own colours, taken from its photos (made on the server the first time, so they may come later).
    if (colors) fetch(colors, {signal: this.scaffoldController.signal}).then((r) => (r.ok ? r.arrayBuffer() : null)).then((rgb) => {
      if (this.disposed || !rgb || rgb.byteLength !== n * 3) return;
      const bytes = new Uint8Array(rgb), c = new THREE.Color();
      for (let i = 0; i < n; i++) c.setRGB(bytes[i * 3] / 255, bytes[i * 3 + 1] / 255, bytes[i * 3 + 2] / 255, THREE.SRGBColorSpace).toArray(col, i * 3);
      g.attributes.color.needsUpdate = true;
    }).catch(() => {});
    this.scene.add(this.points);
    const lineMat = (color, opacity) => new THREE.LineBasicMaterial({color, transparent: true, opacity});
    this.wallLines = new THREE.Group();
    for (const w of plan.walls) {
      const [ax, az] = w.a, [bx, bz] = w.b, len = Math.hypot(bx - ax, bz - az);
      const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(len, w.h, w.t)), lineMat(this.palette.wall, 0.6));
      edge.position.set((ax + bx) / 2, plan.floor + w.h / 2, (az + bz) / 2);
      edge.rotation.y = -Math.atan2(bz - az, bx - ax);
      this.wallLines.add(edge);
    }
    this.scene.add(this.wallLines);
    for (const b of plan.boxes) {
      const group = new THREE.Group();
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(...b.size)), lineMat(this.palette.box, 0.95));
      group.add(edges);
      group.position.set(...b.center);
      group.rotation.y = b.yaw;
      group.visible = false;
      group.userData = {edges, base: edges.material.color.clone()};
      this.boxes[b.id] = group;
      this.scene.add(group);
    }
    this.scaffoldReady = true;
    const chairs = Object.keys(this.boxes).filter(id => /^Chair\d+$/.test(id));
    // Older scaffolds omit dropped boxes. A gap could have held the first member of a cluster.
    const complete = chairs.every(id => Number(id.slice(5)) < chairs.length);
    this.scanChairs = new Set(plan.scan_chairs ?? (complete ? chairs : []));
    if (this.state) this.apply(this.state, this.lastOptions);
  }

  // The scan unfolds from the middle of the room outwards: each point, in turn by its distance from the
  // centre, slides out from near the centre to where it was measured and fades in (reveal: 0 -> 1).
  unfolding(geometry, room) {
    const pos = geometry.attributes.position.array, n = pos.length / 3, start = new Float32Array(n);
    const c = room.getCenter(new THREE.Vector3());
    let far = 0;
    for (let i = 0; i < n; i++) far = Math.max(far, Math.hypot(pos[i * 3] - c.x, pos[i * 3 + 2] - c.z));
    for (let i = 0; i < n; i++) start[i] = 0.68 * Math.hypot(pos[i * 3] - c.x, pos[i * 3 + 2] - c.z) / (far || 1) + 0.04 * Math.random();
    geometry.setAttribute('start', new THREE.BufferAttribute(start, 1));
    const reveal = {value: 0}, centre = {value: c};
    // Solid points in the photos' own colours (no tone mapping), so it looks like the scan itself.
    const m = new THREE.PointsMaterial({size: 0.028, vertexColors: true, transparent: true, opacity: 1, toneMapped: false});
    m.userData.reveal = reveal;
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, {reveal, centre});
      shader.vertexShader = 'uniform float reveal;\nuniform vec3 centre;\nattribute float start;\nvarying float shown;\n' +
        shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
          shown = smoothstep(start, start + 0.28, reveal);
          transformed.xz = mix(centre.xz + (transformed.xz - centre.xz) * 0.55, transformed.xz, shown);`);
      shader.fragmentShader = 'varying float shown;\n' + shader.fragmentShader.replace('#include <alphatest_fragment>',
        'if (shown <= 0.0) discard;\ndiffuseColor.a *= shown;\n#include <alphatest_fragment>');
    };
    m.customProgramCacheKey = () => 'scan-unfold';
    return m;
  }

  // ---------- room models ----------
  async model(key, url, digest) {
    if (this.disposed) return null;
    if (this.models[key]) return this.models[key].promise;
    // A live job can list a model while it is still being written: after a failed load, try again later.
    if (performance.now() < (this.retryAt[key] || 0)) throw new Error(`retry ${key} later`);
    // Each live draft overwrites the final file. FileLoader coalesces in-flight loads by URL.
    if (key.startsWith('draft')) {
      const version = new URL(url, globalThis.location?.href);
      if (version.protocol === 'http:' || version.protocol === 'https:') {
        version.searchParams.set('draft', key);
        url = version.href;
      }
    }
    const entry = this.models[key] = {controller: new AbortController()};
    entry.promise = loadModel(url, digest, entry.controller.signal).catch((error) => {
      if (this.models[key] === entry) {
        delete this.models[key];
        this.retryAt[key] = performance.now() + 5000;
      }
      throw error;
    }).then((gltf) => {
      if (this.disposed || entry.controller.signal.aborted || this.models[key] !== entry) {
        disposeModel(gltf.scene);
        return null;
      }
      const root = this.prepare(gltf.scene, gltf.parser?.associations);
      root.visible = false;
      this.scene.add(root);
      entry.root = root;
      entry.warming = this.warm(root, entry.controller.signal).catch(() => {});
      entry.prefetching = prefetch(root, {signal: entry.controller.signal}).catch(() => {});
      if (!this.modelsFramed && !this.scaffoldReady) {this.frame(new THREE.Box3().setFromObject(root)); this.modelsFramed = true;}
      if (key === 'seed' && this.state?.model === 'final' && this.state.added) this.apply(this.state, this.lastOptions);
      return entry;
    });
    return entry.promise;
  }

  prepare(root, associations) {
    root.userData.replayRoot = true;
    offsetDecals(THREE, root, associations);
    const sources = new Set();
    root.traverse(o => {if (o.isMesh) [o.material].flat().forEach(m => sources.add(m));});
    root.userData.sourceMaterials = [...sources];
    const aniso = this.renderer.capabilities.getMaxAnisotropy();
    root.traverse((o) => {
      if (HIDDEN.test(o.name)) o.visible = false;
      if (!o.isMesh) return;
      for (const m of [o.material].flat()) for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap']) if (m[k]) m[k].anisotropy = aniso;
    });
    const lights = [];
    root.traverse((o) => {if (o.isLight) lights.push(o);});
    lights.forEach((l) => l.removeFromParent());
    // Walls and large wall-mounted parts fade when they sit between the camera and the room. Unfaded they
    // draw as they were made: an opaque wall before what blends on it (a photo collage cut out of its photo),
    // which keeps from writing depth, or its clear texels would hide the wall wherever that is drawn after it.
    const wallMats = new Set();
    for (const part of root.children.filter((o) => WALLISH.test(o.name))) {
      const mats = [];
      part.traverse((o) => {
        if (!o.isMesh) return;
        const copies = [o.material].flat().map(material => {
          const copy = material.clone();
          Object.assign(copy.userData, {base: copy.opacity, transparent: copy.transparent, depthWrite: copy.depthWrite});
          mats.push(copy); wallMats.add(copy);
          return copy;
        });
        o.material = Array.isArray(o.material) ? copies : copies[0];
        // What blends on a wall (the photo collage) draws after it. Once the wall fades both are sorted by
        // distance, and their centres differ, so turning the camera swapped them and the collage flickered.
        if (copies.some((m) => m.userData.transparent)) o.renderOrder = 1;
      });
      const c = new THREE.Box3().setFromObject(part).getCenter(new THREE.Vector3());
      this.wallFades.push({mats, c, root, part, a: 1});
    }
    const windows = root.userData.windows = new Map(), backdrops = [];
    root.updateWorldMatrix(true, true);
    const collectWindows = (part) => {
      if (!WINDOW.test(part.name) && !BACKDROP.test(part.name)) {part.children.forEach(collectWindows); return;}
      if (WINDOW.test(part.name)) {
        windows.set(part.name, windows.has(part.name) ? null : {part, box: openingBox(part)});
      }
      // Wall materials already have private copies. A standalone window may share its paint with furniture.
      part.traverse(o => {
        if (BACKDROP.test(o.name)) backdrops.push(o);
        if (!o.isMesh) return;
        o.userData.replayWindowMesh = true;
        const copies = [o.material].flat().map(m => wallMats.has(m) ? m : m.clone());
        o.material = Array.isArray(o.material) ? copies : copies[0];
      });
    };
    root.children.forEach(collectWindows);
    for (const window of windows.values()) if (window) window.parts = windowParts(window.part, backdrops);
    const all = new Set();
    root.traverse((o) => {if (o.isMesh) [o.material].flat().forEach((m) => all.add(m));});
    root.userData.fadeMats = [...all].map((m) => ({m, opacity: m.userData.base ?? m.opacity, transparent: m.transparent,
      depthWrite: m.depthWrite, polygonOffset: m.polygonOffset, factor: m.polygonOffsetFactor, units: m.polygonOffsetUnits, wall: wallMats.has(m)}));
    root.userData.fade = 1;
    // Depth mask for fading in: only the outermost surfaces of the incoming model get colour.
    const mask = new THREE.MeshBasicMaterial({colorWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4});
    // A picture's mask carries the picture's offset too (see setFade).
    const decalMask = mask.clone();
    decalMask.polygonOffsetFactor += DECAL_OFFSET.factor; decalMask.polygonOffsetUnits += DECAL_OFFSET.units;
    root.userData.sourceMaterials.push(mask, decalMask);
    root.userData.mask = [];
    const meshes = [];
    root.traverse((o) => {if (o.isMesh) meshes.push(o);});
    for (const o of meshes) {
      if ([o.material].flat().some((m) => wallMats.has(m) || m.transparent || m.opacity < 1 || m.transmission > 0)) continue;
      const maskOf = (x) => x.polygonOffset && x.polygonOffsetUnits < 0 ? decalMask : mask;
      const m = new THREE.Mesh(o.geometry, Array.isArray(o.material) ? o.material.map(maskOf) : maskOf(o.material));
      m.userData.mask = 'depth';
      m.userData.forming = 0;
      m.renderOrder = 1;
      m.visible = false;
      o.add(m);
      root.userData.mask.push(m);
    }
    return root;
  }

  // Compile, in the background, the shaders of every object (also of the clipped copies it takes shape with),
  // and upload its textures, a few per frame: objects stay hidden until built, and would otherwise do both
  // when they appear, stalling the page. Model materials and the view's effect pool retain shader programs;
  // temporary proxies can be released once compilation finishes.
  async warm(root, signal) {
    const group = new THREE.Group(), seen = new Map(), textures = new Set();
    root.updateWorldMatrix(true, true);
    root.traverse((o) => {
      if (!o.isMesh || o.userData.mask) return;
      for (const m of [o.material].flat()) {
        if (seen.has(m)) continue;
        seen.set(m, o);
        for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap']) if (m[k]) textures.add(m[k]);
      }
    });
    const add = (proxy, o) => {
      proxy.matrixAutoUpdate = false;
      if (o) proxy.matrix.copy(o.matrixWorld);
      group.add(proxy);
    };
    for (const [m, o] of seen) {
      add(new THREE.Mesh(o.geometry, m), o);
      add(new THREE.Mesh(o.geometry, this.forming.clipped(m, root)), o);
    }
    this.forming.standIns().forEach((x) => add(x));
    root.userData.warm = group;
    group.updateMatrixWorld(true);
    const compiling = this.renderer.compileAsync(group, this.camera, this.scene).catch(() => {});
    try {
      let k = 0;
      for (const t of textures) {
        if (signal?.aborted || this.disposed) break;
        this.renderer.initTexture(t);
        if (++k % 4 === 0) await new Promise((r) => requestAnimationFrame(r));
      }
      await compiling;
    } finally {
      group.clear();
      if (root.userData.warm === group) delete root.userData.warm;
    }
  }

  setFade(root, f) {
    if (!root || root.userData.fade === f) return;
    root.userData.fade = f;
    if (f === 0) for (const wall of this.wallFades) if (wall.root === root) this.fadeWall(wall);
    for (const x of root.userData.fadeMats) {
      if (x.wall || this.windowHandoff?.materials.has(x.m)) continue;
      const transparent = f < 1 || x.transparent;
      if (x.m.transparent !== transparent) {x.m.transparent = transparent; x.m.needsUpdate = true;}
      x.m.opacity = x.opacity * f;
      x.m.depthWrite = f < 1 ? false : x.depthWrite;
      // Fading adds its own offset on top of a picture's, so the picture still wins over its backing.
      x.m.polygonOffset = f < 1 || x.polygonOffset;
      x.m.polygonOffsetFactor = f < 1 ? -1 + (x.polygonOffset ? Math.min(x.factor, 0) : 0) : x.factor;
      x.m.polygonOffsetUnits = f < 1 ? -4 + (x.polygonOffset ? Math.min(x.units, 0) : 0) : x.units;
    }
    const masking = f > 0 && f < 1;
    for (const m of root.userData.mask) {
      m.userData.fadeVisible = masking && !this.windowHandoff?.masks.has(m);
      m.visible = m.userData.fadeVisible && !m.userData.forming;
    }
  }

  fadeWall(w) {
    const receiving = w.a > 0.97 && w.root.userData.fade === 1;
    if (w.receivers && receiving !== w.receiving) {
      for (const mesh of w.receivers) mesh.receiveShadow = receiving;
      w.receiving = receiving;
    }
    for (const m of w.mats) {
      const f = this.windowHandoff?.materials.has(m) ? 1 : w.root.userData.fade;
      const solid = w.a > 0.97 && f === 1;
      const transparent = m.userData.transparent || !solid;
      if (m.transparent !== transparent) {m.transparent = transparent; m.needsUpdate = true;}
      m.opacity = m.userData.base * w.a * f;
      m.depthWrite = solid && m.userData.depthWrite && m.userData.base > 0.9;
    }
  }

  // Bring a model in: it fades in over the one shown now (quiet: switch at once, e.g. while scrubbing).
  async show(key, url, quiet, digest) {
    const previous = this.wanted, changed = key !== previous;
    this.wanted = key;
    this.quiet = quiet;
    // Keep the fading backdrop during playback and when pausing on the same pending target.
    const nextFade = !quiet && key !== this.current && (this.models[key]?.root || url);
    if (changed && this.incoming && this.incoming !== key && (!key || (this.current && !nextFade))) {
      const cancelled = this.incoming, root = this.models[cancelled].root;
      this.restoreWindows();
      this.forming.finishModel(root);
      root.visible = false;
      this.setFade(root, 1);
      if (this.partsShown === root) this.partsShown = null;
      this.incoming = null;
      this.mix = 1;
      if (cancelled.startsWith('draft')) this.drop(cancelled);
    }
    if (changed && previous?.startsWith('draft') && previous !== this.current && previous !== this.incoming) this.drop(previous);
    if (!key) {if (changed || this.current) this.swap(null); return;}
    if (key === this.current) return;
    let entry = this.models[key];
    const loading = !entry?.root;
    if (loading) {
      if (this.disposed || !url || performance.now() < (this.retryAt[key] || 0)) return;
      entry = await this.model(key, url, digest).catch(() => null);
      if (!entry || this.disposed || this.wanted !== key || this.models[key] !== entry) return;
      if (this.current === key || this.incoming === key) return;
    }
    if (this.incoming && this.incoming !== key) this.swap(this.incoming);
    if (this.quiet) this.swap(key);
    else if (this.incoming !== key) {
      this.incoming = key;
      this.mix = 0;
      entry.root.visible = true;
      const {appeared} = this.revealModel(key);
      this.handoffWindows(this.models[this.current]?.root, entry.root);
      this.setFade(entry.root, 0);
      this.materialize(appeared);
    }
    if (loading && this.state) this.apply(this.state, {...this.lastOptions, quiet: this.quiet});
  }

  handoffWindows(outgoing, incoming) {
    if (!outgoing) return;
    // A matched window and its exterior plate enter together, with the plate still in the transmission pass.
    const oldParts = new Set(), newParts = new Set();
    for (const [name, next] of incoming.userData.windows) {
      const old = outgoing.userData.windows.get(name);
      if (!old || !next || !sameOpening(old.box, next.box)) continue;
      const from = old.parts, to = next.parts;
      if (!to.length || from.length !== to.length ||
          !to.every((part, i) => sameModelPath(part, from[i]) && shown(part) && shown(from[i]))) continue;
      from.forEach(part => oldParts.add(part));
      to.forEach(part => newParts.add(part));
    }
    const handoff = this.windowHandoff = {hidden: oldParts, materials: new Set(), masks: new Set()};
    for (const part of oldParts) part.visible = false;
    for (const part of newParts) {
      part.traverse(o => {
        if (o.userData.mask) handoff.masks.add(o);
        else if (o.isMesh) for (const m of [o.material].flat()) handoff.materials.add(m);
      });
    }
  }

  restoreWindows() {
    this.windowHandoff?.hidden.forEach(part => {part.visible = true;});
    this.windowHandoff = null;
  }

  // The finished room, lit like the editor's 物理光照: the editor's own rig (../editor/time-lighting.mjs), so
  // the replay follows any change made there. Off again (the replay's own lights) when the replay goes back.
  physical(on) {
    this.wantPhysical = !!on;
    // render() requests lighting before it applies the timeline's model. Enter on the next settled frame.
    if (on || !this.rig) return;
    const {hemisphere, sun, fill} = this.lights;
    this.forming.finishAll();
    this.rig.dispose();
    this.rig = null;
    for (const {mesh, castShadow, receiveShadow} of this.saved.shadows) Object.assign(mesh, {castShadow, receiveShadow});
    Object.assign(hemisphere, {visible: true, intensity: this.saved.hemisphere});
    hemisphere.groundColor.copy(this.saved.groundColor);
    Object.assign(sun, {visible: true, castShadow: false, intensity: this.saved.sun});
    sun.color.copy(this.saved.sunColor);
    sun.position.copy(this.saved.sunAt);
    sun.target.position.copy(this.saved.sunTarget);
    sun.target.updateWorldMatrix(true, false);
    fill.visible = false;
    this.scene.environmentIntensity = this.saved.environment;
    this.scene.background.copy(this.saved.background);
    this.saved = null;
    this.relinkWalls();
  }

  enablePhysical(root) {
    const {hemisphere, sun} = this.lights;
    this.forming.finishAll();
    this.saved = {hemisphere: hemisphere.intensity, groundColor: hemisphere.groundColor.clone(),
      sun: sun.intensity, sunColor: sun.color.clone(), sunAt: sun.position.clone(), sunTarget: sun.target.position.clone(),
      environment: this.scene.environmentIntensity, background: this.scene.background.clone(), shadows: []};
    root.updateWorldMatrix(true, true);
    // The floor's and the wall's own meshes: the model nests furniture under Floor0 (and things under walls).
    const box = (name) => {const o = root.getObjectByName(name); return o ? surfaceBox(THREE, o) : null;};
    const bounds = new THREE.Box3().setFromObject(root);
    const floorY = box('Floor0')?.max.y ?? bounds.min.y, ceilingY = box('Wall0')?.max.y ?? bounds.max.y;
    const config = roomConfig(root, this.wallFaces, ceilingY, this.lastOptions?.openings?.Window);
    // fadeMats records transparency before either wall or model fading changes the material.
    const opaqueMaterials = new Set(), blendedMaterials = new Set();
    for (const {m, transparent, opacity} of root.userData.fadeMats) {
      if (m.transmission > 0) continue;
      if (!transparent) opaqueMaterials.add(m);
      else if (opacity < 1) blendedMaterials.add(m);
    }
    root.traverse(mesh => {
      if (!mesh.isMesh) return;
      const materials = [mesh.material].flat();
      const opaque = !mesh.userData.mask && materials.every(m => opaqueMaterials.has(m));
      const receives = !mesh.userData.mask && materials.every(m => !(m.transmission > 0)
        && !(blendedMaterials.has(m) && blendedPane(mesh, m, config.windowRoots)));
      this.saved.shadows.push({mesh, opaque, receives, castShadow: mesh.castShadow, receiveShadow: mesh.receiveShadow});
    });
    sun.shadow.mapSize.set(2048, 2048);
    this.rig = createTimeLighting(THREE, {renderer: this.renderer, scene: this.scene, room: root, config,
      walls: this.wallFaces, bounds, floorY, ceilingY, profile: lightingProfile()});
    this.rig.apply('physical');
    for (const {mesh, opaque, receives} of this.saved.shadows) {
      mesh.castShadow = opaque && mesh.name !== 'Floor0';
      mesh.receiveShadow = receives;
    }
    this.relinkWalls(root);
  }

  // Near walls fade through whatever material each wall mesh shows now (the lighting rig swaps in its own).
  relinkWalls(physicalRoot) {
    for (const w of this.wallFades) {
      w.mats = [];
      w.receivers = w.root === physicalRoot ? [] : null;
      w.receiving = null;
      w.part.traverse((o) => {
        if (!o.isMesh || o.userData.mask) return;
        if (o.receiveShadow) w.receivers?.push(o);
        for (const m of [o.material].flat()) {
          m.userData.base ??= m.opacity;
          m.userData.transparent ??= m.transparent;
          m.userData.depthWrite ??= m.depthWrite;
          w.mats.push(m);
        }
      });
    }
  }

  swap(key) {
    this.restoreWindows();
    if (this.rig) {this.physical(false); this.wantPhysical = true;}
    const outgoing = this.models[this.current]?.root;
    if (outgoing) this.forming.finishModel(outgoing);
    if (this.partsShown === outgoing) this.partsShown = null;
    for (const [k, e] of Object.entries(this.models)) if (e.root) {e.root.visible = k === key; this.setFade(e.root, 1);}
    this.current = key;
    this.incoming = null;
    this.mix = 1;
    // A live job's room-in-progress comes as a newer copy every few minutes; free the ones no longer shown.
    for (const k of Object.keys(this.models)) {
      const replaced = key?.startsWith('articulated:') && k.startsWith('articulated:');
      if (k !== key && k !== this.wanted && (k.startsWith('draft') || replaced)) this.drop(k);
    }
  }

  drop(key) {
    const entry = this.models[key];
    if (!entry) return;
    entry.controller.abort();
    delete this.models[key];
    const root = entry.root;
    if (this.rig && this.current === key) this.physical(false);
    if (this.current === key) this.current = null;
    if (this.incoming === key) {this.restoreWindows(); this.incoming = null; this.mix = 1;}
    if (this.wanted === key) this.wanted = null;
    if (!root) return;
    this.forming.finishModel(root);
    this.wallFades = this.wallFades.filter(wall => wall.root !== root);
    if (this.partsShown === root) this.partsShown = null;
    root.userData.warm?.clear();
    root.removeFromParent();
    entry.root = null;
    // Three's compileAsync polls live material properties. Disposing a material
    // during that poll leaves an unresolved promise and a late timer exception.
    // Detach now, then release GPU resources once that already-started work ends.
    const retiring = Promise.resolve(entry.warming).then(() => {
      this.forming.releaseModel(root);
      disposeModel(root);
    }).finally(() => this.retiring.delete(retiring));
    this.retiring.add(retiring);
    return retiring;
  }

  // partial: show the room as it is being built (shell + finished objects of the assembled room);
  // full: show the reached model as it is.
  apply(state, {quiet = false, modelUrl, openings, addedAll} = this.lastOptions || {}) {
    this.state = state;
    this.lastOptions = {quiet, modelUrl, openings, addedAll};
    const seedUrl = modelUrl?.('seed');
    const model = state.model || (state.shell && seedUrl ? 'seed' : null);
    const digest = model === 'articulated' && state.modelEvent?.artifact_digest;
    // Reparented seed meshes need their original names before the final room can be masked.
    const waitingForSeed = model === 'final' && state.added && seedUrl && !this.models.seed?.root;
    const key = waitingForSeed ? null : digest ? `${model}:${digest}` : model;
    const partial = !state.model && key === 'seed';
    if (key !== this.wanted || quiet !== this.quiet || (key && !this.models[key])) this.show(key, key && modelUrl?.(model), quiet, digest);
    const inRoom = !!key && (this.current === key || this.incoming === key);
    const hasRoom = !!(this.current || this.incoming);
    if (this.points) {
      this.points.material.userData.reveal.value = state.points;
      this.points.material.opacity = state.pointsFade;
      this.points.material.depthWrite = state.pointsFade === 1;
      this.points.visible = !hasRoom && state.pointsFade > 0;
    }
    if (this.wallLines) {
      this.wallLines.visible = state.walls > 0 && !hasRoom;
      this.wallLines.children.forEach((l) => (l.material.opacity = 0.6 * state.walls));
    }
    if (inRoom) this.models[key].root.userData.modelEvent = state.modelEvent;
    if (quiet && inRoom) this.forming.finishModel(this.models[key].root);
    const {shown: placed, appeared} = inRoom ? this.revealModel(key) : {};
    if (inRoom && !quiet) this.materialize(appeared);
    for (const [id, group] of Object.entries(this.boxes)) {
      const done = state.built.has(id);
      // Boxes stand for what is not in the room yet; a finished object without a room model gets a gold outline.
      group.visible = state.boxes && !state.model && !(partial && inRoom && placed.has(id));
      group.userData.edges.material.color.copy(done ? new THREE.Color(this.palette.built) : group.userData.base);
    }
    this.updateChairBoxes();
    // Load the final model alongside the seed so the switch starts on time.
    if ((key === 'seed' || waitingForSeed) && modelUrl?.('final') && !this.models.final) this.model('final', modelUrl('final')).catch(() => {});
    // Fetch the first room model from the start (it is tens of MB), so the modelling stage never waits on it.
    if (seedUrl && !this.models.seed) this.model('seed', seedUrl).catch(() => {});
  }

  revealModel(key) {
    if (this.state && key === 'seed') {
      const result = this.revealed(!this.state.model, this.state.built);
      if (result.appeared.length > MAX_GROUP) result.appeared = [];
      return result;
    }
    return {appeared: this.state && key === 'final' ? this.reveal(this.state.added) : []};
  }

  // Agent-added parts of the final model: show only those in `added` (null shows all). A part that appears
  // while playing fades in; after a seek it is simply there.
  reveal(added) {
    const root = this.models.final?.root, appeared = [];
    const all = this.lastOptions?.addedAll ?? (this.revealPlan?.root === root ? this.revealPlan?.all : null);
    if (!root || !all) return appeared;
    root.userData.interpolated = !!added;
    const seed = this.models.seed?.root;
    if (this.revealPlan?.root !== root || this.revealPlan.seed !== seed || this.revealPlan.all !== all) {
      if (this.revealPlan?.root === root) {
        if (this.forming.active.size) this.forming.finishModel(root);
        // A newly loaded seed can identify a whole retained branch that was previously split.
        for (const [, parts] of this.revealPlan.parts) for (const node of parts) node.visible = !HIDDEN.test(node.name);
      }
      const known = new Set();
      if (seed) seed.traverse(o => {if (o !== seed && originalName(o)) known.add(originalName(o));});
      else for (const id of this.objectIds || []) {
        known.add(id);
        for (const name of sceneNames(id, this.chairClusters)) known.add(name);
      }
      this.revealPlan = {root, seed, all, parts: revealParts(root, all, known)};
    }
    const inView = this.current === 'final' || this.incoming === 'final';
    // The parts already there when the final model comes in take shape too, rather than fade in with it.
    const fresh = added && inView && this.partsShown !== root;
    if (inView) this.partsShown = added ? root : null;
    for (const [name, parts] of this.revealPlan.parts) for (const node of parts) {
      const show = !HIDDEN.test(node.name) && (!added || added.has(name));
      const appears = show && (!node.visible || fresh);
      node.visible = show;
      if (appears) appeared.push(node);
    }
    return appeared;
  }

  // The objects wait (hidden) until the camera has moved in, then take shape: from the floor up, one after
  // another within a few seconds.
  materialize(nodes) {
    if (!nodes.length || this.calm.matches) return;
    if (!this.forming.waiting()) this.heldSince = this.time;
    const low = (o) => new THREE.Box3().setFromObject(o).min;
    const order = nodes.map((o) => [o, low(o)]).sort(([, a], [, b]) => Math.round(a.y * 5) - Math.round(b.y * 5) || a.x + a.z - b.x - b.z);
    const step = Math.min(CASCADE_STEP, CASCADE_SECONDS / nodes.length);
    order.forEach(([node], k) => this.forming.start(node, {held: !this.userHeld, delay: k * step, skipWindows: !!this.windowHandoff}));
  }

  // In partial mode hide the assembled room's objects that are not finished yet; returns the ids shown and the
  // objects that just became visible.
  revealed(partial, built) {
    const root = this.models.seed?.root, shown = new Set();
    const appeared = [];
    if (!root) return {shown, appeared};
    root.userData.interpolated = partial;
    if (this.chairClusters) root.userData.chairClusters = this.chairClusters;
    else if (partial && (root.userData.clusterIds !== this.objectIds || root.userData.scanChairs !== this.scanChairs)) {
      root.userData.clusterIds = this.objectIds;
      root.userData.scanChairs = this.scanChairs;
      root.userData.chairClusters = cachedChairClusters(root, this.objectIds, this.scanChairs);
    }
    const keep = new Set();
    if (partial) for (const id of built) for (const node of nodesFor(root, id)) {
      keep.add(node); shown.add(id); shown.add(node.name);
      if (/^ChairCluster\d+$/.test(node.name)) {
        if (!node.userData.chairBoxes) {
          node.userData.chairBoxes = [];
          node.traverse(o => {if (/^Chair\d+$/.test(o.name)) node.userData.chairBoxes.push(o.name);});
        }
        node.userData.chairBoxes.forEach(id => shown.add(id));
      }
    }
    for (const o of root.children) {
      const show = !HIDDEN.test(o.name) && (!partial || SHELL.test(o.name) || keep.has(o));
      if (show && !o.visible && !SHELL.test(o.name)) appeared.push(o);
      o.visible = show;
    }
    return {shown, appeared};
  }

  // During the staggered reveal, a chair waiting for its turn still needs its scan box.
  updateChairBoxes() {
    const seed = this.models.seed?.root;
    if (!this.state?.boxes || this.state.model || !this.state.shell || !seed?.visible) return;
    for (const [node, effect] of this.forming.active) {
      if (node.parent !== seed || !/^Chair(?:Cluster)?\d+$/.test(node.name) || !node.visible) continue;
      for (const id of node.userData.chairBoxes || [node.name]) {
        if (this.boxes[id]) this.boxes[id].visible = effect.held || effect.t <= 0;
      }
    }
  }

  boundsOf(key) {
    const box = new THREE.Box3();
    const root = this.current && this.models[this.current]?.root;
    const nodes = partsOf(root, key);
    if (!nodes.length) nodes.push(...partsOf(this.models.final?.root, key));
    if (nodes.length) nodes.forEach((n) => box.expandByObject(n));
    else if (this.boxes[key]) box.setFromObject(this.boxes[key]);
    return box;
  }

  // ---------- camera direction (the page decides when to spin, aim or pose) ----------
  watchOrbit() {
    const c = this.controls;
    c.addEventListener('start', () => {
      this.orbitStart = {position: this.camera.position.clone(), target: c.target.clone()};
    });
    c.addEventListener('change', () => {
      const start = this.orbitStart;
      if (start && !this.userHeld && (start.position.distanceToSquared(this.camera.position) > 1e-12 ||
        start.target.distanceToSquared(c.target) > 1e-12)) {
        this.userHeld = this.userMoved = true;
        this.stopCamera();
      }
    });
    c.addEventListener('end', () => {
      this.orbitStart = null;
      if (this.atEnd) this.resumeOverview();
    });
  }
  resumeOverview() {
    this.userHeld = false;
    this.clearAim();
  }
  stopCamera() {
    this.aimTo = this.focusTo = null;
    this.vel.theta = this.vel.phi = this.vel.dist = 0;
    this.vel.target.set(0, 0, 0);
  }
  setPlaying(playing, end = false) {
    if (playing && !this.playing) this.userHeld = false;
    const atEnd = end && !playing;
    if (atEnd && !this.atEnd && !this.orbitStart) this.resumeOverview();
    this.atEnd = atEnd;
    this.playing = playing;
    this.wantSpin = playing || end;
    const paused = !this.wantSpin;
    if (this.paused === paused) return;
    this.paused = paused;
    this.lastTick = performance.now();
    this.controls.enableDamping = !paused;
    if (!paused) return;
    this.stopCamera();
    // Flush OrbitControls' pending drag without applying that remaining motion to the paused frame.
    const position = this.camera.position.clone(), target = this.controls.target.clone();
    this.controls.update();
    this.camera.position.copy(position);
    this.controls.target.copy(target);
    this.controls.update();
  }
  // Turn to what was just built; close (moves in toward the objects) while they take shape.
  aim(keys, {close = false} = {}) {
    const box = new THREE.Box3();
    keys.forEach((k) => box.union(this.boundsOf(k)));
    if (box.isEmpty()) return false;
    const o = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3()).length();
    const dir = new THREE.Vector2(this.center.x - o.x, this.center.z - o.z);
    const off = this.camera.position.clone().sub(this.controls.target);
    const az = dir.length() > 0.3 ? Math.atan2(dir.x, dir.y) : Math.atan2(off.x, off.z);
    if (!close) {
      this.aimTo = {az, polar: null, dist: null, target: this.center.clone().lerp(o, 0.4), at: 0};
      return true;
    }
    // Already in clear view from where the camera is: stay (and go on watching from here), rather than
    // moving for every object.
    if (this.wellSeen(keys, box)) {
      if (this.aimTo?.at) this.aimTo.at = this.time;
      return false;
    }
    // Close: the object fills most of the view, seen from where nothing stands in front of it.
    const dist = THREE.MathUtils.clamp(size / 2 * 3.2, 2.2, this.defaultDist * 0.7);
    const {az: best, polar} = this.clearView(keys, box, az, dist);
    this.aimTo = {az: best, polar, dist, target: o, at: 0, close: true};
    return true;
  }

  // What could stand between the camera and the given objects: furniture, and (counted less, as near walls
  // fade) walls, pillars and openings.
  blockers(keys) {
    const root = this.models[this.incoming || this.current]?.root, mine = new Set();
    for (const k of keys) partsOf(root, k).forEach((n) => n.traverse((o) => mine.add(o)));
    const things = [], walls = [];
    root?.traverse((o) => {
      if (!o.isMesh || o.userData.mask || mine.has(o) || !visibleFrom(o, root) || /^Floor/.test(o.name)) return;
      let wall = false;
      for (let p = o; p && p !== root; p = p.parent) if (WALLISH.test(p.name) || SHELL.test(p.name)) wall = true;
      (wall ? walls : things).push(o);
    });
    return {things, walls};
  }

  // Points of a box to keep in sight: its middle and four upper corners pulled in.
  static marks(box) {
    const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3()).multiplyScalar(0.35);
    return [c, ...[[1, 1], [-1, 1], [1, -1], [-1, -1]].map(([x, z]) => c.clone().add(new THREE.Vector3(x * s.x, s.y, z * s.z)))];
  }

  // Share of the marks hidden from cam (0..1; a wall in front counts less).
  static hidden(cam, marks, {things, walls}) {
    const ray = new THREE.Raycaster(), d = new THREE.Vector3();
    let hidden = 0;
    for (const m of marks) {
      d.subVectors(m, cam);
      ray.set(cam, d.clone().normalize());
      ray.far = d.length() - 0.05;
      hidden += ray.intersectObjects(things, false).length ? 1 : ray.intersectObjects(walls, false).length ? 0.5 : 0;
    }
    return hidden / marks.length;
  }

  // The objects fill a fair part of the view, inside it, and nothing hides them.
  wellSeen(keys, box) {
    if (this.aimTo && !this.aimTo.close) return false;
    const cam = this.camera, pts = [];
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) pts.push(new THREE.Vector3(x, y, z).project(cam));
    if (pts.some((q) => Math.abs(q.x) > 0.8 || Math.abs(q.y) > 0.8 || q.z > 1)) return false;
    const reach = Math.max(...pts.map((q) => q.x)) - Math.min(...pts.map((q) => q.x)), tall = Math.max(...pts.map((q) => q.y)) - Math.min(...pts.map((q) => q.y));
    if (Math.max(reach, tall) < 0.45) return false;
    return RoomView.hidden(cam.position, RoomView.marks(box), this.blockers(keys)) === 0;
  }

  // Where to look at a box from (azimuth, polar): least hidden, inside the room and clear of its walls, little
  // turning; a higher view when the usual one is blocked.
  clearView(keys, box, preferred, dist) {
    const blockers = this.blockers(keys), marks = RoomView.marks(box), c = box.getCenter(new THREE.Vector3());
    const now = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target)).theta;
    const cam = new THREE.Vector3();
    const inside = this.room?.clone().expandByScalar(-0.4);
    let best = {az: preferred, polar: CLOSE_POLAR}, bestScore = Infinity;
    for (const [polar, cost] of [[CLOSE_POLAR, 0], [HIGH_POLAR, 0.25]]) {
      for (const step of [0, 1, -1, 2, -2, 3, -3, 4, -4, 6]) {
        const az = preferred + step * Math.PI / 6;
        cam.copy(c).add(new THREE.Vector3().setFromSphericalCoords(dist, polar, az));
        const outside = inside && !inside.isEmpty() && !inside.containsPoint(new THREE.Vector3(cam.x, inside.min.y, cam.z)) ? 1 : 0;
        const turn = Math.abs(Math.atan2(Math.sin(az - now), Math.cos(az - now)));
        const score = RoomView.hidden(cam, marks, blockers) * 3 + outside * 1.5 + turn * 0.15 + cost;
        if (score < bestScore) {bestScore = score; best = {az, polar};}
      }
    }
    return best;
  }
  pose(az, polar) {this.aimTo = {az, polar, dist: null, target: this.center, at: 0};}
  settledFor() {return this.aimTo?.at ? this.time - this.aimTo.at : 0;}
  // What is going on that is worth watching: the camera is on its way to an object ('move'), or an object
  // takes shape or a new model fades in ('form').
  showing() {
    if (this.aimTo && !this.aimTo.at && !this.userHeld) return 'move';
    return this.incoming || this.forming.active.size ? 'form' : null;
  }
  clearAim() {
    this.aimTo = null;
    this.focusTo = this.center;
  }

  tick() {
    if (this.disposed) return;
    const now = performance.now();
    // A live update can fade in a draft while the camera stays still.
    const animate = !this.paused || this.lastOptions?.quiet === false;
    const elapsed = animate ? (now - (this.lastTick ?? now)) / 1000 : 0;
    // Sped up, the replay still runs at normal speed while the camera moves in, only a little faster while
    // an object takes shape, and fast in between: the camera work is that of normal speed (the camera itself
    // never moves faster, it would whip round the room).
    const showing = this.speed > 1 && this.showing();
    this.rate = showing === 'move' ? 1 : showing ? Math.sqrt(this.speed) : this.speed;
    const dt = this.paused ? 0 : Math.min(elapsed, 0.05) * Math.min(this.rate, 1);  // camera motion: small steps even after a slow frame
    const fdt = Math.min(elapsed, 0.25) * this.rate;     // fades follow the clock, so they finish on time at low frame rates
    this.lastTick = now;
    this.time += elapsed * 1000 * this.rate;
    if (this.incoming && fdt > 0) {
      this.mix = Math.min(this.mix + fdt / FADE_SECONDS, 1);
      this.setFade(this.models[this.incoming].root, this.mix);
      // A forward request may still be loading when its backdrop finishes fading.
      const waitingForNext = !this.quiet && this.wanted && this.wanted !== this.current
        && this.models[this.wanted] && !this.models[this.wanted].root;
      if (this.mix >= 1 && (this.wanted === this.incoming || waitingForNext)) this.swap(this.incoming);
    }
    // Held objects take shape once the camera has arrived (or the user moves it, or it takes too long).
    const frozenRoot = this.current !== this.wanted ? this.models[this.current]?.root : null;
    if (this.forming.waiting() && (!this.aimTo || this.aimTo.at || this.userHeld || this.time - this.heldSince > MAX_WAIT)) this.forming.release(frozenRoot);
    if (this.wantPhysical && !this.rig && this.current && this.wanted === this.current && !this.incoming) {
      this.enablePhysical(this.models[this.current].root);
    }
    this.controls.autoRotate = false;
    if (!this.orbitStart && !this.userHeld && dt > 0) {
      const tgt = this.controls.target, v = this.vel, a = this.aimTo;
      const sph = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(tgt));
      if (a) {
        const dTheta = a.az == null ? 0 : Math.atan2(Math.sin(a.az - sph.theta), Math.cos(a.az - sph.theta));
        // Moving in close to watch an object is quicker, so the camera is there when it takes shape.
        const time = a.close ? 0.9 : 1.3, fast = a.close ? 1.6 : 1;
        if (a.az == null) {v.theta *= Math.exp(-dt * 4); sph.theta += v.theta * dt;}
        else {const [o, nv] = smoothDamp(0, dTheta, v.theta, time, 0.9 * fast, dt); sph.theta += o; v.theta = nv;}
        if (a.polar != null) {const [o, nv] = smoothDamp(sph.phi, a.polar, v.phi, time, 0.6 * fast, dt); sph.phi = o; v.phi = nv;}
        if (a.dist != null) {const [o, nv] = smoothDamp(sph.radius, a.dist, v.dist, time, 4 * fast, dt); sph.radius = o; v.dist = nv;}
        for (const k of ['x', 'y', 'z']) {const [o, nv] = smoothDamp(tgt[k], a.target[k], v.target[k], time, 1.5 * fast, dt); tgt[k] = o; v.target[k] = nv;}
        // Arrived once what is left of the move cannot be seen (a close look starts its object then).
        const near = a.close ? {turn: 0.05, dist: 0.04 * a.dist, move: 0.05, spin: 0.08} : {turn: 0.02, dist: 0.05, move: 0.02, spin: 0.03};
        const still = Math.abs(v.theta) < near.spin && Math.abs(v.phi) < near.spin;
        if (!a.at && Math.abs(dTheta) < near.turn && (a.polar == null || Math.abs(a.polar - sph.phi) < near.turn) && (a.dist == null || Math.abs(a.dist - sph.radius) < near.dist) && tgt.distanceTo(a.target) < near.move && still) a.at = this.time;
      } else {
        v.theta += ((this.wantSpin ? SPIN : 0) - v.theta) * (1 - Math.exp(-dt * 1.2));
        sph.theta += v.theta * dt;
        v.phi *= Math.exp(-dt * 4); sph.phi += v.phi * dt;
        if (this.focusTo) {
          for (const k of ['x', 'y', 'z']) {const [o, nv] = smoothDamp(tgt[k], this.focusTo[k], v.target[k], 1.4, 1.5, dt); tgt[k] = o; v.target[k] = nv;}
          // Back out to the overview distance after a close look.
          const [o, nv] = smoothDamp(sph.radius, this.defaultDist, v.dist, 1.4, 4, dt); sph.radius = o; v.dist = nv;
          if (tgt.distanceTo(this.focusTo) < 0.005 && Math.abs(sph.radius - this.defaultDist) < 0.02) {this.focusTo = null; v.target.set(0, 0, 0); v.dist = 0;}
        }
      }
      sph.makeSafe();
      this.camera.position.copy(tgt).add(new THREE.Vector3().setFromSpherical(sph));
    }
    // Walls on the camera side fade gradually (no sudden switch at one angle).
    const cam = this.camera.position, tgt = this.controls.target;
    const view = new THREE.Vector2(cam.x - tgt.x, cam.z - tgt.z).normalize();
    for (const w of this.wallFades) {
      const d = new THREE.Vector2(w.c.x - tgt.x, w.c.z - tgt.z).normalize();
      const goal = 1 - 0.88 * THREE.MathUtils.smoothstep(d.dot(view), 0.05, 0.6);
      w.a = this.paused ? goal : w.a + (goal - w.a) * (1 - Math.exp(-dt * 5));
      this.fadeWall(w);
    }
    this.forming.update(fdt, frozenRoot, this.windowHandoff?.hidden);
    this.updateChairBoxes();
    if (this.versionTag) {
      const label = this.versionLabel();
      if (this.versionTag.textContent !== label) this.versionTag.textContent = label;
    }
    const tris = this.forming.triangles();
    this.formTag.hidden = tris == null;
    if (tris != null) this.formTag.textContent = `正在成形 · 三角面 ${tris.toLocaleString('en-US')}`;
    this.controls.update();
    // The near plane follows the distance: from the overview a fixed 5 cm left about 1 mm of depth precision,
    // and a window's photo backdrop 1 mm before its backing broke into grey blocks as the camera turned.
    const near = THREE.MathUtils.clamp(this.camera.position.distanceTo(this.controls.target) * NEAR_SHARE, NEAR_MIN, NEAR_MAX);
    if (Math.abs(near - this.camera.near) > 1e-3) {this.camera.near = near; this.camera.updateProjectionMatrix();}
    this.renderer.render(this.scene, this.camera);
  }

  versionLabel() {
    return [this.current, this.incoming].filter(key => key && this.models[key]?.root?.visible)
      .map(key => versionName(key, this.models[key].root.userData)).join(' → ');
  }

  dispose() {
    if (this.disposed) return this.disposal;
    this.disposed = true;
    cancelAnimationFrame(this.animationFrame);
    this.resizeObserver.disconnect(); this.scaffoldController.abort();
    this.restoreWindows();
    if (this.rig) this.physical(false);
    for (const key of Object.keys(this.models)) this.drop(key);
    if (this.points) disposeModel(this.points);
    if (this.wallLines) disposeModel(this.wallLines);
    Object.values(this.boxes).forEach(disposeModel);
    this.boxes = {}; this.wallFades = []; this.retryAt = {}; this.revealPlan = null;
    this.controls.dispose();
    this.renderer.domElement.remove(); this.formTag.remove();
    this.disposal = Promise.allSettled([...this.retiring]).then(() => {
      this.forming.dispose(); this.environmentTarget.dispose();
      Object.values(this.lights).forEach(light => light.dispose?.());
      this.scene.clear(); this.scene.environment = null;
      this.points = this.wallLines = this.partsShown = null;
      this.renderer.dispose();
    });
    return this.disposal;
  }
}

// Shown on screen: it and its parents up to root are visible.
function visibleFrom(o, root) {
  for (let p = o; p; p = p.parent) {if (!p.visible) return false; if (p === root) return true;}
  return true;
}

// The room's walls as the editor describes them (inner face plane n·p = d, along-wall axis, extent), from the
// replay layout ([x, z] ends in the model frame, height, thickness).
function wallFaces(plan) {
  if (!plan.walls?.length) return [];
  const xs = plan.walls.flatMap((w) => [w.a[0], w.b[0]]), zs = plan.walls.flatMap((w) => [w.a[1], w.b[1]]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
  return plan.walls.map((w) => {
    const tx = w.b[0] - w.a[0], tz = w.b[1] - w.a[1], len = Math.hypot(tx, tz) || 1;
    let n = [-tz / len, 0, tx / len];
    const mid = [(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2];
    if (n[0] * (cx - mid[0]) + n[2] * (cz - mid[1]) < 0) n = n.map((v) => -v);
    const tangent = [-n[2], 0, n[0]], along = (p) => tangent[0] * p[0] + tangent[2] * p[1];
    const [u0, u1] = [along(w.a), along(w.b)].sort((a, b) => a - b);
    return {name: w.id, n, d: n[0] * mid[0] + n[2] * mid[1] + (w.t || 0) / 2, tangent,
      bounds: [[u0, plan.floor], [u1, plan.floor + w.h]]};
  });
}

// What the editor reads from a room's object list, by the names a reconstructed room uses: ceilings, windows
// (on their parent wall or the nearest wall), walls and floor, and the ceiling luminaires the room is lit from.
function roomConfig(root, walls, ceilingY, windowIds) {
  const windows = new Set(windowIds);
  const isWindow = name => windows.has(name) || /^Window(?:[_-]?\d+|Left|Right)$|_Window_\d+$/i.test(name);
  const kind = (name) => (isWindow(name) ? '窗户' : /^Ceiling/i.test(name) ? '天花板'
    : /^Wall\d+$/.test(name) ? '墙面' : /^Floor\d+$/.test(name) ? '地面' : null);
  const openings = Object.fromEntries(walls.map((w) => [w.name, []]));
  const windowRoots = new Set();
  function nearestWall(o) {
    const c = new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3());
    const gap = w => Math.abs(w.n[0] * c.x + w.n[2] * c.z - w.d);
    return walls.reduce((best, w) => gap(w) < gap(best) ? w : best).name;
  }
  function collect(o, wall) {
    const name = o.userData.name || o.name;
    if (kind(name) === '窗户') {
      windowRoots.add(o);
      if (walls.length) openings[wall || nearestWall(o)].push(name);
      return;  // The articulated sashes inside Window0 can themselves be named Window1, Window2, ...
    }
    if (Object.hasOwn(openings, name)) wall = name;
    for (const child of o.children) collect(child, wall);
  }
  collect(root, null);
  return {label: (name) => kind(name), isCeiling: (name) => kind(name) === '天花板', openings, windowRoots,
    luminaires: namedLuminaires(THREE, root, {label: kind, ceilingY})};
}
