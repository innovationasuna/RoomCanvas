// The replay's 3D view: scan point cloud and layout boxes first, then whichever room model the
// timeline has reached (assembled room, each acceptance round, final). A newer model fades in over
// the previous one. The camera follows smoothly; near walls fade so the room stays readable.
import * as THREE from 'three';
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
    container.appendChild(r.domElement);
    r.domElement.style.display = 'block';
    const scene = this.scene = new THREE.Scene();
    scene.background = new THREE.Color(background);
    scene.environment = new THREE.PMREMGenerator(r).fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.55;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8170, 1.1));
    const sun = new THREE.DirectionalLight(0xfff4e6, 1.4);
    sun.position.set(-3, 6, 2);
    scene.add(sun);
    this.center = new THREE.Vector3();
    this.radius = 4;
    const cam = this.camera = new THREE.PerspectiveCamera(38, 1, 0.05, 200);
    this.defaultPolar = 0.9;
    const c = this.controls = new OrbitControls(cam, r.domElement);
    c.enableDamping = true;
    c.maxPolarAngle = Math.PI * 0.47;
    this.frame(new THREE.Box3(new THREE.Vector3(-2, -1.5, -2), new THREE.Vector3(2, 1.2, 2)));
    c.addEventListener('start', () => {this.userHeld = true; this.aimTo = null; this.vel = {theta: 0, phi: 0, target: new THREE.Vector3()};});
    this.vel = {theta: 0, phi: 0, target: new THREE.Vector3()};
    this.wantSpin = false;
    this.userHeld = false;
    this.aimTo = null;
    this.focusTo = null;
    this.wallFades = [];
    this.models = {};       // key -> {root, mask}
    this.current = null;    // model key fully shown
    this.incoming = null;   // model key fading in
    this.mix = 1;
    this.state = null;
    this.boxes = {};
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.ready = scaffold ? this.loadScaffold(scaffold).catch(() => {}) : Promise.resolve();
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
    const size = box.getSize(new THREE.Vector3());
    this.radius = Math.max(size.x, size.z, 3);
    const offset = new THREE.Vector3(1, 1.05, 1.08).normalize().multiplyScalar(this.radius * 2.15);
    this.camera.position.copy(this.center).add(offset);
    this.controls.target.copy(this.center);
    this.defaultPolar = new THREE.Spherical().setFromVector3(offset).phi;
  }

  async loadScaffold({points, layout}) {
    const [buf, plan] = await Promise.all([fetch(points).then((r) => r.arrayBuffer()), fetch(layout).then((r) => r.json())]);
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
    this.points = new THREE.Points(g, new THREE.PointsMaterial({size: 0.022, vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false}));
    this.points.geometry.setDrawRange(0, 0);
    this.pointCount = n;
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
      // A finished object fills its box (the room model only arrives once all objects are done).
      const fill = new THREE.Mesh(new THREE.BoxGeometry(...b.size), new THREE.MeshStandardMaterial({color: this.palette.built, transparent: true, opacity: 0.35, roughness: 0.8}));
      fill.visible = false;
      group.add(edges, fill);
      group.position.set(...b.center);
      group.rotation.y = b.yaw;
      group.visible = false;
      group.userData = {edges, fill};
      this.boxes[b.id] = group;
      this.scene.add(group);
    }
    this.scaffoldReady = true;
    if (this.state) this.apply(this.state);
  }

  // ---------- room models ----------
  async model(key, url) {
    if (this.models[key]) return this.models[key].promise;
    const entry = this.models[key] = {};
    entry.promise = new GLTFLoader().loadAsync(url).then((gltf) => {
      const root = this.prepare(gltf.scene);
      root.visible = false;
      this.scene.add(root);
      entry.root = root;
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
      this.wallFades.push({mats, c, root, a: 1});
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
      m.renderOrder = 1;
      m.visible = false;
      o.add(m);
      root.userData.mask.push(m);
    }
    return root;
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
    if (!entry || this.wanted !== key) return;
    if (quiet || !this.current) {this.swap(key); return;}
    this.incoming = key;
    this.mix = 0;
    entry.root.visible = true;
    this.setFade(entry.root, 0);
  }

  swap(key) {
    for (const [k, e] of Object.entries(this.models)) if (e.root) {e.root.visible = k === key; this.setFade(e.root, 1);}
    this.current = key;
    this.incoming = null;
    this.mix = 1;
  }

  apply(state, {quiet = false, modelUrl} = {}) {
    this.state = state;
    if (this.points) {
      this.points.geometry.setDrawRange(0, Math.floor(this.pointCount * state.points));
      this.points.material.opacity = state.pointsDim ? 0.22 : 0.9;
      this.points.visible = !state.model;
    }
    if (this.wallLines) {
      this.wallLines.visible = state.walls > 0 && !state.model;
      this.wallLines.children.forEach((l) => (l.material.opacity = 0.6 * state.walls));
    }
    for (const [id, group] of Object.entries(this.boxes)) {
      group.visible = state.boxes && !state.model;
      group.userData.fill.visible = state.built.has(id);
    }
    if (state.model !== this.wanted && modelUrl) this.show(state.model, modelUrl(state.model), quiet);
    else if (!state.model && this.current) {this.wanted = null; this.swap(null);}
  }

  boundsOf(key) {
    const box = new THREE.Box3();
    const root = this.current && this.models[this.current]?.root;
    const node = root?.getObjectByName(key);
    if (node) box.expandByObject(node);
    else if (this.boxes[key]) box.setFromObject(this.boxes[key]);
    return box;
  }

  // ---------- camera direction (the page decides when to spin, aim or pose) ----------
  release() {this.userHeld = false;}
  spin(on) {this.wantSpin = on;}
  aim(keys) {
    const box = new THREE.Box3();
    keys.forEach((k) => box.union(this.boundsOf(k)));
    if (box.isEmpty()) return false;
    const o = box.getCenter(new THREE.Vector3());
    const dir = new THREE.Vector2(this.center.x - o.x, this.center.z - o.z);
    const off = this.camera.position.clone().sub(this.controls.target);
    const az = dir.length() > 0.3 ? Math.atan2(dir.x, dir.y) : Math.atan2(off.x, off.z);
    this.aimTo = {az, polar: null, target: this.center.clone().lerp(o, 0.4), at: 0};
    return true;
  }
  pose(az, polar) {this.aimTo = {az, polar, target: this.center.clone(), at: 0};}
  settledFor() {return this.aimTo?.at ? performance.now() - this.aimTo.at : 0;}
  clearAim() {
    if (!this.aimTo) return;
    this.aimTo = null;
    this.focusTo = this.center.clone();
  }

  tick() {
    const now = performance.now();
    const dt = Math.min((now - (this.lastTick ?? now)) / 1000, 0.05);
    this.lastTick = now;
    if (this.incoming && dt > 0) {
      this.mix = Math.min(this.mix + dt / FADE_SECONDS, 1);
      this.setFade(this.models[this.incoming].root, this.mix);
      if (this.mix >= 1) this.swap(this.incoming);
    }
    this.controls.autoRotate = false;
    if (!this.userHeld && dt > 0) {
      const tgt = this.controls.target, v = this.vel, a = this.aimTo;
      const sph = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(tgt));
      if (a) {
        const dTheta = a.az == null ? 0 : Math.atan2(Math.sin(a.az - sph.theta), Math.cos(a.az - sph.theta));
        if (a.az == null) {v.theta *= Math.exp(-dt * 4); sph.theta += v.theta * dt;}
        else {const [o, nv] = smoothDamp(0, dTheta, v.theta, 1.1, 0.9, dt); sph.theta += o; v.theta = nv;}
        if (a.polar != null) {const [o, nv] = smoothDamp(sph.phi, a.polar, v.phi, 1.1, 0.6, dt); sph.phi = o; v.phi = nv;}
        for (const k of ['x', 'y', 'z']) {const [o, nv] = smoothDamp(tgt[k], a.target[k], v.target[k], 1.1, 1.5, dt); tgt[k] = o; v.target[k] = nv;}
        const still = Math.abs(v.theta) < 0.03 && Math.abs(v.phi) < 0.03;
        if (!a.at && Math.abs(dTheta) < 0.02 && (a.polar == null || Math.abs(a.polar - sph.phi) < 0.02) && tgt.distanceTo(a.target) < 0.02 && still) a.at = now;
      } else {
        v.theta += ((this.wantSpin ? SPIN : 0) - v.theta) * (1 - Math.exp(-dt * 1.2));
        sph.theta += v.theta * dt;
        v.phi *= Math.exp(-dt * 4); sph.phi += v.phi * dt;
        if (this.focusTo) {
          for (const k of ['x', 'y', 'z']) {const [o, nv] = smoothDamp(tgt[k], this.focusTo[k], v.target[k], 1.4, 1.5, dt); tgt[k] = o; v.target[k] = nv;}
          if (tgt.distanceTo(this.focusTo) < 0.005) {this.focusTo = null; v.target.set(0, 0, 0);}
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
