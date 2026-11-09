// An object taking shape in the replay: the scan points around it gather onto its surface, a wireframe
// sweeps up from the bottom ahead of the points, and the textured surface follows the wireframe.
import * as THREE from 'three';

const GATHER = [0, 1.15];   // seconds: points travel from the scan onto the surface
const WIRE = [0.7, 1.9];    // wireframe front, bottom to top
const SOLID = [1.2, 2.6];   // textured surface front
const DONE = SOLID[1];
const PER_M2 = 2400, MIN_POINTS = 600, MAX_POINTS = 4000;

const ease = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const span = (t, [a, b]) => ease((t - a) / (b - a));

let dotMap = null;
function dot() {
  if (dotMap) return dotMap;
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d'), grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, '#fff'); grad.addColorStop(0.55, '#fff'); grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  return (dotMap = new THREE.CanvasTexture(c));
}

// Area-weighted random points on the meshes' surfaces (world space), and their triangle count.
function surface(meshes, n) {
  const parts = [], v = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3();
  let total = 0, triangles = 0;
  for (const o of meshes) {
    const pos = o.geometry.attributes.position, index = o.geometry.index;
    if (!pos) continue;
    const world = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).toArray(world, i * 3);
    const tris = index ? index.count / 3 : pos.count / 3, cum = new Float64Array(tris);
    const at = (k) => (index ? index.getX(k) : k);
    for (let t = 0; t < tris; t++) {
      const i0 = at(t * 3) * 3, i1 = at(t * 3 + 1) * 3, i2 = at(t * 3 + 2) * 3;
      a.set(world[i1] - world[i0], world[i1 + 1] - world[i0 + 1], world[i1 + 2] - world[i0 + 2]);
      b.set(world[i2] - world[i0], world[i2 + 1] - world[i0 + 1], world[i2 + 2] - world[i0 + 2]);
      total += a.cross(b).length() / 2;
      cum[t] = total;
    }
    parts.push({world, cum, at, end: total});
    triangles += tris;
  }
  const count = Math.round(Math.min(Math.max(total * PER_M2, MIN_POINTS), MAX_POINTS));
  const out = new Float32Array((total > 0 ? Math.min(n ?? count, count) : 0) * 3);
  for (let k = 0; k < out.length / 3; k++) {
    const r = Math.random() * total, p = parts.find((x) => x.end >= r) || parts.at(-1);
    let lo = 0, hi = p.cum.length - 1;
    while (lo < hi) {const mid = (lo + hi) >> 1; if (p.cum[mid] < r) lo = mid + 1; else hi = mid;}
    let u = Math.random(), w = Math.random();
    if (u + w > 1) {u = 1 - u; w = 1 - w;}
    const i0 = p.at(lo * 3) * 3, i1 = p.at(lo * 3 + 1) * 3, i2 = p.at(lo * 3 + 2) * 3;
    for (let d = 0; d < 3; d++) out[k * 3 + d] = p.world[i0 + d] + u * (p.world[i1 + d] - p.world[i0 + d]) + w * (p.world[i2 + d] - p.world[i0 + d]);
  }
  return {points: out, triangles};
}

export class Materializer {
  constructor(scene, {points = [0xe3b553, 0x9c7a37], speck = 0x4b4c45, wire = 0x3fa9d6} = {}) {
    this.scene = scene;
    this.colors = {points: points.map((c) => new THREE.Color(c)), speck: new THREE.Color(speck)};
    this.wire = wire;
    this.active = new Map();  // node -> effect
  }

  // scan: the scan point positions (Float32Array, same frame as the model) or null.
  start(node, scan) {
    this.finish(node);
    node.updateWorldMatrix(true, true);
    const meshes = [];
    node.traverse((o) => {if (o.isMesh && o.visible && !o.userData.mask) meshes.push(o);});
    const box = new THREE.Box3();
    meshes.forEach((o) => box.expandByObject(o));
    if (!meshes.length || box.isEmpty()) return;
    const {points: target, triangles} = surface(meshes);
    const n = target.length / 3;
    if (!n) return;
    const size = box.getSize(new THREE.Vector3()), reach = Math.max(size.x, size.y, size.z);

    // Start from the real scan points inside the object's box (loosened a little), else from inside the box.
    const near = [];
    if (scan) {
      const loose = box.clone().expandByScalar(0.06), p = new THREE.Vector3();
      for (let i = 0; i < scan.length; i += 3) if (loose.containsPoint(p.fromArray(scan, i))) near.push(i);
    }
    const from = new Float32Array(n * 3), delay = new Float32Array(n), col = new Float32Array(n * 3), tmp = new THREE.Color();
    for (let k = 0; k < n; k++) {
      const j = k * 3, jitter = 0.08 * reach + 0.03;
      if (near.length >= 30) {
        const i = near[(Math.random() * near.length) | 0];
        for (let d = 0; d < 3; d++) from[j + d] = scan[i + d] + (Math.random() - 0.5) * jitter;
      } else {
        from[j] = box.min.x + Math.random() * size.x;
        from[j + 1] = box.min.y + Math.random() * size.y;
        from[j + 2] = box.min.z + Math.random() * size.z;
      }
      delay[k] = Math.random() * 0.35;
      if (Math.random() < 0.12) tmp.copy(this.colors.speck);
      else tmp.copy(this.colors.points[0]).lerp(this.colors.points[1], Math.random());
      tmp.toArray(col, j);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(from.slice(), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const lo = box.min.y - 0.01, hi = box.max.y + 0.01;
    const wireTop = new THREE.Plane(new THREE.Vector3(0, -1, 0), lo);      // keeps y <= cut
    const wireAbove = new THREE.Plane(new THREE.Vector3(0, 1, 0), -lo);    // keeps y >= cut (points above the wire)
    const solidTop = new THREE.Plane(new THREE.Vector3(0, -1, 0), lo);
    const solidAbove = new THREE.Plane(new THREE.Vector3(0, 1, 0), -lo);
    const cloud = new THREE.Points(geo, new THREE.PointsMaterial({size: 0.03, map: dot(), alphaTest: 0.3, vertexColors: true,
      transparent: true, depthWrite: false, clippingPlanes: [wireAbove]}));
    cloud.frustumCulled = false;
    this.scene.add(cloud);

    // Wireframe and a faint fill between the surface front and the wire front.
    const wireMats = [
      new THREE.MeshBasicMaterial({color: this.wire, wireframe: true, transparent: true, opacity: 0.7, depthWrite: false, clippingPlanes: [wireTop, solidAbove]}),
      new THREE.MeshBasicMaterial({color: this.wire, transparent: true, opacity: 0.14, depthWrite: false, side: THREE.DoubleSide, clippingPlanes: [wireTop, solidAbove]}),
    ];
    const swaps = [], extras = [];
    for (const o of meshes) {
      const orig = o.material, list = [orig].flat();
      const clones = list.map((m) => {const c = m.clone(); c.clippingPlanes = [solidTop]; return c;});
      o.material = Array.isArray(orig) ? clones : clones[0];
      swaps.push({o, orig, list, clones});
      for (const m of wireMats) {
        const w = new THREE.Mesh(o.geometry, m);
        w.userData.mask = true;  // not part of the model (skipped by sampling and fades)
        w.renderOrder = 2;
        o.add(w);
        extras.push(w);
      }
    }
    this.active.set(node, {node, t: 0, n, from, to: target, delay, cloud, wireMats, swaps, extras, triangles, lo, hi,
      planes: {wireTop, wireAbove, solidTop, solidAbove}});
  }

  update(dt) {
    for (const e of this.active.values()) {
      e.t += dt;
      if (e.t >= DONE || !shown(e.node)) {this.finish(e.node); continue;}
      const {t, n, from, to, delay} = e, pos = e.cloud.geometry.attributes.position.array;
      for (let k = 0; k < n; k++) {
        const f = ease((t - GATHER[0] - delay[k]) / (GATHER[1] - 0.35)), wobble = 0.012 * (1 - f) * Math.sin(t * 9 + k);
        for (let d = 0; d < 3; d++) pos[k * 3 + d] = from[k * 3 + d] + (to[k * 3 + d] - from[k * 3 + d]) * f + wobble;
      }
      e.cloud.geometry.attributes.position.needsUpdate = true;
      const wire = e.lo + (e.hi - e.lo) * span(t, WIRE), solid = e.lo + (e.hi - e.lo) * span(t, SOLID);
      e.planes.wireTop.constant = wire; e.planes.wireAbove.constant = -wire;
      e.planes.solidTop.constant = solid; e.planes.solidAbove.constant = -solid;
      // The clones follow the originals, which the room view keeps fading (near walls, model swaps).
      for (const s of e.swaps) s.clones.forEach((c, i) => {
        const m = s.list[i];
        c.opacity = m.opacity; c.transparent = m.transparent; c.depthWrite = m.depthWrite; c.visible = m.visible;
      });
    }
  }

  // Triangles shown so far over all objects taking shape (null when none).
  triangles() {
    if (!this.active.size) return null;
    let shownCount = 0;
    for (const e of this.active.values()) shownCount += Math.round(e.triangles * span(e.t, [GATHER[0] + 0.3, WIRE[1]]));
    return shownCount;
  }

  finish(node) {
    const e = this.active.get(node);
    if (!e) return;
    this.active.delete(node);
    for (const s of e.swaps) {s.o.material = s.orig; s.clones.forEach((c) => c.dispose());}
    e.extras.forEach((w) => w.removeFromParent());
    e.wireMats.forEach((m) => m.dispose());
    e.cloud.removeFromParent();
    e.cloud.geometry.dispose();
    e.cloud.material.dispose();
  }

  finishAll() {[...this.active.keys()].forEach((node) => this.finish(node));}
}

function shown(node) {
  for (let o = node; o; o = o.parent) if (!o.visible) return false;
  return true;
}
