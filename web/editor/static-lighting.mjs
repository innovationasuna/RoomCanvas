import * as THREE from 'three';
import {GTAOPass} from 'three/addons/postprocessing/GTAOPass.js';
import {FullScreenQuad} from 'three/addons/postprocessing/Pass.js';
import {SettledRender} from './settled-render.mjs';

// Optional screen-space contact shading. Does not own or change the room's lights,
// materials, placement logic or shadow maps. Buffers are allocated only after settling.
export function createStaticLighting({renderer, scene, camera, room, roomSize, busy, enabled = true, metrics = null, N8AOPass = null}) {
  const supported = renderer.extensions.has('EXT_color_buffer_float');
  let active = enabled && supported, cached = false, resources = null, error = null;
  const size = new THREE.Vector2();
  const radius = THREE.MathUtils.clamp(Math.min(roomSize.x, roomSize.z) * .025, .08, .2);
  const algorithm = N8AOPass ? 'n8ao' : 'gtao';
  const scheduler = new SettledRender({busy, render: () => metrics ? metrics.measure('static-ao', settle) : settle(), onError: fail});

  function allocate() {
    if (resources) return resources;
    const ao = N8AOPass ? new N8AOPass(scene, camera, 1, 1) : new GTAOPass(scene, camera, 1, 1, undefined,
      {radius, thickness: .08, distanceFallOff: 1, scale: 1, samples: 8, screenSpaceRadius: false},
      {samples: 8, rings: 2, radius: 4});
    let normalMaterial = null, aoTarget = null;
    if (N8AOPass) {
      Object.assign(ao.configuration, {aoRadius: radius, distanceFalloff: 1, intensity: 1,
        aoSamples: 8, denoiseSamples: 8, denoiseRadius: 4, denoiseIterations: 1,
        gammaCorrection: false, halfRes: false, accumulate: false, transparencyAware: false, renderMode: 1});
      ao.autoDetectTransparency = false;
      aoTarget = new THREE.WebGLRenderTarget(1, 1, {type: THREE.HalfFloatType, depthBuffer: false});
      normalMaterial = new THREE.MeshNormalMaterial({side: THREE.DoubleSide});
    } else {ao.output = GTAOPass.OUTPUT.Off; ao.normalMaterial.side = THREE.DoubleSide;}
    const beauty = new THREE.WebGLRenderTarget(1, 1, {type: THREE.HalfFloatType, samples: 2});
    const material = new THREE.ShaderMaterial({
      uniforms: {beauty: {value: beauty.texture}, ao: {value: aoTarget?.texture || ao.pdRenderTarget.texture}, strength: {value: .35}, background: {value: new THREE.Color()}},
      depthTest: false, depthWrite: false,
      vertexShader: `varying vec2 vUv;
        void main() {vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0);}`,
      fragmentShader: `uniform sampler2D beauty;
        uniform sampler2D ao;
        uniform float strength;
        uniform vec3 background;
        varying vec2 vUv;
        void main() {
          vec4 color = texture2D(beauty, vUv);
          float occlusion = mix(1.0, clamp(texture2D(ao, vUv).r, 0.0, 1.0), strength);
          // MSAA coverage is premultiplied against a transparent clear colour.
          gl_FragColor = vec4(color.rgb / max(color.a, 0.00001) * occlusion, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          // Three.js clears a Color background without tone mapping. Preserve that behaviour.
          gl_FragColor.rgb = mix(linearToOutputTexel(vec4(background, 1.0)).rgb, gl_FragColor.rgb, color.a);
        }`,
    });
    resources = {ao, aoTarget, normalMaterial, beauty, material, quad: new FullScreenQuad(material), width: 0, height: 0};
    return resources;
  }

  function release() {
    if (!resources) return;
    resources.ao.dispose(); resources.ao.gtaoMaterial?.dispose(); resources.ao.blendMaterial?.dispose();
    // N8AO 1.10.2 inherits the empty Pass.dispose(). Release its owned targets,
    // blue noise and screen triangles here; never traverse the room's shared assets.
    if (N8AOPass) for (const resource of new Set(Object.values(resources.ao))) {
      if (resource?.isWebGLRenderTarget || resource?.isTexture || (resource?.material && typeof resource.dispose === 'function')) resource.dispose();
    }
    resources.aoTarget?.dispose(); resources.normalMaterial?.dispose();
    resources.beauty.dispose(); resources.material.dispose(); resources.quad.dispose();
    resources = null;
  }

  function fail(cause) {
    active = cached = false;
    error = String(cause);
    release();
    console.warn('静态接触暗部已停用，继续使用原有光照。', cause);
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
  }

  function settle() {
    const r = allocate();
    renderer.getDrawingBufferSize(size);
    if (size.x !== r.width || size.y !== r.height) {
      r.width = size.x; r.height = size.y;
      r.beauty.setSize(size.x, size.y);
      // Half the drawing-buffer resolution, capped at 960 pixels on the long edge.
      const scale = Math.min(.5, 960 / Math.max(size.x, size.y));
      r.ao.setSize(Math.max(1, Math.round(size.x * scale)), Math.max(1, Math.round(size.y * scale)));
      r.aoTarget?.setSize(r.ao.width, r.ao.height);
    }
    const target = renderer.getRenderTarget(), background = scene.background, override = scene.overrideMaterial;
    const autoClear = renderer.autoClear, clearColor = renderer.getClearColor(new THREE.Color()), clearAlpha = renderer.getClearAlpha();
    const shadowUpdate = renderer.shadowMap.needsUpdate, shadowAuto = renderer.shadowMap.autoUpdate, xrEnabled = renderer.xr.enabled;
    const hidden = [];
    // UI, transparent previews, glass and contact-only collision meshes must not become opaque AO casters.
    const hide = object => {if (object.visible) {hidden.push(object); object.visible = false;}};
    try {
      for (const child of scene.children) if (child !== room && !child.isLight) hide(child);
      room.traverse(object => {
        if (!object.isMesh) return;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        if (materials.some(m => !m.visible || !m.colorWrite || !m.depthWrite || m.transparent || m.transmission > 0 || m.alphaTest > 0)) hide(object);
      });
      scene.background = null;
      renderer.shadowMap.needsUpdate = renderer.shadowMap.autoUpdate = false;
      if (r.normalMaterial) scene.overrideMaterial = r.normalMaterial;
      r.ao.render(renderer, r.aoTarget);
    } finally {
      // Restore even if a WebGL operation fails; the editor can still render its original view.
      for (const object of hidden) object.visible = true;
      r.ao._restoreVisibility?.();
      scene.background = background; scene.overrideMaterial = override;
      renderer.autoClear = autoClear; renderer.setClearColor(clearColor, clearAlpha);
      renderer.shadowMap.needsUpdate = shadowUpdate; renderer.shadowMap.autoUpdate = shadowAuto;
      renderer.xr.enabled = xrEnabled;
      renderer.setRenderTarget(target);
    }
    try {
      // Offscreen beauty stays linear; apply the existing ACES/exposure/sRGB conversion exactly once below.
      r.material.uniforms.background.value.copy(background?.isColor ? background : clearColor);
      if (background?.isColor || background === null) scene.background = null;
      renderer.setClearColor(0x000000, 0);
      renderer.setRenderTarget(r.beauty);
      renderer.render(scene, camera);
      scene.background = background;
      renderer.setClearColor(clearColor, clearAlpha);
      renderer.setRenderTarget(null);
      r.quad.render(renderer);
      cached = true;
    } finally {
      scene.background = background; renderer.setClearColor(clearColor, clearAlpha);
      renderer.setRenderTarget(target);
    }
  }

  return {
    render() {
      cached = false;
      renderer.render(scene, camera);
      if (active) scheduler.invalidate();
    },
    capture() {
      if (cached) resources.quad.render(renderer);
      else renderer.render(scene, camera);
    },
    pause() {scheduler.pause();},
    resume() {scheduler.resume();},
    dispose() {active = cached = false; scheduler.dispose(); release();},
    snapshot() {
      return {enabled: active, algorithm, state: !enabled ? 'off' : !supported ? 'unsupported' : error ? 'error' : cached ? 'settled' : 'waiting',
        updates: scheduler.updates, delayMs: scheduler.delay, radius, strength: .35,
        aoSize: resources ? [resources.ao.width, resources.ao.height] : null, error};
    },
  };
}
