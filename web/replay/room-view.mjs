// The replay's 3D view: scan point cloud and layout boxes first, then whichever room model the
// timeline has reached (assembled room, each acceptance round, final). A newer model fades in over
// the previous one, and each object that appears takes shape once the camera has moved in close to it. The
// camera follows smoothly; near walls fade so the room stays readable.
import * as THREE from 'three';
import {Materializer, prefetch} from './materialize.mjs';
import {createTimeLighting} from '../editor/time-lighting.mjs';
import {lightingProfile} from '../editor/lighting-profiles.mjs';
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
const HIDDEN = /^Ceiling/i;
const SHELL = /^(Floor|Wall)\d+$/;
const CLOSE_POLAR = 1.0;  // rad from straight down: looking at an object a little from above
const MAX_WAIT = 2200;    // ms an object waits for the camera before taking shape anyway

// Pipeline object ids -> nodes of the assembled room: Bed0 stays Bed0; the k-th door / window becomes Door<k> /
// Window<k>; a chair cluster stands for every Chair node.
function nodesFor(root, id) {
  const top = root.children;
  const direct = top.filter((o) => o.name === id);
  if (direct.length) return direct;
  if (/^ChairCluster/.test(id)) return top.filter((o) => /^Chair\d+$/.test(o.name));
  const opening = id.match(/_(Door|Window)_\d+$/);
  if (opening) return top.filter((o) => o.name === opening[1] + Math.max(root.userData.openings?.[opening[1]]?.indexOf(id) ?? 0, 0));
  return [];
}

export class RoomView {
  // files(rel) -> URL of an allowlisted run file; scaffold = {points, layout} URLs or null.
  constructor(container, {files, scaffold, background = 0xc4c9ba,
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
    scene.environment = new THREE.PMREMGenerator(r).fromScene(new RoomEnvironment(), 0.04).texture;
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
    c.addEventListener('start', () => {this.userHeld = true; this.aimTo = null; this.vel = {theta: 0, phi: 0, dist: 0, target: new THREE.Vector3()};});
    this.vel = {theta: 0, phi: 0, dist: 0, target: new THREE.Vector3()};
    this.wantSpin = false;
    this.userHeld = false;
    this.aimTo = null;
    this.focusTo = null;
    this.wallFades = [];
    this.models = {};       // key -> {root, mask}
    this.retryAt = {};      // key -> when a failed model load may be tried again
    this.current = null;    // model key fully shown
    this.incoming = null;   // model key fading in
    this.mix = 1;
    this.state = null;
    this.boxes = {};
    this.forming = new Materializer(scene);
    this.calm = matchMedia('(prefers-reduced-motion: reduce)');
    this.formTag = Object.assign(document.createElement('div'), {className: 'forming', hidden: true});
    container.appendChild(this.formTag);
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.scaffoldUrls = scaffold;
    this.ensureScaffold();
    const loop = () => {requestAnimationFrame(loop); this.tick();};
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
    this.camera.position.copy(this.center).add(offset);
    this.controls.target.copy(this.center);
    this.defaultDist = offset.length();
    this.defaultPolar = new THREE.Spherical().setFromVector3(offset).phi;
  }

  // Load the point cloud and layout once they exist; a live job may not have them yet, so callers retry.
  ensureScaffold() {
    if (!this.scaffoldUrls || this.scaffoldReady || this.scaffoldLoading) return;
    this.scaffoldLoading = this.loadScaffold(this.scaffoldUrls).catch(() => {}).finally(() => (this.scaffoldLoading = null));
  }

  async loadScaffold({points, layout, colors}) {
    const get = async (url) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${url}: ${r.status}`);
      return r;
    };
    const [buf, plan] = await Promise.all([get(points).then((r) => r.arrayBuffer()), get(layout).then((r) => r.json())]);
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
    if (colors) fetch(colors).then((r) => (r.ok ? r.arrayBuffer() : null)).then((rgb) => {
      if (!rgb || rgb.byteLength !== n * 3) return;
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
    if (this.state) this.apply(this.state);
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
  async model(key, url) {
    if (this.models[key]) return this.models[key].promise;
    // A live job can list a model while it is still being written: after a failed load, try again later.
    if (performance.now() < (this.retryAt[key] || 0)) throw new Error(`retry ${key} later`);
    const entry = this.models[key] = {};
    entry.promise = new GLTFLoader().loadAsync(url).catch((error) => {
      delete this.models[key];
      this.retryAt[key] = performance.now() + 5000;
      throw error;
    }).then((gltf) => {
      const root = this.prepare(gltf.scene);
      root.visible = false;
      this.scene.add(root);
      entry.root = root;
      this.warm(root);
      prefetch(root).catch(() => {});
      if (!this.modelsFramed && !this.scaffoldReady) {this.frame(new THREE.Box3().setFromObject(root)); this.modelsFramed = true;}
      return entry;
    });
    return entry.promise;
  }

  prepare(root) {
    const aniso = this.renderer.capabilities.getMaxAnisotropy();
    root.traverse((o) => {
      if (HIDDEN.test(o.name)) o.visible = false;
      if (!o.isMesh) return;
      for (const m of [o.material].flat()) for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap']) if (m[k]) m[k].anisotropy = aniso;
    });
    const lights = [];
    root.traverse((o) => {if (o.isLight) lights.push(o);});
    lights.forEach((l) => l.removeFromParent());
    // Walls and large wall-mounted parts fade when they sit between the camera and the room.
    const wallMats = new Set();
    for (const part of root.children.filter((o) => WALLISH.test(o.name))) {
      const mats = [];
      part.traverse((o) => {
        if (!o.isMesh) return;
        o.material = o.material.clone();
        o.material.userData.base = o.material.opacity;
        o.material.transparent = true;
        mats.push(o.material);
        wallMats.add(o.material);
      });
      const c = new THREE.Box3().setFromObject(part).getCenter(new THREE.Vector3());
      this.wallFades.push({mats, c, root, part, a: 1});
    }
    const all = new Set();
    root.traverse((o) => {if (o.isMesh) [o.material].flat().forEach((m) => all.add(m));});
    root.userData.fadeMats = [...all].map((m) => ({m, opacity: m.userData.base ?? m.opacity, transparent: m.transparent, depthWrite: m.depthWrite, wall: wallMats.has(m)}));
    root.userData.fade = 1;
    // Depth mask for fading in: only the outermost surfaces of the incoming model get colour.
    const mask = new THREE.MeshBasicMaterial({colorWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4});
    root.userData.mask = [];
    const meshes = [];
    root.traverse((o) => {if (o.isMesh) meshes.push(o);});
    for (const o of meshes) {
      if ([o.material].flat().some((m) => wallMats.has(m) || m.transparent || m.opacity < 1)) continue;
      const m = new THREE.Mesh(o.geometry, mask);
      m.userData.mask = true;
      m.renderOrder = 1;
      m.visible = false;
      o.add(m);
      root.userData.mask.push(m);
    }
    return root;
  }

  // Compile, in the background, the shaders of every object, and upload its textures: objects stay hidden
  // until built, and would otherwise do both when they appear, stalling the page. The proxies stay alive:
  // disposing them would drop the compiled programs.
  warm(root) {
    const group = new THREE.Group(), seen = new Set(), textures = new Set();
    root.updateWorldMatrix(true, true);
    root.traverse((o) => {
      if (!o.isMesh || o.userData.mask) return;
      for (const m of [o.material].flat()) {
        if (seen.has(m)) continue;
        seen.add(m);
        for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap']) if (m[k]) textures.add(m[k]);
        const proxy = new THREE.Mesh(o.geometry, m);
        proxy.matrixAutoUpdate = false;
        proxy.matrix.copy(o.matrixWorld);
        group.add(proxy);
      }
    });
    textures.forEach((t) => this.renderer.initTexture(t));
    root.userData.warm = group;
    group.updateMatrixWorld(true);
    this.renderer.compileAsync(group, this.camera, this.scene).catch(() => {});
  }

  setFade(root, f) {
    if (!root || root.userData.fade === f) return;
    root.userData.fade = f;
    for (const x of root.userData.fadeMats) {
      if (x.wall) continue;
      x.m.transparent = f < 1 || x.transparent;
      x.m.opacity = x.opacity * f;
      x.m.depthWrite = f < 1 ? false : x.depthWrite;
      x.m.polygonOffset = f < 1; x.m.polygonOffsetFactor = -1; x.m.polygonOffsetUnits = -4;
      x.m.needsUpdate = true;
    }
    const masking = f > 0 && f < 1;
    root.userData.mask.forEach((m) => (m.visible = masking));
  }

  // Bring a model in: it fades in over the one shown now (quiet: switch at once, e.g. while scrubbing).
  async show(key, url, quiet) {
    if (!key) {this.swap(null); return;}
    if (key === this.current || key === this.incoming) return;
    this.wanted = key;
    const entry = await this.model(key, url).catch(() => null);
    if (!entry && this.wanted === key) this.wanted = null;  // apply() asks for it again
    if (!entry || this.wanted !== key) return;
    if (quiet) this.swap(key);
    else {
      this.incoming = key;
      this.mix = 0;
      entry.root.visible = true;
      this.setFade(entry.root, 0);
    }
    // The state was applied while the model was loading (e.g. after a seek while paused): apply it again now.
    if (this.state) this.apply(this.state, {...this.lastOptions, quiet: true});
  }

  // The finished room, lit like the editor's 物理光照: the editor's own rig (../editor/time-lighting.mjs), so
  // the replay follows any change made there. Off again (the replay's own lights) when the replay goes back.
  physical(on) {
    on = !!on;
    this.wantPhysical = on;  // tried again each frame until the room model is in place
    if (on === !!this.rig) return;
    const {hemisphere, sun, fill} = this.lights;
    if (!on) {
      this.rig.dispose();
      this.rig = null;
      Object.assign(hemisphere, {visible: true, intensity: this.saved.hemisphere});
      Object.assign(sun, {visible: true, castShadow: false, intensity: this.saved.sun});
      sun.color.copy(this.saved.sunColor);
      sun.position.copy(this.saved.sunAt);
      fill.visible = false;
      this.scene.environmentIntensity = this.saved.environment;
      this.scene.background.copy(this.saved.background);
      this.relinkWalls();
      return;
    }
    const root = !this.incoming && this.models[this.current]?.root;
    if (!root) return;
    this.saved = {hemisphere: hemisphere.intensity, sun: sun.intensity, sunColor: sun.color.clone(), sunAt: sun.position.clone(),
      environment: this.scene.environmentIntensity, background: this.scene.background.clone()};
    root.updateWorldMatrix(true, true);
    const box = (name) => {const o = root.getObjectByName(name); return o ? new THREE.Box3().setFromObject(o) : null;};
    const bounds = new THREE.Box3().setFromObject(root);
    const floorY = box('Floor0')?.max.y ?? bounds.min.y, ceilingY = box('Wall0')?.max.y ?? bounds.max.y;
    root.traverse((m) => {if (m.isMesh) {m.castShadow = m.name !== 'Floor0' && !m.userData.mask; m.receiveShadow = true;}});
    sun.shadow.mapSize.set(2048, 2048);
    this.rig = createTimeLighting(THREE, {renderer: this.renderer, scene: this.scene, room: root, config: roomConfig(root, this.wallFaces),
      walls: this.wallFaces, bounds, floorY, ceilingY, profile: lightingProfile()});
    this.rig.apply('physical');
    this.relinkWalls();
  }

  // Near walls fade through whatever material each wall mesh shows now (the lighting rig swaps in its own).
  relinkWalls() {
    for (const w of this.wallFades) {
      w.mats = [];
      w.part.traverse((o) => {
        if (!o.isMesh || o.userData.mask) return;
        for (const m of [o.material].flat()) {
          m.userData.base ??= m.opacity;
          m.transparent = true;
          w.mats.push(m);
        }
      });
    }
  }

  swap(key) {
    if (this.rig) {this.physical(false); this.wantPhysical = true;}
    for (const [k, e] of Object.entries(this.models)) if (e.root) {e.root.visible = k === key; this.setFade(e.root, 1);}
    this.current = key;
    this.incoming = null;
    this.mix = 1;
  }

  // partial: show the room as it is being built (shell + finished objects of the assembled room);
  // full: show the reached model as it is.
  apply(state, {quiet = false, modelUrl, openings, addedAll} = {}) {
    this.state = state;
    this.lastOptions = {modelUrl, openings, addedAll};
    const seedUrl = modelUrl?.('seed');
    const key = state.model || (state.shell && seedUrl ? 'seed' : null);
    const partial = !state.model && key === 'seed';
    const inRoom = !!key && !!this.models[key]?.root && (this.current === key || this.incoming === key);
    if (this.points) {
      this.points.material.userData.reveal.value = state.points;
      this.points.material.opacity = state.pointsDim ? 0.22 : 1;
      this.points.material.depthWrite = !state.pointsDim;
      this.points.visible = !inRoom;
    }
    if (this.wallLines) {
      this.wallLines.visible = state.walls > 0 && !inRoom;
      this.wallLines.children.forEach((l) => (l.material.opacity = 0.6 * state.walls));
    }
    if (quiet) this.forming.finishAll();
    const {shown: placed, appeared} = this.revealed(partial, state.built, openings);
    // A finished object takes shape in the room (not when many appear at once, e.g. the whole model is saved).
    if (!quiet && this.current === 'seed' && appeared.length <= 12) appeared.forEach((node) => this.materialize(node));
    this.reveal(state.model === 'final' ? state.added : null, quiet);
    for (const [id, group] of Object.entries(this.boxes)) {
      const done = state.built.has(id);
      // Boxes stand for what is not in the room yet; a finished object without a room model gets a gold outline.
      group.visible = state.boxes && !state.model && !(partial && inRoom && placed.has(id));
      group.userData.edges.material.color.copy(done ? new THREE.Color(this.palette.built) : group.userData.base);
    }
    // Fetch the first room model from the start (it is tens of MB), so the modelling stage never waits on it.
    if (seedUrl && !this.models.seed) this.model('seed', seedUrl).catch(() => {});
    // While the assembled room shows, fetch the final model in the background so the switch starts on time.
    if (key === 'seed' && modelUrl?.('final') && !this.models.final) this.model('final', modelUrl('final')).catch(() => {});
    if (key !== this.wanted && key && modelUrl) this.show(key, modelUrl(key), quiet);
    else if (!key && this.current) {this.wanted = null; this.swap(null);}
  }

  // Agent-added parts of the final model: show only those in `added` (null shows all). A part that appears
  // while playing fades in; after a seek it is simply there.
  reveal(added, quiet) {
    const root = this.models.final?.root, all = this.lastOptions?.addedAll;
    if (!root || !all) return;
    for (const name of all) {
      const node = root.getObjectByName(name);
      if (!node) continue;
      const show = !HIDDEN.test(name) && (!added || added.has(name));  // the ceiling stays hidden
      const appears = show && !node.visible;
      node.visible = show;
      if (appears && !quiet && this.current === 'final') this.materialize(node);
    }
  }

  // The object waits (hidden) until the camera has moved in, then takes shape.
  materialize(node) {
    if (this.calm.matches) return;
    if (!this.forming.waiting()) this.heldSince = performance.now();
    this.forming.start(node, {held: !this.userHeld});
  }

  // In partial mode hide the assembled room's objects that are not finished yet; returns the ids shown and the
  // objects that just became visible.
  revealed(partial, built, openings) {
    const root = this.models.seed?.root, shown = new Set();
    const appeared = [];
    if (!root) return {shown, appeared};
    if (openings) root.userData.openings = openings;
    const keep = new Set();
    if (partial) for (const id of built) for (const node of nodesFor(root, id)) {keep.add(node); shown.add(id);}
    for (const o of root.children) {
      const show = !HIDDEN.test(o.name) && (!partial || SHELL.test(o.name) || keep.has(o));
      if (show && !o.visible && !SHELL.test(o.name)) appeared.push(o);
      o.visible = show;
    }
    return {shown, appeared};
  }

  boundsOf(key) {
    const box = new THREE.Box3();
    const root = this.current && this.models[this.current]?.root;
    const node = root?.getObjectByName(key) || this.models.final?.root?.getObjectByName(key);
    if (node) box.expandByObject(node);
    else if (this.boxes[key]) box.setFromObject(this.boxes[key]);
    return box;
  }

  // ---------- camera direction (the page decides when to spin, aim or pose) ----------
  release() {this.userHeld = false;}
  spin(on) {this.wantSpin = on;}
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
    // Close: the object fills most of the view, seen from where nothing stands in front of it.
    const dist = THREE.MathUtils.clamp(size / 2 * 3.2, 2.2, this.defaultDist * 0.7), polar = CLOSE_POLAR;
    this.aimTo = {az: this.clearView(keys, box, az, dist, polar), polar, dist, target: o, at: 0, close: true};
    return true;
  }

  // The direction (azimuth) to look at a box from: least hidden by other objects, inside the room, little turning.
  clearView(keys, box, preferred, dist, polar) {
    const root = this.models[this.incoming || this.current]?.root, mine = new Set();
    for (const k of keys) root?.getObjectByName(k)?.traverse((o) => mine.add(o));
    const blockers = [];
    root?.traverse((o) => {
      if (!o.isMesh || o.userData.mask || mine.has(o) || !visibleFrom(o, root)) return;
      for (let p = o; p && p !== root; p = p.parent) if (WALLISH.test(p.name) || SHELL.test(p.name)) return;  // walls fade
      blockers.push(o);
    });
    const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3()).multiplyScalar(0.35);
    const marks = [c, ...[[1, 1], [-1, 1], [1, -1], [-1, -1]].map(([x, z]) => c.clone().add(new THREE.Vector3(x * s.x, s.y, z * s.z)))];
    const now = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target)).theta;
    const ray = new THREE.Raycaster(), cam = new THREE.Vector3(), d = new THREE.Vector3();
    const inside = this.room?.clone().expandByScalar(-0.15);
    let best = preferred, bestScore = Infinity;
    for (const step of [0, 1, -1, 2, -2, 3, -3, 4, -4, 6]) {
      const az = preferred + step * Math.PI / 6;
      cam.copy(c).add(new THREE.Vector3().setFromSphericalCoords(dist, polar, az));
      let hidden = 0;
      for (const m of marks) {
        d.subVectors(m, cam);
        ray.set(cam, d.clone().normalize());
        ray.far = d.length() - 0.05;
        if (ray.intersectObjects(blockers, false).length) hidden++;
      }
      const outside = inside && !inside.isEmpty() && !inside.containsPoint(new THREE.Vector3(cam.x, inside.min.y, cam.z)) ? 1 : 0;
      const turn = Math.abs(Math.atan2(Math.sin(az - now), Math.cos(az - now)));
      const score = hidden / marks.length * 3 + outside * 1.5 + turn * 0.15;
      if (score < bestScore) {bestScore = score; best = az;}
    }
    return best;
  }
  pose(az, polar) {this.aimTo = {az, polar, dist: null, target: this.center.clone(), at: 0};}
  settledFor() {return this.aimTo?.at ? performance.now() - this.aimTo.at : 0;}
  clearAim() {
    if (!this.aimTo) return;
    this.aimTo = null;
    this.focusTo = this.center.clone();
  }

  tick() {
    const now = performance.now();
    const elapsed = (now - (this.lastTick ?? now)) / 1000;
    const dt = Math.min(elapsed, 0.05);      // camera motion: small steps even after a slow frame
    const fdt = Math.min(elapsed, 0.25);     // fades follow real time, so they finish on time at low frame rates
    this.lastTick = now;
    if (this.incoming && fdt > 0) {
      this.mix = Math.min(this.mix + fdt / FADE_SECONDS, 1);
      this.setFade(this.models[this.incoming].root, this.mix);
      if (this.mix >= 1) this.swap(this.incoming);
    }
    // Held objects take shape once the camera has arrived (or the user moves it, or it takes too long).
    if (this.forming.waiting() && (!this.aimTo || this.aimTo.at || this.userHeld || now - this.heldSince > MAX_WAIT)) this.forming.release();
    this.forming.update(fdt);
    if (this.wantPhysical !== !!this.rig) this.physical(this.wantPhysical);
    const tris = this.forming.triangles();
    this.formTag.hidden = tris == null;
    if (tris != null) this.formTag.textContent = `正在成形 · 三角面 ${tris.toLocaleString('en-US')}`;
    this.controls.autoRotate = false;
    if (!this.userHeld && dt > 0) {
      const tgt = this.controls.target, v = this.vel, a = this.aimTo;
      const sph = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(tgt));
      if (a) {
        const dTheta = a.az == null ? 0 : Math.atan2(Math.sin(a.az - sph.theta), Math.cos(a.az - sph.theta));
        // Moving in close to watch an object is quicker, so the camera is there when it takes shape.
        const time = a.close ? 0.55 : 1.1, fast = a.close ? 2.5 : 1;
        if (a.az == null) {v.theta *= Math.exp(-dt * 4); sph.theta += v.theta * dt;}
        else {const [o, nv] = smoothDamp(0, dTheta, v.theta, time, 0.9 * fast, dt); sph.theta += o; v.theta = nv;}
        if (a.polar != null) {const [o, nv] = smoothDamp(sph.phi, a.polar, v.phi, time, 0.6 * fast, dt); sph.phi = o; v.phi = nv;}
        if (a.dist != null) {const [o, nv] = smoothDamp(sph.radius, a.dist, v.dist, time, 4 * fast, dt); sph.radius = o; v.dist = nv;}
        for (const k of ['x', 'y', 'z']) {const [o, nv] = smoothDamp(tgt[k], a.target[k], v.target[k], time, 1.5 * fast, dt); tgt[k] = o; v.target[k] = nv;}
        // Arrived once what is left of the move cannot be seen (a close look starts its object then).
        const near = a.close ? {turn: 0.05, dist: 0.04 * a.dist, move: 0.05, spin: 0.08} : {turn: 0.02, dist: 0.05, move: 0.02, spin: 0.03};
        const still = Math.abs(v.theta) < near.spin && Math.abs(v.phi) < near.spin;
        if (!a.at && Math.abs(dTheta) < near.turn && (a.polar == null || Math.abs(a.polar - sph.phi) < near.turn) && (a.dist == null || Math.abs(a.dist - sph.radius) < near.dist) && tgt.distanceTo(a.target) < near.move && still) a.at = now;
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
      w.a += (goal - w.a) * (1 - Math.exp(-dt * 5));
      const f = w.root.userData.fade ?? 1;
      w.mats.forEach((m) => {m.opacity = m.userData.base * w.a * f; m.depthWrite = w.a > 0.97 && f === 1 && m.userData.base > 0.9;});
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
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
// (each on its nearest wall), walls and floor.
function roomConfig(root, walls) {
  const kind = (name) => (/^Ceiling/i.test(name) ? '天花板' : /^Window\d|_Window_/i.test(name) ? '窗户'
    : /^Wall\d+$/.test(name) ? '墙面' : /^Floor\d+$/.test(name) ? '地面' : null);
  const openings = Object.fromEntries(walls.map((w) => [w.name, []]));
  for (const o of root.children) {
    if (kind(o.name) !== '窗户' || !walls.length) continue;
    const c = new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3());
    const near = walls.reduce((best, w) => {const gap = Math.abs(w.n[0] * c.x + w.n[2] * c.z - w.d); return !best || gap < best.gap ? {w, gap} : best;}, null);
    openings[near.w.name].push(o.name);
  }
  return {label: (name) => kind(name), isCeiling: (name) => kind(name) === '天花板', openings};
}
