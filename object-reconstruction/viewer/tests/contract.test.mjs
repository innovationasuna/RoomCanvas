import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { plyHeaderFix } from "../babylon-ply-fix.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(path.join(root, ".test-build"), { recursive: true });
await build({
  absWorkingDir: root,
  stdin: { contents: 'export * from "./src/layout-drag.ts"; export * from "./src/manifest.ts"; export * from "./src/coordinates.ts"; export { AXIS_DIRECTIONS, UNIT_METERS, scaledCameraPoint } from "./src/dimensions.ts";', resolveDir: root, sourcefile: "unit.ts" },
  outfile: path.join(root, ".test-build/contract.mjs"), bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent",
  plugins: [{ name: "node-babylon-extensions", setup(b) {
    b.onResolve({ filter: /^@babylonjs\/core\// }, (args) => ({ path: args.path.endsWith(".js") ? args.path : `${args.path}.js`, external: true }));
  } }],
});
const { arrowRotation, gaussianDecoderCorrection, overviewCamera, modeFrom, sameOriginUrl, validateEmbeddedGlb, validateManifest } = await import("../.test-build/contract.mjs");
const { AXIS_DIRECTIONS, UNIT_METERS, scaledCameraPoint } = await import("../.test-build/contract.mjs");
await build({
  absWorkingDir: root,
  entryPoints: ["node_modules/@babylonjs/core/Meshes/GaussianSplatting/gaussianSplattingMesh.js"],
  outfile: path.join(root, ".test-build/gaussian-loader.mjs"), bundle: true, format: "esm", platform: "node", logLevel: "silent",
  plugins: [plyHeaderFix],
});
const { GaussianSplattingMesh } = await import("../.test-build/gaussian-loader.mjs");
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const origin = "http://127.0.0.1:7865";
const base = `${origin}/runs/example/preview.json`;
const manifest = () => ({
  run_id: "example", status: "complete", message: "",
  assets: { glb: { url: "mesh.glb", transform: identity }, gaussian: { url: "/model.ply", transform: identity } },
  display: { center: [0, 0, 0], radius: 1, up: [0, 1, 0] },
  recommendation: { id: "v-1", position: [1, 2, 3], target: [0, 0, 0], up: [0, 1, 0], fov_y: 0.8, score: 0.2 },
});
const close = (actual, expected) => actual.forEach((n, i) => assert.ok(Math.abs(n - expected[i]) < 1e-5, `${actual} != ${expected}`));

test("both parent mode labels select the same two modes", () => {
  assert.equal(modeFrom("GLB 网格"), "glb");
  assert.equal(modeFrom("glb"), "glb");
  assert.equal(modeFrom("Gaussian"), "gaussian");
  assert.equal(modeFrom("gaussian"), "gaussian");
  assert.equal(modeFrom("other"), null);
});

test("measurement labels form a right-handed Z-up frame and camera scaling is reversible", () => {
  assert.deepEqual(AXIS_DIRECTIONS.Z, [0, 1, 0]);
  close(Vector3.Cross(Vector3.FromArray(AXIS_DIRECTIONS.X), Vector3.FromArray(AXIS_DIRECTIONS.Y)).asArray(), AXIS_DIRECTIONS.Z);
  assert.equal(120 * UNIT_METERS.cm, 1200 * UNIT_METERS.mm);
  const point = [3, -4, 8];
  close(scaledCameraPoint(scaledCameraPoint(point, .015), 1 / .015), point);
});

test("manifest resolves same-origin URLs without mutating native transforms", () => {
  const parsed = validateManifest(manifest(), base, origin);
  assert.equal(parsed.assets.glb.url, `${origin}/runs/example/mesh.glb`);
  assert.deepEqual(parsed.assets.gaussian.transform, identity);
  assert.equal(parsed.recommendation.fov_y, 0.8);
  assert.throws(() => sameOriginUrl("https://cdn.example/model.ply", base, origin), /same origin/);
  assert.throws(() => sameOriginUrl("javascript:alert(1)", base, origin), /same origin/);
});

test("unavailable results do not expose an unvalidated recommendation", () => {
  const data = manifest();
  data.status = "unavailable";
  assert.equal(validateManifest(data, base, origin).recommendation, null);
  data.status = "complete";
  data.recommendation.fov_y = 60;
  assert.throws(() => validateManifest(data, base, origin), /field of view/);
});

test("optional preview shares full GLB coordinates and supports older manifests", () => {
  assert.equal(validateManifest(manifest(), base, origin).assets.glb_preview, null);
  const data = manifest();
  data.assets.glb_preview = { url: 'preview.glb', transform: [...identity] };
  assert.equal(validateManifest(data, base, origin).assets.glb_preview.url, `${origin}/runs/example/preview.glb`);
  data.assets.glb_preview.transform[12] = 1;
  assert.throws(() => validateManifest(data, base, origin), /same display transform/);
  data.assets.glb_preview.transform = [...identity];
  data.assets.glb_preview.url = 'https://example.com/preview.glb';
  assert.throws(() => validateManifest(data, base, origin), /same origin/);
});

test("arrow points from camera position toward target including pole cases", () => {
  for (const [position, target] of [[[1, 2, 3], [-2, 4, 1]], [[0, 0, 0], [0, 1, 0]], [[0, 0, 0], [0, -1, 0]]]) {
    const rotation = Matrix.Identity();
    arrowRotation(position, target).toRotationMatrix(rotation);
    close(Vector3.TransformNormal(Vector3.Up(), rotation).normalize().asArray(), Vector3.FromArray(target).subtract(Vector3.FromArray(position)).normalize().asArray());
  }
});

test("initial overview is 75 degrees to the recommended radial direction and frames both spheres", () => {
  for (const position of [[0, 0, -3], [2.7, 0.8, 1], [0, 3, 0]]) {
    const data = manifest();
    data.recommendation.position = position;
    for (const aspect of [0.65, 1.4]) {
      const camera = overviewCamera(data, aspect);
      const target = Vector3.FromArray(camera.target);
      const eye = Vector3.FromArray(camera.position);
      const viewDir = eye.subtract(target).normalize();
      const planar = viewDir.clone(); planar.y = 0; planar.normalize();
      const radial = Vector3.FromArray(position); radial.y = 0;
      if (radial.lengthSquared() > 1e-6) assert.ok(Math.abs(Vector3.Dot(planar, radial.normalize()) - Math.cos(75 * Math.PI / 180)) < 1e-6);
      const forward = target.subtract(eye).normalize();
      const right = Vector3.Cross(forward, Vector3.Up()).normalize();
      const vertical = Vector3.Cross(right, forward).normalize();
      const verticalFov = camera.fov_y / 2;
      const horizontalFov = Math.atan(Math.tan(verticalFov) * aspect);
      const marker = Vector3.FromArray(position);
      marker.addInPlace(Vector3.Zero().subtract(marker).normalize().scale(0.195));
      for (const [center, radius] of [[Vector3.Zero(), 1], [marker, 0.21]]) {
        const offset = center.subtract(eye);
        const depth = Vector3.Dot(offset, forward);
        assert.ok(depth * Math.sin(horizontalFov) - Math.abs(Vector3.Dot(offset, right)) * Math.cos(horizontalFov) > radius);
        assert.ok(depth * Math.sin(verticalFov) - Math.abs(Vector3.Dot(offset, vertical)) * Math.cos(verticalFov) > radius);
      }
    }
  }
});

test("Babylon PLY decode correction and parent transforms preserve one shared native point", async () => {
  const properties = ["x", "y", "z", "nx", "ny", "nz", "scale_0", "scale_1", "scale_2", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "rot_0", "rot_1", "rot_2", "rot_3"];
  const header = new TextEncoder().encode(`ply\nformat binary_little_endian 1.0\nelement vertex 1\n${properties.map((p) => `property float ${p}`).join("\n")}\nend_header\n`);
  const ply = new Uint8Array(header.byteLength + properties.length * 4);
  ply.set(header);
  const values = [0.3, -0.5, 0.7, 0, 0, 1, -3, -3, -3, 0.2, 0.4, 0.7, 2, 1, 0, 0, 0];
  const view = new DataView(ply.buffer);
  values.forEach((value, i) => view.setFloat32(header.byteLength + i * 4, value, true));
  const converted = await GaussianSplattingMesh.ConvertPLYWithSHToSplatAsync(ply.buffer);
  assert.equal(GaussianSplattingMesh.ParseHeader(ply.buffer).shDegree, 0, "normals must not enable phantom SH");
  assert.equal(converted.sh, null);
  const rgba = new Uint8Array(converted.buffer, 24, 4);
  const expectedRGB = [0.2, 0.4, 0.7].map((value) => Math.round((0.5 + 0.28209479177387814 * value) * 255));
  assert.deepEqual(Array.from(rgba.slice(0, 3)), expectedRGB, "DC coefficients must preserve their expected RGB colors");
  const splat = new Float32Array(converted.buffer);
  close(Array.from(splat.slice(0, 3)), [0.3, 0.5, -0.7]);
  const decodedCenter = new Vector3(splat[0], -splat[1], splat[2]);
  const engine = new NullEngine();
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  const nativeToDisplay = Matrix.RotationX(-Math.PI / 2).multiply(Matrix.Translation(2, 3, 4));
  const parent = new TransformNode("native-to-display", scene);
  parent.setPreTransformMatrix(nativeToDisplay);
  const gaussian = new TransformNode("decoder-correction", scene);
  gaussian.parent = parent;
  gaussian.scaling.copyFrom(gaussianDecoderCorrection(true));
  const glbDisplay = Vector3.TransformCoordinates(Vector3.FromArray(values.slice(0, 3)), nativeToDisplay);
  close(Vector3.TransformCoordinates(decodedCenter, gaussian.computeWorldMatrix(true)).asArray(), glbDisplay.asArray());
  scene.dispose();
  engine.dispose();
});

test("PLY SH degree counts genuine coefficients regardless of unknown fields or property order", () => {
  for (const [count, degree] of [[0, 0], [9, 1], [24, 2], [45, 3]]) {
    const names = ["x", "y", "z", ...Array.from({ length: count }, (_, i) => `f_rest_${count - 1 - i}`), "nx", "ny", "nz"];
    const header = new TextEncoder().encode(`ply\nformat binary_little_endian 1.0\nelement vertex 0\n${names.map((name) => `property float ${name}`).join("\n")}\nend_header\n`);
    assert.equal(GaussianSplattingMesh.ParseHeader(header.buffer).shDegree, degree);
  }
});

test("GLB offline guard allows embedded data and rejects runtime codec/network dependencies", () => {
  const makeGlb = (json) => {
    const text = JSON.stringify(json);
    const bytes = new TextEncoder().encode(text.padEnd(Math.ceil(text.length / 4) * 4, " "));
    const data = new ArrayBuffer(20 + bytes.byteLength);
    const header = new DataView(data);
    [0x46546c67, 2, data.byteLength, bytes.byteLength, 0x4e4f534a].forEach((value, i) => header.setUint32(i * 4, value, true));
    new Uint8Array(data, 20).set(bytes);
    return data;
  };
  assert.doesNotThrow(() => validateEmbeddedGlb(makeGlb({ asset: { version: "2.0" }, buffers: [{ byteLength: 12 }], images: [{ bufferView: 0 }] })));
  assert.throws(() => validateEmbeddedGlb(makeGlb({ images: [{ uri: "https://example.com/image.png" }] })), /embed/);
  assert.throws(() => validateEmbeddedGlb(makeGlb({ extensionsUsed: ["KHR_draco_mesh_compression"] })), /codecs/);
});

const { rotationFromPointer, translationFromPointer } = await import('../.test-build/contract.mjs');
test('pointer translation preserves the grabbed offset without snapping the model center',()=>{
 assert.deepEqual(translationFromPointer(-2,1,-1.5,1.3,-.5,.3),{x:-1,z:0});
});
test('rotation crosses the angle branch continuously and preserves arbitrary angles',()=>{
 const yaw=rotationFromPointer(.3,Math.PI-.01,-Math.PI+.01);
 assert.ok(Math.abs(yaw-.28)<1e-10);
 assert.ok(Math.abs(rotationFromPointer(0,0,-.3)-.3)<1e-10);
});
