import {shadowSettings} from './lighting-settings.mjs';
import {indoorLighting} from './indoor-lighting.mjs';
import {hasLayer, ownMaterial, ownShadows, setOwnMaterial} from './material-layers.mjs';
import {createPhysicalLighting} from './physical-lighting.mjs';
import {areaFactor, findLuminaires, floorArea, glowing, LUMINAIRE_LIGHTS, planLuminaireLights, spotShadowBias} from './room-luminaires.mjs';

// Relative to the principal window, not geographic north or clock time.
// Day presets keep a real fill (sky .4-.5, environment .2-.25, ceiling lights at 25 %): with only the sun and
// window light, floors and walls away from the windows came out about 40 % darker than 普通光照.
export const TIME_PRESETS = Object.freeze({
  balanced: Object.freeze({label: '普通光照', indoor: .07}),
  morning: Object.freeze({label: '早晨', azimuth: -.7, elevation: .42, key: 3.1, fill: 0, window: .65, indoor: .25, exterior: .65, hemisphere: .45, environment: .22, color: 0xffe1b5, sky: 0xdce9ff, background: '#ece3d3'}),
  noon: Object.freeze({label: '中午', azimuth: 0, elevation: 1.05, key: 4.2, fill: 0, window: .95, indoor: .25, exterior: .95, hemisphere: .5, environment: .25, color: 0xfff4e1, sky: 0xe6efff, background: '#f0e8d8'}),
  afternoon: Object.freeze({label: '下午', azimuth: .7, elevation: .32, key: 2.9, fill: 0, window: .48, indoor: .25, exterior: .5, hemisphere: .4, environment: .2, color: 0xffc895, sky: 0xdce7ff, background: '#eae5dd'}),
  // Same recipe as the Android walkthrough; see physical-lighting.mjs. Window photos at face value.
  physical: Object.freeze({label: '物理光照', indoor: 0, exterior: 1, background: '#f0e8d8'}),
  night: Object.freeze({label: '夜间', key: 0, fill: 0, window: 0, indoor: 1, exterior: .025, hemisphere: .07, environment: .018, color: 0xffdcb4, sky: 0xb7c9e9, background: '#252b34'}),
});
export const timePreset = value => Object.hasOwn(TIME_PRESETS, value) ? value : 'noon';

// Day: window/sun dominate with a weak ceiling light. Night: the ceiling light dominates.
// The indoor light comes from the room's ceiling luminaires (config.luminaires, room-luminaires.mjs);
// a room without any keeps one invented lamp at the top centre. Positions, cone angle and power are
// independent of the time preset. Window skylight is a finite local approximation, not GI.
// Shadow maps update on demand.
export function createTimeLighting(THREE, {renderer, scene, room, config, walls, bounds, floorY, ceilingY, profile, fitShadows = true, environment = true, indoor}) {
  const hemisphere = scene.children.find(light => light.isHemisphereLight);
  const [sun, fill] = scene.children.filter(light => light.isDirectionalLight);
  const center = bounds.getCenter(new THREE.Vector3()), size = bounds.getSize(new THREE.Vector3());
  const original = {position: sun.position.clone(), target: sun.target.position.clone(), background: scene.background.clone(),
    shadow: Object.fromEntries(['left', 'right', 'top', 'bottom', 'near', 'far'].map(key => [key, sun.shadow.camera[key]])),
    bias: sun.shadow.bias, normalBias: sun.shadow.normalBias};
  const previewLights = [hemisphere, sun, fill].map(light => light.clone());
  const named = new Map(); room.traverse(object => named.set(object.userData.name || object.name, object));
  const windows = Object.entries(config.openings).flatMap(([wall, names]) => names.filter(name => config.label(name) === '窗户').map(name => {
    const object = named.get(name), face = walls.find(item => item.name === wall);
    if (!object || !face) return null;
    const box = new THREE.Box3().setFromObject(object), dimensions = box.getSize(new THREE.Vector3());
    return {name, face, position: box.getCenter(new THREE.Vector3()), area: dimensions.y * Math.max(dimensions.x, dimensions.z)};
  })).filter(Boolean).sort((a, b) => b.area - a.area);
  const outward = windows.length ? new THREE.Vector3(-windows[0].face.n[0], 0, -windows[0].face.n[2]).normalize() : new THREE.Vector3(-3.5, 0, 4).normalize();
  const height = Math.max(.8, ceilingY - floorY), diagonal = Math.hypot(size.x, size.z);
  // Use the initial room AABB, independent of authored light fixtures or furniture moves.
  // Its X/Z centre places the light centrally in rooms of any size or world offset.
  const lampPosition = new THREE.Vector3(center.x, Math.min(bounds.max.y, ceilingY) - Math.min(.2, height * .06), center.z);
  // The time presets' lamp power: the central lamp's height term and level; with luminaires, times the floor
  // area factor and divided among their spots by `share` (so one lamp in a 20 m² room is as bright as before).
  const luminaires = findLuminaires(room, config.luminaires), plan = planLuminaireLights(luminaires);
  const floor = floorArea(walls, size.x * size.z), lampPower = Math.max(4, (lampPosition.y - floorY) ** 2 * 4.5) * (plan.length ? areaFactor(floor) : 1);
  const lampSpecs = plan.length ? plan.map(light => ({...light, source: 'luminaire'}))
    : [{position: lampPosition.toArray(), share: 1, castShadow: true, source: 'fallback'}];
  let selected = 'balanced', spots = [], marker = null, windowLight = null, warm = false;
  let lamps = indoorLighting(indoor);
  const physical = createPhysicalLighting(THREE, {scene, room, config, bounds, toneExposure: renderer.toneMappingExposure ?? profile.exposure ?? 1,
    walls, ceilingY, floorY, own: ownMaterial, setOwn: setOwnMaterial, luminaires: plan, angle: lamps.angle});
  const glassCasters = new Map();
  // Captured window glass/exterior photos can contain authored daylight emission.
  // Give these meshes owned materials, so night can dim it without touching shared assets
  // (or dimming monitor screens). See-through copies are synchronized below as well.
  const exterior = [];
  for (const [name, object] of named) if (['窗户', '窗外景'].includes(config.label(name))) object.traverse(mesh => {
    if (!mesh.isMesh || exterior.some(entry => entry.mesh === mesh)) return;
    const source = [mesh.material].flat();
    if (!source.some(material => (material.emissive && material.emissive.r + material.emissive.g + material.emissive.b > 0) || material.isMeshBasicMaterial)) return;
    const copies = source.map(material => material.clone());
    exterior.push({mesh, source: mesh.material, copies, bases: source.map(material => ({emission: material.emissiveIntensity, color: material.color?.clone(), unlit: !!material.isMeshBasicMaterial}))});
    setOwnMaterial(mesh, Array.isArray(mesh.material) ? copies : copies[0]);
  });
  // The luminaires' own glow follows the light switch, on owned copies as above.
  const glow = [];
  for (const {object} of luminaires) object.traverse(mesh => {
    if (!mesh.isMesh || !glowing(mesh) || glow.some(entry => entry.mesh === mesh)) return;
    const source = mesh.material, copies = [source].flat().map(material => material.clone());
    glow.push({mesh, source, copies, bases: [source].flat().map(material => material.emissiveIntensity)});
    setOwnMaterial(mesh, Array.isArray(source) ? copies : copies[0]);
  });

  // A hidden ceiling still blocks sunlight. These tiny shared-geometry proxies draw no
  // colour/depth, never enter collision/picking/AO, and only duplicate the ceiling shell.
  const roof = new THREE.Group(), roofMaterial = new THREE.MeshBasicMaterial({colorWrite: false, depthWrite: false, side: THREE.DoubleSide});
  roof.name = 'lighting-roof-occluders'; scene.add(roof);
  const roofs = [];
  for (const object of room.children) if (config.label(object.userData.name || object.name) === '天花板') object.traverse(mesh => {
    if (!mesh.isMesh) return;
    const proxy = new THREE.Mesh(mesh.geometry, roofMaterial); proxy.matrixAutoUpdate = false; proxy.matrix.copy(mesh.matrixWorld); proxy.castShadow = true;
    roof.add(proxy); roofs.push({object, proxy});
  });

  function fitSun() {
    if (!fitShadows) return;
    sun.updateWorldMatrix(true, false); sun.target.updateWorldMatrix(true, false); sun.shadow.updateMatrices(sun);
    const corners = [0, 1].flatMap(x => [0, 1].flatMap(y => [0, 1].map(z => new THREE.Vector3(
      x ? bounds.max.x : bounds.min.x, y ? bounds.max.y : bounds.min.y, z ? bounds.max.z : bounds.min.z,
    ).applyMatrix4(sun.shadow.camera.matrixWorldInverse).toArray())));
    const fitted = shadowSettings(corners, sun.shadow.mapSize.x);
    if (fitted) {Object.assign(sun.shadow.camera, fitted.camera); sun.shadow.bias = fitted.bias; sun.shadow.normalBias = fitted.normalBias;}
    sun.shadow.camera.updateProjectionMatrix();
  }
  function ceilingLights() {
    if (spots.length) return;
    for (const spec of lampSpecs) {
      const spot = new THREE.SpotLight(TIME_PRESETS.night.color, 1, 0, THREE.MathUtils.degToRad(lamps.angle / 2), .3, 2);
      spot.position.fromArray(spec.position); spot.target.position.set(spec.position[0], floorY, spec.position[2]);
      spot.name = spec.source === 'luminaire' ? 'luminaire-lamp' : 'ceiling-lamp'; spot.userData.lightingRole = 'indoor';
      const map = spec.source === 'luminaire' ? LUMINAIRE_LIGHTS.shadowMap : 2048;
      spot.shadow.mapSize.set(map, map); spot.shadow.camera.near = Math.min(.2, height * .06);
      spot.shadow.camera.far = Math.max(5, height + diagonal);
      scene.add(spot, spot.target); spots.push({spot, spec});
    }
    // Real luminaires are seen as themselves; only the invented lamp gets a glowing marker.
    if (plan.length) return;
    marker = new THREE.Mesh(new THREE.SphereGeometry(.06, 16, 8), new THREE.MeshBasicMaterial({color: TIME_PRESETS.night.color, toneMapped: false}));
    marker.position.copy(lampPosition); scene.add(marker);
  }
  function skylight() {
    if (windowLight || !windows.length) return;
    const window = windows[0], inward = new THREE.Vector3(...window.face.n).normalize();
    windowLight = new THREE.SpotLight(0xffffff, 1, 0, Math.PI * .39, .75, 2);
    windowLight.name = 'window-skylight'; windowLight.userData.lightingRole = 'outdoor-window';
    windowLight.position.copy(window.position).addScaledVector(inward, .1);
    windowLight.target.position.set(center.x, floorY + height * .25, center.z);
    windowLight.shadow.mapSize.set(1024, 1024); windowLight.shadow.camera.near = .12;
    windowLight.shadow.camera.far = Math.max(3, Math.hypot(height, diagonal));
    windowLight.shadow.bias = -.0003; windowLight.shadow.normalBias = .025;
    scene.add(windowLight, windowLight.target);
  }
  function updateIndoor() {
    const level = TIME_PRESETS[selected].indoor;
    // In 物理光照 the power switch drives the physical lamps (luminaires or under each ceiling) instead.
    const ceilingOn = lamps.power && selected !== 'physical';
    physical.setIndoor(lamps);
    if (ceilingOn) ceilingLights();
    for (const {spot, spec} of spots) {
      spot.angle = THREE.MathUtils.degToRad(lamps.angle / 2);
      spot.shadow.camera.fov = lamps.angle; spot.shadow.camera.updateProjectionMatrix();
      Object.assign(spot.shadow, spotShadowBias(spec.position[1] - floorY, spot.angle, spot.shadow.mapSize.x));
      spot.visible = ceilingOn; spot.castShadow = ceilingOn && selected === 'night' && spec.castShadow;
      spot.intensity = ceilingOn ? lampPower * level * spec.share : 0;
    }
    if (marker) {marker.visible = ceilingOn; marker.material.color.set(TIME_PRESETS.night.color).multiplyScalar(level);}
    // Fixtures glow as authored while the lights are on, in every preset, and not at all when they are off.
    // Whatever material a mesh shows as its own now (物理光照's sky-light copy over these copies) follows.
    const glowScale = lamps.power ? 1 : 0;
    for (const {mesh, copies, bases} of glow) for (const materials of [copies, [ownMaterial(mesh)].flat()]) {
      materials.forEach((material, index) => {if (bases[index] !== undefined) material.emissiveIntensity = bases[index] * glowScale;});
    }
  }
  function setIndoor(value) {
    lamps = indoorLighting(value); updateIndoor();
    // Daytime window/sun shadows are unaffected by the unshadowed indoor fill.
    if (['night', 'physical'].includes(selected)) renderer.shadowMap.needsUpdate = true;
  }
  function syncOccluders() {
    const physical = selected !== 'balanced';
    for (const {object, proxy} of roofs) proxy.visible = physical && !object.visible;
    const emissionScale = TIME_PRESETS[selected].exterior ?? 1;
    for (const {mesh, copies, bases} of exterior) {
      // The copies and, over them, whatever a layer shows right now (a see-through clone).
      for (const materials of [copies, [mesh.material].flat()]) materials.forEach((material, index) => {
        const base = bases[index];
        if (base.emission !== undefined) material.emissiveIntensity = base.emission * emissionScale;
        if (base.unlit && base.color) material.color.copy(base.color).multiplyScalar(emissionScale);
      });
    }
    room.traverse(mesh => {
      if (!mesh.isMesh) return;
      // A see-through near wall still stops the sun when the lights are physical.
      const faint = hasLayer(mesh, 'seeThrough');
      const opaque = [ownMaterial(mesh)].flat().every(material => !material.transparent && !(material.transmission > 0));
      if (faint) mesh.castShadow = physical && opaque && ownShadows(mesh).castShadow;
      else if (!opaque) {
        if (!glassCasters.has(mesh)) glassCasters.set(mesh, mesh.castShadow);
        mesh.castShadow = physical ? false : glassCasters.get(mesh);
      }
    });
  }
  function apply(value, {warm: warmValue = false} = {}) {
    selected = timePreset(value); warm = warmValue;
    const preset = TIME_PRESETS[selected], base = selected === 'balanced', physicalMode = selected === 'physical';
    if (physicalMode) physical.activate(); else physical.deactivate();
    if (!base && selected !== 'night' && !physicalMode) skylight();
    const daylight = selected !== 'night' && !(physicalMode && physical.usesModelLights);
    sun.visible = sun.castShadow = daylight; fill.visible = base;
    updateIndoor();
    if (windowLight) {
      windowLight.visible = windowLight.castShadow = !base && selected !== 'night' && !physicalMode;
      windowLight.intensity = windowLight.position.distanceToSquared(windowLight.target.position) * (preset.window || 0);
      windowLight.color.set(preset.sky || 0xffffff);
    }
    hemisphere.visible = !physicalMode;
    hemisphere.intensity = base ? profile.hemisphere : preset.hemisphere ?? 0;
    hemisphere.color.set(base ? 0xffffff : preset.sky ?? 0xffffff); hemisphere.groundColor.set(0x87919d);
    sun.intensity = base ? profile.key : physicalMode ? physical.sun.intensity : preset.key; fill.intensity = base ? profile.fill : preset.fill ?? 0;
    if (physicalMode) sun.color.setRGB(...physical.sun.color, THREE.LinearSRGBColorSpace);
    else sun.color.set(base ? warm ? 0xffd2a5 : 0xffffff : preset.color);
    fill.color.set(base ? warm ? 0xffd2a5 : 0xffffff : preset.sky ?? 0xffffff);
    scene.environmentIntensity = environment ? base ? profile.environment : physicalMode ? physical.environmentIntensity : preset.environment : 0;
    scene.background.set(base ? original.background : preset.background);
    if (base) {
      sun.position.copy(original.position); sun.target.position.copy(original.target);
      Object.assign(sun.shadow.camera, original.shadow); sun.shadow.bias = original.bias; sun.shadow.normalBias = original.normalBias;
      sun.shadow.camera.updateProjectionMatrix();
    } else if (physicalMode) {
      // A fixed sun (elevation 40°, rotation 35°), as on the phone, not tied to the window.
      const target = new THREE.Vector3(center.x, floorY + height * .4, center.z);
      sun.target.position.copy(target);
      sun.position.copy(target).addScaledVector(new THREE.Vector3(...physical.sun.direction), -Math.max(12, diagonal * 2)); fitSun();
    } else if (selected !== 'night') {
      const direction = outward.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), preset.azimuth);
      direction.multiplyScalar(Math.cos(preset.elevation)); direction.y = Math.sin(preset.elevation);
      const target = new THREE.Vector3(center.x, floorY + height * .4, center.z);
      sun.target.position.copy(target); sun.position.copy(target).addScaledVector(direction, Math.max(12, diagonal * 2)); fitSun();
    }
    syncOccluders(); renderer.shadowMap.needsUpdate = true;
  }
  // The first indoor spot, as the central lamp was reported; the snapshot's `lights` lists them all.
  function lampState() {
    const spot = spots[0]?.spot;
    return spot ? {position: spot.position.toArray(), target: spot.target.position.toArray(), source: plan.length ? 'luminaire' : 'room-bounds-center',
      roomBounds: {min: bounds.min.toArray(), max: bounds.max.toArray()}, angle: THREE.MathUtils.radToDeg(spot.angle * 2),
      shadowFov: spot.shadow.camera.fov, shadowBias: spot.shadow.bias, normalBias: spot.shadow.normalBias,
      intensity: spot.intensity, level: TIME_PRESETS[selected].indoor || 0, decay: spot.decay, visible: spot.visible} : null;
  }
  return {
    apply, syncOccluders, setIndoor,
    // How many ceiling luminaires light the room (0: the central lamp).
    fixtures: luminaires.length,
    previewLights: () => previewLights.map(light => light.clone()),
    snapshot: () => ({preset: selected, physical: physical.snapshot(), window: windows[0]?.name || null, directionBasis: windows.length ? 'principal-window' : 'room-axes',
      indoor: {...lamps}, environmentIntensity: scene.environmentIntensity, exteriorEmissionScale: TIME_PRESETS[selected].exterior ?? 1,
      shadowLight: selected === 'night' ? spots[0]?.spot.visible ? 'SpotLight' : null : 'DirectionalLight',
      windowLight: windowLight ? {position: windowLight.position.toArray(), intensity: windowLight.intensity, visible: windowLight.visible, castShadow: windowLight.castShadow, mapSize: windowLight.shadow.mapSize.toArray()} : null,
      lamp: lampState(),
      floorArea: floor,
      luminaires: luminaires.map(({name, center, axis, length, width, area}) => ({name, center, axis, length, width, area})),
      lights: lampSpecs.map((spec, index) => {
        const spot = spots[index]?.spot;
        return {source: spec.source, luminaire: spec.luminaire ?? null, folded: spec.folded ?? [], position: spec.position, share: spec.share,
          intensity: spot?.intensity ?? 0, visible: spot?.visible ?? false, castShadow: spot?.castShadow ?? false, shadowCandidate: spec.castShadow};
      })}),
    dispose() {
      physical.dispose();
      for (const {mesh, source, copies} of exterior) {
        setOwnMaterial(mesh, source);
        copies.forEach(material => material.dispose());
      }
      roof.removeFromParent(); roofMaterial.dispose();
      for (const {mesh, source, copies} of glow) {
        setOwnMaterial(mesh, source);
        copies.forEach(material => material.dispose());
      }
      for (const {spot} of spots) {spot.removeFromParent(); spot.target.removeFromParent(); spot.dispose();}
      if (marker) {marker.removeFromParent(); marker.geometry.dispose(); marker.material.dispose();}
      if (windowLight) {windowLight.removeFromParent(); windowLight.target.removeFromParent(); windowLight.dispose();}
    },
  };
}
