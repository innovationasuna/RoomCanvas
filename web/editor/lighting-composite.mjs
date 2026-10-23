import * as THREE from 'three';
import {FullScreenQuad} from 'three/addons/postprocessing/Pass.js';
import {colorGrading, whiteBalanceGains} from './color-grading.mjs';

// Moving and settled frames must blend transparency in the same colour space.
// AO changes only the multiplier; the beauty target, MSAA and output conversion stay identical.
export function createLightingComposite(renderer) {
  const gl = renderer.getContext();
  const samples = Math.min(gl.getParameter(gl.SAMPLES), renderer.capabilities.maxSamples);
  const beauty = new THREE.WebGLRenderTarget(1, 1, {type: THREE.HalfFloatType, samples});
  const material = new THREE.ShaderMaterial({
    uniforms: {beauty: {value: beauty.texture}, ao: {value: beauty.texture}, strength: {value: 0}, background: {value: new THREE.Color()},
      gradeExposure: {value: 1}, whiteBalance: {value: new THREE.Vector3(1, 1, 1)}, contrast: {value: 1}, saturation: {value: 1}},
    depthTest: false, depthWrite: false,
    vertexShader: `varying vec2 vUv;
      void main() {vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0);}`,
    fragmentShader: `uniform sampler2D beauty;
      uniform sampler2D ao;
      uniform float strength;
      uniform vec3 background;
      uniform float gradeExposure;
      uniform vec3 whiteBalance;
      uniform float contrast;
      uniform float saturation;
      varying vec2 vUv;
      void main() {
        vec4 color = texture2D(beauty, vUv);
        float occlusion = strength > 0.0 ? mix(1.0, clamp(texture2D(ao, vUv).r, 0.0, 1.0), strength) : 1.0;
        // MSAA coverage is premultiplied against a transparent clear colour.
        gl_FragColor = vec4(color.rgb / max(color.a, 0.00001) * occlusion, 1.0);
        gl_FragColor.rgb *= gradeExposure * whiteBalance;
        #include <tonemapping_fragment>
        if (saturation != 1.0) {
          float luminance = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
          gl_FragColor.rgb = max(vec3(0.0), mix(vec3(luminance), gl_FragColor.rgb, saturation));
        }
        #include <colorspace_fragment>
        if (contrast != 1.0) gl_FragColor.rgb = clamp((gl_FragColor.rgb - 0.5) * contrast + 0.5, 0.0, 1.0);
        // Keep the editor's un-tonemapped Color background.
        gl_FragColor.rgb = mix(linearToOutputTexel(vec4(background, 1.0)).rgb, gl_FragColor.rgb, color.a);
      }`,
  });
  const quad = new FullScreenQuad(material), size = new THREE.Vector2();
  let width = 0, height = 0;
  function present() {
    const target = renderer.getRenderTarget();
    try {renderer.setRenderTarget(null); quad.render(renderer);}
    finally {renderer.setRenderTarget(target);}
  }
  return {
    setGrading(value) {
      const grade = colorGrading(value);
      material.uniforms.gradeExposure.value = 2 ** grade.exposure;
      material.uniforms.whiteBalance.value.fromArray(whiteBalanceGains(grade.whiteBalance));
      material.uniforms.contrast.value = grade.contrast;
      material.uniforms.saturation.value = grade.saturation;
    },
    render(scene, camera, {ao = null, strength = .35} = {}) {
      renderer.getDrawingBufferSize(size);
      if (size.x !== width || size.y !== height) {
        width = size.x; height = size.y; beauty.setSize(width, height);
      }
      const target = renderer.getRenderTarget(), background = scene.background;
      const clearColor = renderer.getClearColor(new THREE.Color()), clearAlpha = renderer.getClearAlpha();
      try {
        material.uniforms.background.value.copy(background?.isColor ? background : clearColor);
        material.uniforms.ao.value = ao || beauty.texture;
        material.uniforms.strength.value = ao ? strength : 0;
        if (background?.isColor || background === null) scene.background = null;
        renderer.setClearColor(0x000000, 0);
        renderer.setRenderTarget(beauty);
        renderer.render(scene, camera);
        scene.background = background; renderer.setClearColor(clearColor, clearAlpha);
        present();
      } finally {
        scene.background = background; renderer.setClearColor(clearColor, clearAlpha);
        renderer.setRenderTarget(target);
      }
    },
    present,
    snapshot: () => ({size: [width, height], samples}),
    dispose() {beauty.dispose(); material.dispose(); quad.dispose();},
  };
}
