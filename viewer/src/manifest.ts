export type Vec3 = [number, number, number];
export type Mode = "glb" | "gaussian";

export interface Asset {
  url: string;
  transform: number[];
}

export interface Recommendation {
  id: string;
  position: Vec3;
  target: Vec3;
  up: Vec3;
  fov_y: number;
  score: number;
}

export interface Manifest {
  run_id: string;
  assets: { glb: Asset | null; gaussian: Asset | null };
  display: { center: Vec3; radius: number; up: Vec3 };
  recommendation: Recommendation | null;
  status: "complete" | "unavailable";
  message: string;
}

export function modeFrom(value: unknown): Mode | null {
  if (value === "glb" || value === "GLB 网格") return "glb";
  if (value === "gaussian" || value === "Gaussian") return "gaussian";
  return null;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function numbers(value: unknown, count: number, label: string): number[] {
  if (!Array.isArray(value) || value.length !== count || !value.every((n) => typeof n === "number" && Number.isFinite(n))) {
    throw new Error(`${label} must contain ${count} finite numbers`);
  }
  return [...value];
}

function vec(value: unknown, label: string, nonzero = false): Vec3 {
  const result = numbers(value, 3, label) as Vec3;
  if (nonzero && Math.hypot(...result) < 1e-9) throw new Error(`${label} must be nonzero`);
  return result;
}

export function sameOriginUrl(value: unknown, base: string, origin: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Missing asset URL");
  const url = new URL(value, base);
  if (url.origin !== origin || !["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Viewer resources must be served from the same origin");
  }
  return url.href;
}

export function validateManifest(input: unknown, base: string, origin: string): Manifest {
  const raw = record(input, "manifest");
  const display = record(raw.display, "display");
  const sourceAssets = record(raw.assets, "assets");
  if (typeof raw.run_id !== "string" || !raw.run_id) throw new Error("Missing run_id");
  if (raw.status !== "complete" && raw.status !== "unavailable") throw new Error("Invalid manifest status");
  if (typeof display.radius !== "number" || !Number.isFinite(display.radius) || display.radius <= 0) throw new Error("Invalid display radius");
  const assets = { glb: null, gaussian: null } as Manifest["assets"];
  for (const kind of ["glb", "gaussian"] as const) {
    if (sourceAssets[kind] == null) continue;
    const source = record(sourceAssets[kind], kind);
    const transform = numbers(source.transform, 16, `${kind}.transform`);
    if (Math.abs(transform[3]) + Math.abs(transform[7]) + Math.abs(transform[11]) > 1e-6 || Math.abs(transform[15] - 1) > 1e-6) {
      throw new Error("Asset transform must be an affine column-major matrix");
    }
    assets[kind] = { url: sameOriginUrl(source.url, base, origin), transform };
  }
  let recommendation: Recommendation | null = null;
  if (raw.recommendation != null && raw.status === "complete") {
    const rec = record(raw.recommendation, "recommendation");
    const position = vec(rec.position, "recommendation.position");
    const target = vec(rec.target, "recommendation.target");
    if (Math.hypot(...position.map((n, i) => n - target[i])) < 1e-9) throw new Error("Recommendation has no viewing direction");
    if (typeof rec.id !== "string" || !rec.id) throw new Error("Missing recommendation id");
    if (typeof rec.fov_y !== "number" || !Number.isFinite(rec.fov_y) || rec.fov_y <= 0 || rec.fov_y >= Math.PI) throw new Error("Invalid vertical field of view");
    if (typeof rec.score !== "number" || !Number.isFinite(rec.score)) throw new Error("Invalid recommendation score");
    recommendation = { id: rec.id, position, target, up: vec(rec.up, "recommendation.up", true), fov_y: rec.fov_y, score: rec.score };
  }
  return {
    run_id: raw.run_id,
    assets,
    display: { center: vec(display.center, "display.center"), radius: display.radius, up: vec(display.up, "display.up", true) },
    recommendation,
    status: raw.status,
    message: typeof raw.message === "string" ? raw.message : "",
  };
}

/** Prevent optional glTF decoders or asset references from fetching a CDN at runtime. */
export function validateEmbeddedGlb(buffer: ArrayBuffer): void {
  const header = new DataView(buffer);
  if (buffer.byteLength < 20 || header.getUint32(0, true) !== 0x46546c67 || header.getUint32(4, true) !== 2) {
    throw new Error("Expected a binary glTF 2.0 asset");
  }
  const size = header.getUint32(12, true);
  if (header.getUint32(16, true) !== 0x4e4f534a || 20 + size > buffer.byteLength) throw new Error("Invalid GLB JSON chunk");
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, size)).trim());
  const unsupported = ["KHR_draco_mesh_compression", "EXT_meshopt_compression", "KHR_texture_basisu"];
  if ((json.extensionsUsed ?? []).some((name: string) => unsupported.includes(name))) {
    throw new Error("Compressed GLB codecs are not bundled; export an uncompressed GLB");
  }
  for (const entry of [...(json.buffers ?? []), ...(json.images ?? [])]) {
    if (typeof entry.uri === "string" && !entry.uri.startsWith("data:")) throw new Error("GLB must embed its buffers and textures");
  }
}
