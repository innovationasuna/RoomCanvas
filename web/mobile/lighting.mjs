import {createTimeLighting, timePreset} from '../editor/time-lighting.mjs';
import {lightingProfile} from '../editor/lighting-profiles.mjs';
import {colorGrading} from '../editor/color-grading.mjs';

// The same physical rig as the editor, with bounded mobile shadow buffers.
// Texture pixels, physical light intensities and exposure are unchanged.
export function createMobileLighting(THREE, {renderer, scene, visibility, bounds, floorY}) {
  const {model, walls, config, wallRoots} = visibility;
  const settings = model.userData.roomcanvas?.lighting || {};
  const profile = lightingProfile(settings.profile);
  const preset = settings.preset ? timePreset(settings.preset) : 'physical';
  const center = bounds.getCenter(new THREE.Vector3());
  const ceilingY = walls.length ? Math.max(...walls.map(wall => wall.bounds[1][1])) : bounds.max.y;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = profile.exposure;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  model.traverse(mesh => {
    if (!mesh.isMesh) return;
    if (!mesh.geometry.attributes.normal) mesh.geometry.computeVertexNormals();
    mesh.castShadow = mesh.name !== 'Floor0'; mesh.receiveShadow = true;
  });
  const hemisphere = new THREE.HemisphereLight(0xffffff, 0x87919d, profile.hemisphere);
  const sun = new THREE.DirectionalLight(0xffffff, profile.key);
  const fill = new THREE.DirectionalLight(0xffffff, profile.fill);
  sun.position.set(center.x - 3.5, floorY + 8, center.z + 4);
  sun.target.position.set(center.x, floorY, center.z);
  sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024);
  const span = Math.max(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z) * .9;
  Object.assign(sun.shadow.camera, {left: -span, right: span, top: span, bottom: -span, near: .1, far: 30});
  sun.shadow.bias = -.00025; sun.shadow.normalBias = .012; sun.shadow.radius = 4;
  fill.position.set(-5, 4, -4);
  scene.add(hemisphere, sun, sun.target, fill);
  const rig = createTimeLighting(THREE, {renderer, scene, room: model, config: {...config, luminaires: settings.luminaires}, walls, bounds, floorY, ceilingY,
    revealRoot: visibility.revealRoot, bakedNoonExterior: preset === 'noon' && settings.exterior !== 'authored',
    profile, environment: settings.environment !== false, indoor: settings.indoor});
  const ready = rig.apply(preset, {warm: !!settings.warm});
  for (const light of scene.children) if (light.isLight && light !== sun && light.shadow) light.shadow.mapSize.set(512, 512);

  // A cutaway is only a viewing aid. Hidden opaque walls and attached objects
  // continue to block light. Proxies share geometry and allocate no model textures.
  const proxies = new THREE.Group(); proxies.name = 'mobile-wall-occluders';
  const material = new THREE.MeshBasicMaterial({colorWrite: false, depthWrite: false, side: THREE.DoubleSide});
  const entries = [];
  for (const root of wallRoots) root.traverseVisible(mesh => {
    if (!mesh.isMesh || !mesh.castShadow || [mesh.material].flat().some(m => m.transparent || m.transmission > 0)) return;
    const proxy = new THREE.Mesh(mesh.geometry, material);
    proxy.matrixAutoUpdate = false; proxy.matrix.copy(mesh.matrixWorld); proxy.castShadow = true;
    proxy.visible = false; proxies.add(proxy); entries.push({root, proxy});
  });
  scene.add(proxies);
  return {
    ready,
    settings: {preset, environment: settings.environment !== false, ao: settings.ao !== false, grading: colorGrading(settings.grading)},
    syncOccluders() {
      rig.syncOccluders();
      for (const {root, proxy} of entries) {
        const next = preset !== 'balanced' && !root.visible;
        if (proxy.visible !== next) {proxy.visible = next; renderer.shadowMap.needsUpdate = true;}
      }
    },
    snapshot: () => ({...rig.snapshot(), profile: profile.name, sunMap: sun.shadow.mapSize.toArray(),
      wallOccluders: entries.filter(({proxy}) => proxy.visible).length}),
    dispose() {
      rig.dispose(); proxies.removeFromParent(); material.dispose();
      for (const light of [hemisphere, sun, fill]) {light.removeFromParent(); light.dispose();}
      sun.target.removeFromParent();
    },
  };
}
