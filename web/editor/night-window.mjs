// One low-resolution view into the room, shared by panes on its main window wall.
// Reproject against a plane inside the room to retain parallax across adjacent panes.
import {roomMaterial, ownShadows} from './material-layers.mjs';

export function createNightWindow(THREE, {room, scene, window, center, diagonal, revealRoot}) {
  let target, capturedEnvironment, dirty = true, lit = false, captures = 0;
  let modelRoot = room;
  while (modelRoot.parent && modelRoot.parent !== scene) modelRoot = modelRoot.parent;
  const inward = window && new THREE.Vector3(...window.face.n).normalize();
  const camera = new THREE.PerspectiveCamera(95, 2, .06, Math.max(10, 2 * diagonal));
  const projection = new THREE.Matrix4();
  if (window) {
    camera.position.copy(window.position).addScaledVector(inward, .18);
    camera.lookAt(camera.position.clone().add(inward));
    camera.updateMatrixWorld();
    projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  }
  const depth = window ? Math.max(1, center.clone().sub(window.position).dot(inward) * 1.6) : 1;
  const uniforms = {interiorView: {value: null}, interiorProjection: {value: projection},
    interiorNormal: {value: inward}, interiorPlane: {value: window ? inward.dot(window.position) + depth : 0}, roomLit: {value: 0}};

  function capture(renderer) {
    const previous = renderer.getRenderTarget(), face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
    const shadow = renderer.shadowMap, auto = shadow.autoUpdate, refresh = shadow.needsUpdate;
    const xr = renderer.xr.enabled, background = scene.background;
    const hidden = [], shown = [], materials = [];
    try {
      target ??= new THREE.WebGLRenderTarget(512, 256, {
        type: renderer.extensions.has('EXT_color_buffer_float') ? THREE.HalfFloatType : THREE.UnsignedByteType,
      });
      // Exclude editor guides and all reflective panes, including cloned cutaway materials.
      for (const child of scene.children) if (child !== modelRoot && !child.isLight && child.visible) {
        child.visible = false; hidden.push(child);
      }
      for (const root of room.children) if (!root.visible && revealRoot(root)) {
        root.visible = true; shown.push(root);
      }
      room.traverseVisible(mesh => {
        if (!mesh.isMesh) return;
        const material = roomMaterial(mesh), {receiveShadow} = ownShadows(mesh);
        if (material !== mesh.material || receiveShadow !== mesh.receiveShadow) {
          materials.push([mesh, mesh.material, mesh.receiveShadow]);
          mesh.material = material; mesh.receiveShadow = receiveShadow;
        }
        for (const slot of [material].flat()) if (slot.isNightWindow && slot.visible) {
          slot.visible = false; hidden.push(slot);
        }
      });
      // The outer beauty pass has already updated shadows. The view reuses those maps.
      shadow.autoUpdate = shadow.needsUpdate = false;
      renderer.xr.enabled = false;
      scene.background = null;
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      uniforms.interiorView.value = target.texture;
      capturedEnvironment = scene.environment;
      captures++;
      dirty = false;
    } finally {
      for (const [mesh, material, receiveShadow] of materials) {mesh.material = material; mesh.receiveShadow = receiveShadow;}
      for (const object of hidden) object.visible = true;
      for (const object of shown) object.visible = false;
      renderer.setRenderTarget(previous, face, mip);
      renderer.xr.enabled = xr;
      shadow.autoUpdate = auto; shadow.needsUpdate = refresh;
      scene.background = background;
    }
  }

  // Base material cloning keeps the same probe and the normal cutaway opacity behaviour.
  class WindowMaterial extends THREE.MeshBasicMaterial {
    get isNightWindow() {return true;}
    onBeforeRender(renderer, _scene, view, _geometry, mesh) {
      if (!lit || !this.opacity || (!dirty && scene.environment === capturedEnvironment)) return;
      capture(renderer);
      mesh.modelViewMatrix.multiplyMatrices(view.matrixWorldInverse, mesh.matrixWorld);
      mesh.normalMatrix.getNormalMatrix(mesh.modelViewMatrix);
    }
    onBeforeCompile(shader) {
      Object.assign(shader.uniforms, uniforms, {normalReflectance: {value: this.userData.normalReflectance}});
      shader.vertexShader = 'varying vec3 glassPosition, glassNormal;\n' + shader.vertexShader.replace('#include <worldpos_vertex>',
        '#include <worldpos_vertex>\nglassPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;\nglassNormal = inverseTransformDirection(normalMatrix * normal, viewMatrix);');
      shader.fragmentShader = `varying vec3 glassPosition, glassNormal;
        uniform sampler2D interiorView;
        uniform mat4 interiorProjection;
        uniform vec3 interiorNormal;
        uniform float interiorPlane, roomLit, normalReflectance;
        ` + shader.fragmentShader.replace('#include <envmap_fragment>', `
          vec3 incident = isOrthographic ? -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]) : normalize(glassPosition - cameraPosition);
          vec3 paneNormal = normalize(glassNormal);
          vec3 ray = reflect(incident, paneNormal);
          float facing = dot(ray, interiorNormal);
          float distanceToPlane = interiorPlane - dot(glassPosition, interiorNormal);
          vec4 clip = interiorProjection * vec4(glassPosition + ray * (distanceToPlane / max(facing, 0.001)), 1.0);
          vec2 uv = clip.xy / max(clip.w, 0.001) * 0.5 + 0.5;
          vec2 margin = min(uv, 1.0 - uv);
          float coverage = smoothstep(0.0, 0.035, min(margin.x, margin.y)) * step(0.001, facing);
          outgoingLight = texture2D(interiorView, clamp(uv, 0.0, 1.0)).rgb;
          // Schlick Fresnel for the authored glass IOR; preserve the layer's opacity control.
          float fresnel = normalReflectance + (1.0 - normalReflectance) * pow(1.0 - clamp(abs(dot(incident, paneNormal)), 0.0, 1.0), 5.0);
          diffuseColor.a = fresnel * opacity / max(normalReflectance, 0.0001) * coverage * roomLit;
        `);
    }
  }

  return {
    onMainWall(mesh, face) {
      if (!window || !face || new THREE.Vector3(...face.n).normalize().dot(inward) < .995) return false;
      const meshCenter = new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
      return Math.abs(meshCenter.sub(window.position).dot(inward)) <= .6;
    },
    material(source, sky, onMainWall) {
      const ior = source.ior ?? 1.5, normalReflectance = ((ior - 1) / (ior + 1)) ** 2;
      const options = {color: sky, side: source.side, transparent: true, depthWrite: false,
        forceSinglePass: true, opacity: source.opacity * normalReflectance};
      if (!onMainWall) return new THREE.MeshBasicMaterial(options);
      const material = new WindowMaterial(options);
      material.userData.normalReflectance = normalReflectance;
      return material;
    },
    power(on) {if (lit !== on) dirty = true; lit = on; uniforms.roomLit.value = Number(on);},
    invalidate() {dirty = true;},
    snapshot: () => ({captures, size: target ? [target.width, target.height] : null}),
    dispose() {target?.dispose();},
  };
}
