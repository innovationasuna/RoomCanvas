// An object taking shape in the replay: fine points on its surface, coloured like the object, light up, a
// wireframe sweeps up from the bottom over them, and the textured surface follows the wireframe.
import * as THREE from 'three';

const APPEAR = [0, 1.2];    // seconds: the points on the surface light up, in random order
const WIRE = [0.9, 2.3];    // wireframe front, bottom to top
const SOLID = [1.4, 3.0];   // textured surface front
const DONE = SOLID[1];
const PER_M2 = 9000, MIN_POINTS = 2500, MAX_POINTS = 16000;

const ease = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const span = (t, [a, b]) => ease((t - a) / (b - a));

function dot() {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d'), grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, '#fff'); grad.addColorStop(0.55, '#fff'); grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}

// The texels of each texture (a small copy), read ahead with prefetch() so points can take the object's
// colours. Reading a texture when an object appears would stall the page for about a second.
const texels = new WeakMap();
const pixels = (texture) => texels.get(texture?.image) || null;

const TEXEL_SIZE = 128;
export function prefetch(root, {signal} = {}) {
  const images = new Set();
  root.traverse((o) => {if (o.isMesh) for (const m of [o.material].flat()) if (m?.map?.image) images.add(m.map.image);});
  // The continuation owns only the image queue, never the model root.
  return prefetchImages(images, signal);
}

async function prefetchImages(images, signal) {
  for (const image of images) {
    if (signal?.aborted) return;
    if (texels.has(image) || !image.width || !image.height) continue;
    try {
      const scale = Math.min(1, TEXEL_SIZE / Math.max(image.width, image.height));
      const w = Math.max(1, Math.round(image.width * scale)), h = Math.max(1, Math.round(image.height * scale));
      // resized off the main thread; reading back the small copy is cheap
      const small = await createImageBitmap(image, {resizeWidth: w, resizeHeight: h, resizeQuality: 'medium'});
      if (signal?.aborted) {small.close?.(); return;}
      const g = Object.assign(document.createElement('canvas'), {width: w, height: h}).getContext('2d', {willReadFrequently: true});
      g.drawImage(small, 0, 0);
      small.close?.();
      texels.set(image, {w, h, data: g.getImageData(0, 0, w, h).data});
    } catch {
      if (!signal?.aborted) texels.set(image, null);  // unreadable: use the material colour
    }
    await new Promise((r) => setTimeout(r, 0));
  }
}

// Base colour (linear) of a mesh at triangle t, at barycentric (u, w) from corner v0 towards v1 and v2.
function painter(o) {
  const geo = o.geometry, mats = [o.material].flat(), uv = geo.attributes.uv, vc = geo.attributes.color;
  const groups = Array.isArray(o.material) ? geo.groups : [];
  const c = new THREE.Color(), texel = new THREE.Color(), p = new THREE.Vector2(), q = new THREE.Vector2(), r = new THREE.Vector2();
  return (t, v0, v1, v2, u, w) => {
    const g = groups.find((x) => t * 3 >= x.start && t * 3 < x.start + x.count);
    const m = mats[g ? g.materialIndex : 0] || mats[0];
    if (m?.color) c.copy(m.color); else c.setRGB(1, 1, 1);
    const px = m?.map && uv ? pixels(m.map) : null;
    if (px) {
      p.fromBufferAttribute(uv, v0); q.fromBufferAttribute(uv, v1); r.fromBufferAttribute(uv, v2);
      p.set(p.x + u * (q.x - p.x) + w * (r.x - p.x), p.y + u * (q.y - p.y) + w * (r.y - p.y));
      m.map.transformUv(p);  // offset/repeat/wrapping/flipY, as the renderer does
      const x = Math.min(px.w - 1, Math.max(0, Math.floor(p.x * px.w))), y = Math.min(px.h - 1, Math.max(0, Math.floor(p.y * px.h)));
      const k = (y * px.w + x) * 4, space = m.map.colorSpace === THREE.SRGBColorSpace ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
      c.multiply(texel.setRGB(px.data[k] / 255, px.data[k + 1] / 255, px.data[k + 2] / 255, space));
    }
    if (m?.vertexColors && vc) {
      const at = (i, d) => vc.getComponent(i, d);
      c.multiply(texel.setRGB(...[0, 1, 2].map((d) => at(v0, d) + u * (at(v1, d) - at(v0, d)) + w * (at(v2, d) - at(v0, d)))));
    }
    return c;
  };
}

// Area-weighted random points on the meshes' surfaces (world space) with the surface colour there, and the
// meshes' triangle count.
function surface(meshes) {
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
    parts.push({world, cum, at, end: total, paint: painter(o)});
    triangles += tris;
  }
  const size = total > 0 ? Math.round(Math.min(Math.max(total * PER_M2, MIN_POINTS), MAX_POINTS)) : 0;
  const out = new Float32Array(size * 3), colors = new Float32Array(size * 3);
  for (let k = 0; k < size; k++) {
    const r = Math.random() * total, p = parts.find((x) => x.end >= r) || parts.at(-1);
    let lo = 0, hi = p.cum.length - 1;
    while (lo < hi) {const mid = (lo + hi) >> 1; if (p.cum[mid] < r) lo = mid + 1; else hi = mid;}
    let u = Math.random(), w = Math.random();
    if (u + w > 1) {u = 1 - u; w = 1 - w;}
    const v0 = p.at(lo * 3), v1 = p.at(lo * 3 + 1), v2 = p.at(lo * 3 + 2), i0 = v0 * 3, i1 = v1 * 3, i2 = v2 * 3;
    for (let d = 0; d < 3; d++) out[k * 3 + d] = p.world[i0 + d] + u * (p.world[i1 + d] - p.world[i0 + d]) + w * (p.world[i2 + d] - p.world[i0 + d]);
    p.paint(lo, v0, v1, v2, u, w).toArray(colors, k * 3);
  }
  return {points: out, colors, triangles};
}

export class Materializer {
  constructor(scene, {wire = 0x3fa9d6} = {}) {
    this.scene = scene;
    this.wire = wire;
    this.active = new Map();  // node -> effect
    // Point/wire shaders belong to the view; clipped copies belong to one model.
    this.clones = new Map();     // original material -> reusable clipped copies
    this.busy = new Set();        // clones in use (two objects taking shape at once may share a material)
    this.spare = [];              // {points, wireMats} of finished effects
    this.dotMap = dot();
  }

  // held: the object stays hidden until release(), e.g. while the camera moves in. delay: seconds it stays hidden
  // after that, so a group taking shape together forms one after another (its points are sampled only then).
  start(node, {held = false, delay = 0} = {}) {
    this.finish(node);
    node.updateWorldMatrix(true, true);
    const meshes = [];
    node.traverse((o) => {if (o.isMesh && o.visible && !o.userData.mask) meshes.push(o);});
    const box = new THREE.Box3();
    meshes.forEach((o) => box.expandByObject(o));
    if (!meshes.length || box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3()), reach = Math.max(size.x, size.y, size.z);
    const lo = box.min.y - 0.01, hi = box.max.y + 0.01;
    const wireTop = new THREE.Plane(new THREE.Vector3(0, -1, 0), lo);      // keeps y <= cut
    const wireAbove = new THREE.Plane(new THREE.Vector3(0, 1, 0), -lo);    // keeps y >= cut (points above the wire)
    const solidTop = new THREE.Plane(new THREE.Vector3(0, -1, 0), lo);
    const solidAbove = new THREE.Plane(new THREE.Vector3(0, 1, 0), -lo);
    // Fine points, sized to the object: a chair's are about a centimetre and a half across.
    const dotSize = THREE.MathUtils.clamp(reach * 0.014, 0.012, 0.03);
    const kit = this.spare.pop() || this.kit();
    kit.points.size = dotSize;
    kit.points.clippingPlanes = [wireAbove];
    kit.wireMats.forEach((m) => (m.clippingPlanes = [wireTop, solidAbove]));

    // Wireframe and a faint fill between the surface front and the wire front.
    const wireMats = kit.wireMats;
    const swaps = [], extras = [];
    for (const o of meshes) {
      const orig = o.material, list = [orig].flat();
      const clones = list.map((m) => {
        const c = this.clipped(m, owner(node));
        this.busy.add(c);
        c.clippingPlanes = [solidTop];
        return c;
      });
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
    const e = {node, t: -delay, held, meshes, n: 0, cloud: null, kit, swaps, extras, triangles: 0, lo, hi,
      planes: {wireTop, wireAbove, solidTop, solidAbove}};
    this.active.set(node, e);
    this.place(e);
  }

  // Concurrent objects sharing a material need separate clipping planes.
  clipped(m, root) {
    const copies = this.clones.get(m) || [];
    let c = copies.find(copy => !this.busy.has(copy));
    if (!c) {
      c = m.clone();
      c.clippingPlanes = [new THREE.Plane()];
      copies.push(c);
      this.clones.set(m, copies);
    }
    if (root) (root.userData.materializerMaterials ||= new Set()).add(m);
    return c;
  }

  // Stand-ins drawn with the points' and wires' materials, for the room view to compile ahead with the clipped
  // copies: a shader is compiled the first time it is drawn with a given number of clipping planes, which
  // stalls the page for about a second.
  standIns() {
    const kit = this.spare.at(-1) || this.spare[this.spare.push(this.kit()) - 1];
    const plane = new THREE.Plane(), geo = this.standInGeometry ||= new THREE.BufferGeometry();
    if (!geo.attributes.position) geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    kit.points.clippingPlanes = [plane];
    kit.wireMats.forEach((m) => (m.clippingPlanes = [plane, plane]));
    return [new THREE.Points(geo, kit.points), ...kit.wireMats.map((m) => new THREE.Mesh(geo, m))];
  }

  kit() {
    // Points and wires sit on surfaces that may already show (a panel on a wall, a rug on the floor): drawn a
    // little towards the camera, so they do not flicker against them.
    const ahead = {polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8};
    return {
      points: lifted(new THREE.PointsMaterial({map: this.dotMap, vertexColors: true, transparent: true, depthWrite: false})),
      wireMats: [
        new THREE.MeshBasicMaterial({color: this.wire, wireframe: true, transparent: true, opacity: 0.7, depthWrite: false, ...ahead}),
        new THREE.MeshBasicMaterial({color: this.wire, transparent: true, opacity: 0.14, depthWrite: false, side: THREE.DoubleSide, ...ahead}),
      ],
    };
  }

  // Let held objects take shape.
  release() {for (const e of this.active.values()) e.held = false;}
  waiting() {return [...this.active.values()].some((e) => e.held);}

  update(dt) {
    for (const e of this.active.values()) {
      if (!e.held) e.t += dt;
      if (e.t >= DONE || !shown(e.node)) {this.finish(e.node); continue;}
      this.place(e);
    }
  }

  // The points on the object's surface, in its own colour; some lighter so the cloud sparkles. Sampling order is
  // random, so drawing the first k points lights them up scattered over the whole shape.
  sample(e) {
    const {points: target, colors, triangles} = surface(e.meshes);
    const n = target.length / 3;
    const col = new Float32Array(n * 3), tmp = new THREE.Color(), white = new THREE.Color(1, 1, 1);
    for (let k = 0; k < n; k++) {
      tmp.fromArray(colors, k * 3).multiplyScalar(1.15);
      if (Math.random() < 0.15) tmp.lerp(white, 0.45);
      tmp.toArray(col, k * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(target, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    e.cloud = new THREE.Points(geo, e.kit.points);
    e.cloud.frustumCulled = false;
    this.scene.add(e.cloud);
    Object.assign(e, {n, triangles});
  }

  place(e) {
    const {t} = e;
    if (!e.cloud && t >= 0) this.sample(e);
    e.cloud?.geometry.setDrawRange(0, Math.round(e.n * span(t, APPEAR)));
    const wire = e.lo + (e.hi - e.lo) * span(t, WIRE), solid = e.lo + (e.hi - e.lo) * span(t, SOLID);
    e.planes.wireTop.constant = wire; e.planes.wireAbove.constant = -wire;
    e.planes.solidTop.constant = solid; e.planes.solidAbove.constant = -solid;
    // The clones follow the originals, which the room view keeps fading (near walls, model swaps).
    for (const s of e.swaps) s.clones.forEach((c, i) => {
      const m = s.list[i];
      c.opacity = m.opacity; c.transparent = m.transparent; c.depthWrite = m.depthWrite; c.visible = m.visible;
    });
  }

  // Triangles shown so far over all objects taking shape (null when none).
  triangles() {
    if (!this.active.size) return null;
    let shownCount = 0;
    for (const e of this.active.values()) shownCount += Math.round(e.triangles * span(e.t, [APPEAR[0] + 0.3, WIRE[1]]));
    return shownCount;
  }

  finish(node) {
    const e = this.active.get(node);
    if (!e) return;
    this.active.delete(node);
    for (const s of e.swaps) {s.o.material = s.orig; s.clones.forEach((c) => this.busy.delete(c));}
    e.extras.forEach((w) => w.removeFromParent());
    e.cloud?.removeFromParent();
    e.cloud?.geometry.dispose();
    this.spare.push(e.kit);
  }

  finishAll() {[...this.active.keys()].forEach((node) => this.finish(node));}

  finishModel(root) {
    for (const node of [...this.active.keys()]) if (inside(node, root)) this.finish(node);
  }

  releaseModel(root) {
    this.finishModel(root);
    root.traverse(node => {
      for (const material of node.userData.materializerMaterials || []) {
        for (const copy of this.clones.get(material) || []) {this.busy.delete(copy); copy.dispose();}
        this.clones.delete(material);
      }
      delete node.userData.materializerMaterials;
    });
  }

  dispose() {
    this.finishAll();
    for (const copies of this.clones.values()) copies.forEach(copy => copy.dispose());
    this.clones.clear(); this.busy.clear();
    for (const kit of this.spare) {kit.points.dispose(); kit.wireMats.forEach(material => material.dispose());}
    this.spare.length = 0;
    this.standInGeometry?.dispose(); this.dotMap.dispose();
  }
}

function inside(node, root) {for (let p = node; p; p = p.parent) if (p === root) return true; return false;}
function owner(node) {for (let p = node; p; p = p.parent) if (p.userData.replayRoot) return p; return node;}

// Points drawn 2 cm towards the camera (polygon offset does not apply to points), and never smaller than
// 3 device pixels: a point of a pixel or two hops between pixels as the camera moves and sparkles.
function lifted(material) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <project_vertex>',
        'vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);\nmvPosition.z += 0.02;\ngl_Position = projectionMatrix * mvPosition;')
      .replace('#include <fog_vertex>', 'gl_PointSize = max(gl_PointSize, 3.0);\n#include <fog_vertex>');
  };
  material.customProgramCacheKey = () => 'lifted-points';
  return material;
}

function shown(node) {
  for (let o = node; o; o = o.parent) if (!o.visible) return false;
  return true;
}
