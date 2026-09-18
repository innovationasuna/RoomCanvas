import { Engine } from "@babylonjs/core/Engines/engine";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Scene } from "@babylonjs/core/scene";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Camera } from "@babylonjs/core/Cameras/camera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { CreateCylinder } from "@babylonjs/core/Meshes/Builders/cylinderBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { GaussianSplattingMesh } from "@babylonjs/core/Meshes/GaussianSplatting/gaussianSplattingMesh";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import { PointerEventTypes } from "@babylonjs/core/Events/pointerEvents";
import type { AssetContainer } from "@babylonjs/core/assetContainer";
import "@babylonjs/core/Culling/ray";
import "@babylonjs/loaders/glTF/2.0/glTFLoader";
import "@babylonjs/loaders/glTF/2.0/Extensions/KHR_materials_unlit";
import "@babylonjs/loaders/glTF/2.0/Extensions/KHR_texture_transform";
import { modeFrom, sameOriginUrl, validateEmbeddedGlb, validateManifest, type Asset, type Manifest, type Mode, type Vec3 } from "./manifest";
import { arrowRotation, gaussianDecoderCorrection, overviewCamera, vector } from "./coordinates";
import "./styles.css";

declare global {
  interface Window {
    __VIEWFORGE_VIEWER_CONFIG__?: { manifest?: string; mode?: string; baseUrl?: string };
    __viewforgeViewer?: { readonly state: Record<string, unknown> };
  }
}

type Phase = "loading-manifest" | "loading-asset" | "ready" | "unavailable" | "error" | "disposed";
type LoadState = "unloaded" | "loading" | "ready" | "error";
type CameraState = { position: Vec3; target: Vec3; up: Vec3; fov_y: number };
type LoadedAsset = { root: TransformNode; meshes: Mesh[]; container?: AssetContainer; decoderCorrection?: number[] };

interface RunScene {
  scene: Scene;
  camera: ArcRotateCamera;
  manifest: Manifest;
  assets: Partial<Record<Mode, LoadedAsset>>;
  loading: Partial<Record<Mode, Promise<void>>>;
  loadStates: Record<Mode, LoadState>;
  arrow: TransformNode | null;
  view: "overview" | "recommendation";
  previousCamera: CameraState | null;
  disposed: boolean;
}

const $ = <T extends HTMLElement>(id: string) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing viewer element: ${id}`);
  return element as T;
};

const label = (mode: Mode) => mode === "glb" ? "GLB 网格" : "Gaussian";

class CoverViewer {
  private readonly canvas = $<HTMLCanvasElement>("render-canvas");
  private readonly engine: Engine;
  private readonly origin: string;
  private readonly base: string;
  private current: RunScene | null = null;
  private abort = new AbortController();
  private generation = 0;
  private phase: Phase = "loading-manifest";
  private desiredMode: Mode = "glb";
  private shownMode: Mode | null = null;
  private manifestUrl = "";
  private arrowVisible = true;
  private error: string | null = null;
  private disposedScenes = 0;
  private renderedFrames = 0;
  private readonly resizeObserver: ResizeObserver;

  constructor() {
    const config = window.__VIEWFORGE_VIEWER_CONFIG__;
    this.base = config?.baseUrl || document.baseURI;
    this.origin = new URL(this.base).origin;
    this.engine = new Engine(this.canvas, true, { preserveDrawingBuffer: false, stencil: true, premultipliedAlpha: false });
    this.engine.setHardwareScalingLevel(Math.max(1, window.devicePixelRatio / 2));
    this.engine.runRenderLoop(() => {
      if (!this.current || this.current.disposed) return;
      this.current.scene.render();
      this.updateCameraLabel();
      this.renderedFrames += 1;
    });
    this.resizeObserver = new ResizeObserver(() => this.engine.resize());
    this.resizeObserver.observe(this.canvas);
    // Keep wheel gestures inside the embedded viewer: Babylon uses them to
    // dolly the camera, while the browser default would also scroll Gradio.
    this.canvas.addEventListener("wheel", (event) => event.preventDefault(), { passive: false });
    window.addEventListener("resize", () => this.engine.resize());
    window.addEventListener("message", this.onMessage);
    window.addEventListener("pagehide", () => this.dispose(), { once: true });
    this.engine.onContextLostObservable.add(() => this.fail("三维预览暂时中断，请重试。", new Error("WebGL context lost")));
    $("toggle-arrow").addEventListener("click", () => {
      this.arrowVisible = !this.arrowVisible;
      this.updateArrow();
      this.updateControls();
    });
    $("recommended-view").addEventListener("click", () => this.showRecommendation());
    $("overview").addEventListener("click", () => this.showOverview());
    $("retry").addEventListener("click", () => {
      if (this.current && this.current.loadStates[this.desiredMode] === "error") void this.setMode(this.desiredMode);
      else if (this.manifestUrl) void this.loadManifest(this.manifestUrl);
    });
    Object.defineProperty(window, "__viewforgeViewer", {
      configurable: false,
      value: Object.freeze({ get state() { return viewer.snapshot(); } }),
    });
    const viewer = this;
    const query = new URLSearchParams(window.location.search);
    this.desiredMode = modeFrom(config?.mode ?? query.get("mode")) ?? "glb";
    const manifest = config?.manifest ?? query.get("manifest");
    if (manifest) void this.loadManifest(manifest);
    else {
      this.phase = "unavailable";
      this.status("暂时没有可预览的重建结果。", false);
      this.updateControls();
    }
  }

  private status(message: string | null, busy = false, isError = false) {
    const element = $("status");
    element.hidden = !message;
    element.dataset.busy = String(busy);
    element.dataset.error = String(isError);
    $("status-text").textContent = message ?? "";
    $("retry").hidden = !isError;
  }

  private fail(message: string, cause: unknown) {
    this.phase = "error";
    this.error = cause instanceof Error ? cause.message : String(cause);
    this.status(message, false, true);
    this.updateControls();
    console.error("[ViewForge viewer]", cause);
  }

  private readonly onMessage = (event: MessageEvent) => {
    if (event.origin !== this.origin || event.source !== window.parent || !event.data || typeof event.data !== "object") return;
    if (!["viewforge-mode", "viewforge-manifest"].includes(event.data.type)) return;
    const mode = modeFrom(event.data.mode);
    if (mode) this.desiredMode = mode;
    const url = event.data.manifestUrl ?? event.data.manifest ?? event.data.url;
    if (typeof url === "string" && url) {
      try {
        const resolved = sameOriginUrl(url, this.base, this.origin);
        if (resolved !== this.manifestUrl || event.data.reload === true || event.data.type === "viewforge-manifest") {
          void this.loadManifest(resolved);
          return;
        }
      } catch (error) {
        this.fail("无法读取新的重建结果。", error);
        return;
      }
    }
    if (mode) void this.setMode(mode);
  };

  private async loadManifest(url: string) {
    const generation = ++this.generation;
    this.abort.abort();
    this.abort = new AbortController();
    this.disposeRun();
    this.shownMode = null;
    this.error = null;
    this.phase = "loading-manifest";
    this.status("正在读取重建结果…", true);
    this.updateControls();
    try {
      this.manifestUrl = sameOriginUrl(url, this.base, this.origin);
      const response = await fetch(this.manifestUrl, { signal: this.abort.signal, credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error(`Manifest HTTP ${response.status}`);
      const manifest = validateManifest(await response.json(), this.manifestUrl, this.origin);
      if (generation !== this.generation) return;
      this.current = this.createScene(manifest);
      if (!manifest.assets[this.desiredMode]) this.desiredMode = manifest.assets.glb ? "glb" : "gaussian";
      if (!manifest.assets[this.desiredMode]) {
        this.phase = "unavailable";
        this.status(manifest.message || "当前结果暂时没有可预览的模型。", false);
        this.updateControls();
        return;
      }
      await this.setMode(this.desiredMode);
    } catch (error) {
      if (generation === this.generation && !this.abort.signal.aborted) this.fail("无法读取重建结果，请重试。", error);
    }
  }

  private createScene(manifest: Manifest): RunScene {
    const scene = new Scene(this.engine);
    scene.useRightHandedSystem = true;
    scene.clearColor = new Color4(0.91, 0.94, 0.915, 1);
    // All geometry shares rendering group 0 and its depth buffer. No overlay scene,
    // depth clearing between object/marker, or depthFunction=ALWAYS is used.
    scene.setRenderingAutoClearDepthStencil(0, false);
    const center = vector(manifest.display.center);
    const up = vector(manifest.display.up).normalize();
    const radius = manifest.display.radius;
    const camera = new ArcRotateCamera("viewer-camera", 0, Math.PI / 2.6, radius * 3.5, center, scene);
    camera.upVector = up;
    camera.fov = 0.82;
    camera.fovMode = Camera.FOVMODE_VERTICAL_FIXED;
    camera.minZ = Math.max(radius * 0.001, 1e-6);
    camera.maxZ = Math.max(radius * 200, 1);
    camera.lowerRadiusLimit = radius * 0.12;
    camera.upperRadiusLimit = radius * 60;
    camera.lowerBetaLimit = 0.002;
    camera.upperBetaLimit = Math.PI - 0.002;
    camera.wheelDeltaPercentage = 0.015;
    camera.panningSensibility = 1000 / radius;
    camera.pinchDeltaPercentage = 0.015;
    const overview = overviewCamera(manifest, this.engine.getRenderWidth() / Math.max(1, this.engine.getRenderHeight()));
    camera.setTarget(vector(overview.target));
    camera.setPosition(vector(overview.position));
    const forward = vector(overview.position).subtract(center).normalize();
    const right = Vector3.Cross(up, forward).normalize();
    camera.attachControl(this.canvas, false);
    const light = new HemisphericLight("sky-light", up, scene);
    light.intensity = 1.0;
    light.groundColor = new Color3(0.58, 0.60, 0.57);
    const key = new DirectionalLight("key-light", forward.scale(-1).subtract(up).normalize(), scene);
    key.intensity = 1.2;
    const fill = new DirectionalLight("fill-light", forward.add(right).subtract(up).normalize(), scene);
    fill.intensity = 0.6;
    const run: RunScene = {
      scene, camera, manifest,
      assets: {}, loading: {}, loadStates: { glb: "unloaded", gaussian: "unloaded" },
      arrow: null, view: "overview", previousCamera: null, disposed: false,
    };
    if (manifest.recommendation) {
      const recommendation = manifest.recommendation;
      const arrow = new TransformNode("recommended-camera", scene);
      arrow.position.copyFrom(vector(recommendation.position));
      arrow.rotationQuaternion = arrowRotation(recommendation.position, recommendation.target);
      const material = new StandardMaterial("recommended-camera-material", scene);
      material.diffuseColor = Color3.FromHexString("#ec743b");
      material.emissiveColor = Color3.FromHexString("#813512").scale(0.36);
      material.specularColor = Color3.Black();
      material.disableDepthWrite = false;
      material.depthFunction = Constants.LEQUAL;
      const shaft = CreateCylinder("recommended-camera-shaft", { height: radius * 0.25, diameter: radius * 0.035, tessellation: 16 }, scene);
      shaft.position.y = radius * 0.125;
      const tip = CreateCylinder("recommended-camera-tip", { height: radius * 0.14, diameterTop: 0, diameterBottom: radius * 0.12, tessellation: 20 }, scene);
      tip.position.y = radius * 0.32;
      const base = CreateCylinder("recommended-camera-origin", { height: radius * 0.028, diameter: radius * 0.095, tessellation: 20 }, scene);
      for (const part of [shaft, tip, base]) {
        part.parent = arrow;
        part.material = material;
        part.renderingGroupId = 0;
        part.isPickable = true;
        part.metadata = { viewforgeRecommendation: true };
      }
      run.arrow = arrow;
      scene.onPointerObservable.add((info) => {
        if (info.type === PointerEventTypes.POINTERPICK && info.pickInfo?.pickedMesh?.metadata?.viewforgeRecommendation) this.showRecommendation();
      });
    }
    return run;
  }

  private async setMode(mode: Mode) {
    this.desiredMode = mode;
    const run = this.current;
    if (!run || run.disposed) return;
    this.error = null;
    const asset = run.manifest.assets[mode];
    if (!asset) {
      this.phase = "unavailable";
      this.status(`这个结果没有 ${label(mode)} 预览。`, false);
      this.updateControls();
      return;
    }
    this.phase = "loading-asset";
    this.status(`正在载入 ${label(mode)}…`, true);
    this.updateControls();
    try {
      if (run.loadStates[mode] !== "ready") {
        if (!run.loading[mode]) {
          run.loadStates[mode] = "loading";
          run.loading[mode] = this.loadAsset(run, mode, asset).finally(() => { delete run.loading[mode]; });
        }
        await run.loading[mode];
      }
      if (this.current !== run || run.disposed || this.desiredMode !== mode) return;
      for (const [kind, loaded] of Object.entries(run.assets)) loaded.root.setEnabled(kind === mode);
      // Mode switches deliberately do not touch camera position, target, up or FOV.
      this.shownMode = mode;
      this.phase = "ready";
      this.status(null);
      this.updateArrow();
      this.updateControls();
    } catch (error) {
      if (this.current !== run || run.disposed) return;
      run.loadStates[mode] = "error";
      if (this.desiredMode === mode) this.fail(`${label(mode)} 预览载入失败，请重试。`, error);
    }
  }

  private async loadAsset(run: RunScene, mode: Mode, asset: Asset) {
    const signal = this.abort.signal;
    let root: TransformNode | null = null;
    let container: AssetContainer | undefined;
    let gaussian: GaussianSplattingMesh | null = null;
    try {
      const response = await fetch(asset.url, { signal, credentials: "same-origin" });
      if (!response.ok) throw new Error(`Asset HTTP ${response.status}`);
      const buffer = await response.arrayBuffer();
      if (signal.aborted || run.disposed) return;
      root = new TransformNode(`${mode}-native-to-display`, run.scene);
      root.setEnabled(false);
      root.setPreTransformMatrix(Matrix.FromArray(asset.transform));
      let meshes: Mesh[];
      let decoderCorrection: number[] | undefined;
      if (mode === "glb") {
        validateEmbeddedGlb(buffer);
        container = await LoadAssetContainerAsync(new Uint8Array(buffer), run.scene, { pluginExtension: ".glb", name: "model.glb" });
        if (run.disposed || signal.aborted) { container.dispose(); root.dispose(); return; }
        // Reconstruction textures already contain appearance/shading. Preserve
        // their original albedo without adding faceted mesh-normal lighting.
        for (const material of container.materials) {
          if (material instanceof PBRMaterial && material.albedoTexture) material.unlit = true;
        }
        for (const node of container.rootNodes) node.parent = root;
        container.addAllToScene();
        meshes = container.meshes.filter((mesh): mesh is Mesh => mesh instanceof Mesh);
      } else {
        const isPly = new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(3, buffer.byteLength))) === "ply";
        if (!isPly && (buffer.byteLength === 0 || buffer.byteLength % 32 !== 0)) throw new Error("Expected Gaussian PLY or raw splat data");
        gaussian = new GaussianSplattingMesh("reconstruction-gaussians", null, run.scene, false);
        gaussian.parent = root;
        gaussian.scaling.copyFrom(gaussianDecoderCorrection(isPly));
        decoderCorrection = gaussian.scaling.asArray();
        const data = isPly ? await GaussianSplattingMesh.ConvertPLYWithSHToSplatAsync(buffer) : { buffer, sh: undefined };
        if (run.disposed || signal.aborted) { gaussian.dispose(); root.dispose(); return; }
        await gaussian.updateDataAsync(data.buffer, data.sh ?? undefined);
        gaussian.isPickable = false;
        // Keep Babylon's alpha blending and depth test. A marker behind the object
        // is covered by foreground splats instead of being drawn as an HTML overlay.
        gaussian.renderingGroupId = 0;
        meshes = [gaussian];
      }
      if (run.disposed || signal.aborted) { container?.dispose(); gaussian?.dispose(); root.dispose(); return; }
      if (!meshes.some((mesh) => mesh.getTotalVertices() > 0)) throw new Error("Asset has no renderable geometry");
      root.computeWorldMatrix(true);
      for (const mesh of meshes) { mesh.renderingGroupId = 0; mesh.computeWorldMatrix(true); }
      await this.waitForReady(run, meshes);
      if (run.disposed || signal.aborted) { container?.dispose(); gaussian?.dispose(); root.dispose(); return; }
      run.assets[mode] = { root, meshes, container, decoderCorrection };
      root.setEnabled(this.desiredMode === mode);
      run.loadStates[mode] = "ready";
    } catch (error) {
      container?.dispose();
      gaussian?.dispose();
      root?.dispose(false, true);
      throw error;
    }
  }

  private waitForReady(run: RunScene, meshes: Mesh[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const started = performance.now();
      const check = () => {
        if (run.disposed) { cleanup(); resolve(); return; }
        if (meshes.every((mesh) => mesh.isReady(true))) { cleanup(); resolve(); return; }
        if (performance.now() - started > 45000) { cleanup(); reject(new Error("Timed out waiting for model shaders or Gaussian sorting")); }
      };
      const observer = run.scene.onAfterRenderObservable.add(check);
      const interval = window.setInterval(check, 250);
      const cleanup = () => { window.clearInterval(interval); run.scene.onAfterRenderObservable.remove(observer); };
      check();
    });
  }

  private cameraState(camera: ArcRotateCamera): CameraState {
    return { position: camera.position.asArray() as Vec3, target: camera.target.asArray() as Vec3, up: camera.upVector.asArray() as Vec3, fov_y: camera.fov };
  }

  private restoreCamera(camera: ArcRotateCamera, snapshot: CameraState) {
    camera.inertialAlphaOffset = 0;
    camera.inertialBetaOffset = 0;
    camera.inertialRadiusOffset = 0;
    camera.inertialPanningX = 0;
    camera.inertialPanningY = 0;
    camera.upVector = vector(snapshot.up).normalize();
    camera.fov = snapshot.fov_y;
    camera.setTarget(vector(snapshot.target));
    camera.setPosition(vector(snapshot.position));
    camera.getViewMatrix(true);
  }

  private showRecommendation() {
    const run = this.current;
    const recommendation = run?.manifest.recommendation;
    if (!run || !recommendation || this.phase !== "ready") return;
    if (run.view === "overview") run.previousCamera = this.cameraState(run.camera);
    run.view = "recommendation";
    this.restoreCamera(run.camera, { position: recommendation.position, target: recommendation.target, up: recommendation.up, fov_y: recommendation.fov_y });
    this.updateArrow();
    this.updateControls();
  }

  private showOverview() {
    const run = this.current;
    if (!run || !run.previousCamera) return;
    this.restoreCamera(run.camera, run.previousCamera);
    run.view = "overview";
    run.previousCamera = null;
    this.updateArrow();
    this.updateControls();
  }

  private updateArrow() {
    const run = this.current;
    // Hide the camera's own arrow while looking through that camera.
    run?.arrow?.setEnabled(this.arrowVisible && run.view === "overview");
    this.updateCameraLabel();
  }

  private updateCameraLabel() {
    const label = $("camera-label");
    const run = this.current;
    if (!run?.arrow?.isEnabled() || run.disposed || this.phase !== "ready") {
      label.hidden = true;
      return;
    }
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    const projected = Vector3.Project(
      run.arrow.getAbsolutePosition(), Matrix.Identity(), run.scene.getTransformMatrix(),
      run.camera.viewport.toGlobal(width, height),
    );
    label.hidden = projected.z < 0 || projected.z > 1 || projected.x < 0 || projected.x > width || projected.y < 0 || projected.y > height;
    if (!label.hidden) {
      const margin = label.offsetWidth / 2 + 8;
      label.style.left = `${Math.max(margin, Math.min(width - margin, projected.x))}px`;
      label.style.top = `${Math.max(label.offsetHeight + 21, projected.y)}px`;
    }
  }

  private updateControls() {
    const run = this.current;
    const ready = this.phase === "ready";
    const recommended = run?.view === "recommendation";
    const hasRecommendation = !!run?.manifest.recommendation;
    $("viewer").dataset.view = recommended ? "recommendation" : "overview";
    $("mode-chip").textContent = label(this.shownMode ?? this.desiredMode);
    const toggle = $<HTMLButtonElement>("toggle-arrow");
    toggle.disabled = !ready || !hasRecommendation || recommended;
    toggle.setAttribute("aria-pressed", String(this.arrowVisible));
    $("arrow-label").textContent = this.arrowVisible ? "隐藏补拍箭头" : "显示补拍箭头";
    $<HTMLButtonElement>("recommended-view").disabled = !ready || !hasRecommendation || recommended;
    const overview = $<HTMLButtonElement>("overview");
    overview.disabled = !run?.previousCamera;
    overview.hidden = !recommended;
    const hint = $("hint");
    hint.hidden = !run || (hasRecommendation && !recommended && this.arrowVisible);
    hint.textContent = recommended
      ? "已切换到建议的取景位置；返回概览可继续查看物体。"
      : hasRecommendation
        ? this.arrowVisible ? "" : "补拍箭头已隐藏，仍可查看推荐取景。"
        : run?.manifest.message || "当前结果暂时没有可用的补拍建议。";
  }

  private disposeRun() {
    const run = this.current;
    if (!run) return;
    run.disposed = true;
    run.camera.detachControl();
    run.scene.dispose(); // Includes Gaussian sort worker, textures and asset meshes.
    this.disposedScenes += 1;
    this.current = null;
    $("camera-label").hidden = true;
  }

  private dispose() {
    if (this.phase === "disposed") return;
    this.generation += 1;
    this.abort.abort();
    this.disposeRun();
    this.resizeObserver.disconnect();
    window.removeEventListener("message", this.onMessage);
    this.engine.stopRenderLoop();
    this.engine.dispose();
    this.phase = "disposed";
  }

  private snapshot(): Record<string, unknown> {
    const run = this.current;
    const assets: Record<string, unknown> = {};
    if (run) {
      for (const mode of ["glb", "gaussian"] as const) {
        const loaded = run.assets[mode];
        assets[mode] = {
          status: run.loadStates[mode],
          visible: loaded?.root.isEnabled() ?? false,
          nativeToDisplay: run.manifest.assets[mode]?.transform ?? null,
          decoderCorrection: loaded?.decoderCorrection ?? null,
          worldMatrices: loaded?.meshes.map((mesh) => Array.from(mesh.computeWorldMatrix(true).m)) ?? [],
          vertices: loaded?.meshes.reduce((total, mesh) => total + mesh.getTotalVertices(), 0) ?? 0,
        };
      }
    }
    return {
      version: 1, build: "cover-viewer-1.3.0", renderer: "Babylon.js", babylonVersion: Engine.Version,
      phase: this.phase, manifestUrl: this.manifestUrl, generation: this.generation,
      runId: run?.manifest.run_id ?? null, manifestStatus: run?.manifest.status ?? null,
      requestedMode: this.desiredMode, mode: this.shownMode,
      rightHanded: run?.scene.useRightHandedSystem ?? true,
      coordinateContract: "asset native → manifest column-major matrix → shared display; no independent normalization",
      camera: run ? this.cameraState(run.camera) : null,
      view: run?.view ?? "overview", recommendation: run?.manifest.recommendation ?? null,
      arrowVisible: this.arrowVisible, arrowActuallyVisible: run?.arrow?.isEnabled() ?? false,
      cameraLabelVisible: !$("camera-label").hidden,
      arrow: run?.arrow ? {
        position: run.arrow.getAbsolutePosition().asArray(),
        direction: Vector3.TransformNormal(Vector3.Up(), run.arrow.computeWorldMatrix(true)).normalize().asArray(),
        renderingGroup: 0, depthTest: "LEQUAL", depthWrite: true,
      } : null,
      assets, error: this.error,
      renderedFrames: this.renderedFrames, disposedScenes: this.disposedScenes,
      liveScenes: this.engine.scenes.length, liveMeshes: run?.scene.meshes.length ?? 0,
    };
  }
}

try {
  new CoverViewer();
} catch (error) {
  const status = document.getElementById("status");
  const text = document.getElementById("status-text");
  if (status) { status.hidden = false; status.dataset.error = "true"; status.dataset.busy = "false"; }
  if (text) text.textContent = "这个浏览器暂时无法显示三维预览，请启用硬件加速后重试。";
  console.error("[ViewForge viewer] Initialization failed", error);
  if (!window.__viewforgeViewer) window.__viewforgeViewer = { state: { phase: "error", error: String(error), babylonVersion: "8.2.0" } };
}
