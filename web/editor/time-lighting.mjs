import {createNightWindow} from './night-window.mjs';
import {shadowSettings} from './lighting-settings.mjs';
import {indoorLighting} from './indoor-lighting.mjs';
import {hasLayer, ownMaterial, ownShadows, setLayer, setOwnMaterial} from './material-layers.mjs';
import {createPhysicalLighting} from './physical-lighting.mjs';
import {areaFactor, findLuminaires, floorArea, glowing, LUMINAIRE_LIGHTS, planLuminaireLights, spotShadowBias} from './room-luminaires.mjs';

// Relative to the principal window, not geographic north or clock time.
// Day presets keep a real fill (sky .4-.5, environment .2-.25, ceiling lights at 25 %): with only the sun and
// window light, floors and walls away from the windows came out about 40 % darker than 普通光照.
export const TIME_PRESETS = Object.freeze({
  balanced: Object.freeze({label: '普通光照', indoor: .07}),
  morning: Object.freeze({label: '早晨', azimuth: -.68, elevation: .38, key: 3.8, fill: 0, window: .78, indoor: .25, exterior: 1.22, exteriorTint: 0xe4f1ff, exposureScale: .94, hemisphere: .48, environment: .22, color: 0xffdc9c, sky: 0xb7d5ff, background: '#d6e1ea'}),
  noon: Object.freeze({label: '中午', azimuth: 0, elevation: 1.05, key: 4.2, fill: 0, window: .95, indoor: .25, exterior: .95, hemisphere: .5, environment: .25, color: 0xfff4e1, sky: 0xe6efff, background: '#f0e8d8'}),
  afternoon: Object.freeze({label: '下午', azimuth: .87, elevation: .27, key: 3.5, fill: 0, window: .53, indoor: .25, exterior: .81, exteriorTint: 0xffe4c4, exposureScale: .90, hemisphere: .42, environment: .20, color: 0xffb36b, sky: 0xffdfb8, background: '#e5ccae'}),
  // Same recipe as the Android walkthrough; see physical-lighting.mjs. Window photos at face value.
  physical: Object.freeze({label: '物理光照', indoor: 0, exterior: 1, background: '#f0e8d8'}),
  night: Object.freeze({label: '夜间', key: 0, fill: 0, window: 0, indoor: 1, exterior: 0, nightSky: 0x152339, hemisphere: 1.05, environment: .08, color: 0xfff2e0, sky: 0xfff5eb, ground: 0xfff0e1, background: '#111c2c'}),
});
export const timePreset = value => Object.hasOwn(TIME_PRESETS, value) ? value : 'noon';

const ltcUsers = new WeakMap();
const DAY_LAMP_COLOR = 0xffdcb4;

// Day: window/sun dominate with a weak ceiling light. Night: the ceiling light dominates.
// The indoor light comes from the room's ceiling luminaires (config.luminaires, room-luminaires.mjs);
// a room without any keeps one invented lamp at the top centre. Night uses the emitting rectangles
// and a small shadowed fraction of one fixture. Window skylight is a finite local approximation.
// Shadow maps update on demand.
export function createTimeLighting(THREE, {renderer, scene, room, config, walls, bounds, floorY, ceilingY, profile, fitShadows = true, environment = true, indoor,
  revealRoot = root => config.isCeiling(root.userData.name || root.name), bakedNoonExterior = false}) {
  const hemisphere = scene.children.find(light => light.isHemisphereLight);
  const [sun, fill] = scene.children.filter(light => light.isDirectionalLight);
  const center = bounds.getCenter(new THREE.Vector3()), size = bounds.getSize(new THREE.Vector3());
  const original = {position: sun.position.clone(), target: sun.target.position.clone(), background: scene.background.clone(),
    shadow: Object.fromEntries(['left', 'right', 'top', 'bottom', 'near', 'far'].map(key => [key, sun.shadow.camera[key]])),
    bias: sun.shadow.bias, normalBias: sun.shadow.normalBias};
  const baseExposure = renderer.toneMappingExposure ?? profile.exposure ?? 1;
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
  const lampSpecs = plan.length ? plan.map(light => ({...light, source: 'luminaire', castShadow: light.shadowRank === 0}))
    : [{position: lampPosition.toArray(), share: 1, castShadow: true, source: 'fallback'}];
  let selected = 'balanced', spots = [], marker = null, windowLight = null, warm = false;
  const areas = planLuminaireLights(luminaires, {perLuminaire: 1}).map(spec => ({
    spec, fixture: luminaires.find(item => item.name === spec.luminaire), light: null,
  }));
  const shadowSpec = lampSpecs.find(spec => spec.castShadow);
  const shadowArea = areas.find(({spec}) => spec.luminaire === shadowSpec.luminaire);
  const shadowShare = shadowArea ? shadowArea.spec.share * LUMINAIRE_LIGHTS.shadowFraction : 1;
  const modelLights = [];
  room.traverse(object => {if (object.isLight) modelLights.push(object);});
  const nightHidden = new Set();
  function restoreModelLights() {
    for (const light of nightHidden) light.visible = true;
    nightHidden.clear();
  }
  let lamps = indoorLighting(indoor);
  const physical = createPhysicalLighting(THREE, {scene, room, config, bounds, toneExposure: baseExposure,
    walls, ceilingY, floorY, own: ownMaterial, setOwn: setOwnMaterial, luminaires: plan, angle: lamps.angle});
  const glassCasters = new Map();
  const nightWindow = createNightWindow(THREE, {scene, room, window: windows[0], center, diagonal, revealRoot});
  const exterior = [], daylightCards = new Set();
  const emits = material => material.emissive && material.emissive.r + material.emissive.g + material.emissive.b > 0;
  const windowFaces = new Map(windows.map(({name, face}) => [named.get(name), face]));
  function collectExterior(object, kind, face) {
    const label = config.label(object.userData.name || object.name);
    if (label === '窗户') face = windowFaces.get(object) ?? face;
    kind = label || kind;
    if (object.isMesh && (kind === '窗户' || kind === '窗外景')) {
      const source = ownMaterial(object), slots = [source].flat(), backdrop = kind === '窗外景';
      const photo = material => !(material.transmission > 0) && (backdrop
        ? material.map || material.emissiveMap || material.isMeshBasicMaterial || emits(material)
        : !material.transparent && (material.emissiveMap || (material.map && (material.isMeshBasicMaterial || emits(material)))));
      // Backing boards behind a photo must also let low sunlight through the opening.
      if (backdrop || slots.every(photo)) daylightCards.add(object);
      const scalesAtNoon = slots.some(material => emits(material) || material.isMeshBasicMaterial);
      const daylight = backdrop || scalesAtNoon || slots.some(photo);
      const glazed = slots.some(material => material.transmission > 0);
      if (daylight || glazed) {
        // Wall membership is measured before a hinged sash moves away from its frame.
        const onMainWall = glazed && nightWindow.onMainWall(object, face);
        exterior.push({mesh: object, photo, daylight, onMainWall, scalesAtNoon});
      }
    }
    for (const child of object.children) collectExterior(child, kind, face);
  }
  collectExterior(room, null);

  function applyExterior(preset) {
    const tint = preset.exteriorTint && new THREE.Color(preset.exteriorTint);
    for (const {mesh, photo, daylight, onMainWall, scalesAtNoon} of exterior) {
      const noon = preset === TIME_PRESETS.noon && scalesAtNoon && !bakedNoonExterior;
      // A display layer keeps the photo in mobile exports and stays underneath cutaway/selection.
      const layer = {
        castShadow: tint && daylightCards.has(mesh) ? false : undefined,
        material(material) {
          if (preset.nightSky && photo(material)) {
            // The photo and its pale backing can round to the same depth from across the room.
            return new THREE.MeshBasicMaterial({color: preset.nightSky, side: material.side,
              polygonOffset: true, polygonOffsetUnits: -2});
          }
          if (preset.nightSky && material.transmission > 0) {
            return nightWindow.material(material, preset.nightSky, onMainWall);
          }
          const copy = material.clone();
          if (photo(material) && tint) {
            copy.color.multiply(tint).multiplyScalar(preset.exterior);
            copy.emissive?.multiply(tint);
          }
          if (noon && copy.isMeshBasicMaterial) copy.color.multiplyScalar(preset.exterior);
          if (copy.emissive) copy.emissiveIntensity *= preset.exterior;
          return copy;
        },
      };
      setLayer(mesh, 'timeExterior', noon || (tint && daylight) || preset.nightSky ? layer : null);
    }
  }
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
      const spot = new THREE.SpotLight(DAY_LAMP_COLOR, 1, 0, THREE.MathUtils.degToRad(lamps.angle / 2), .3, 2);
      spot.position.fromArray(spec.position); spot.target.position.set(spec.position[0], floorY, spec.position[2]);
      spot.name = spec.source === 'luminaire' ? 'luminaire-lamp' : 'ceiling-lamp'; spot.userData.lightingRole = 'indoor';
      const map = spec.source === 'luminaire' ? LUMINAIRE_LIGHTS.shadowMap : 2048;
      spot.shadow.mapSize.set(map, map); spot.shadow.camera.near = Math.min(.2, height * .06);
      spot.shadow.camera.far = Math.max(5, height + diagonal);
      scene.add(spot, spot.target); spots.push({spot, spec});
    }
    // Real luminaires are seen as themselves; only the invented lamp gets a glowing marker.
    if (plan.length) return;
    marker = new THREE.Mesh(new THREE.SphereGeometry(.06, 16, 8), new THREE.MeshBasicMaterial({color: DAY_LAMP_COLOR, toneMapped: false}));
    marker.position.copy(lampPosition); scene.add(marker);
  }
  let loadingAreas, disposed = false;
  function nightAreaLights() {
    if (!areas.length || areas[0].light) return;
    loadingAreas ??= import('../vendor/examples/jsm/lights/RectAreaLightUniformsLib.js').then(({RectAreaLightUniformsLib}) => {
      if (disposed || selected !== 'night' || !lamps.power) return;
      const uniforms = THREE.UniformsLib;
      if (!uniforms.LTC_FLOAT_1) RectAreaLightUniformsLib.init(uniforms);
      ltcUsers.set(uniforms, (ltcUsers.get(uniforms) ?? 0) + 1);
      createAreas();
      nightWindow.invalidate();
    }).finally(() => {loadingAreas = null;});
    return loadingAreas;
  }
  function createAreas() {
    for (const entry of areas) {
      const {spec, fixture} = entry;
      const {axis: [x, z], center, length, width, area} = fixture;
      const share = spec.share - (entry === shadowArea ? shadowShare : 0);
      // Normal luminous intensity = luminance × emitting area for a Lambertian rectangle.
      const light = new THREE.RectAreaLight(TIME_PRESETS.night.color, lampPower * share / area, length, width);
      light.name = fixture.name + '-area'; light.userData.lightingRole = 'indoor-area';
      light.position.fromArray(center);
      // Local X follows the diffuser's long edge, local -Z emits towards the floor.
      light.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(
        new THREE.Vector3(x, 0, z), new THREE.Vector3(z, 0, -x), new THREE.Vector3(0, 1, 0)));
      scene.add(light); entry.light = light;
    }
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
    nightWindow.power(lamps.power && selected === 'night');
    physical.setIndoor(lamps);
    if (ceilingOn) ceilingLights();
    const night = selected === 'night';
    const pending = night && ceilingOn ? nightAreaLights() : undefined;
    for (const {light} of areas) if (light) light.visible = night && ceilingOn;
    // The shadow map belongs to a weak direct component on the fixture itself. The area
    // source yields the rest of its direct illumination; it cannot cast a Three.js shadow.
    for (const {spot, spec} of spots) {
      const shadow = night && spec.castShadow;
      spot.visible = ceilingOn && (!night || shadow);
      spot.castShadow = spot.visible && shadow;
      spot.color.set(night ? TIME_PRESETS.night.color : DAY_LAMP_COLOR);
      spot.position.fromArray(shadow && shadowArea ? shadowArea.spec.position : spec.position);
      spot.target.position.set(spot.position.x, floorY, spot.position.z);
      spot.angle = THREE.MathUtils.degToRad(lamps.angle / 2);
      spot.shadow.camera.fov = lamps.angle; spot.shadow.camera.updateProjectionMatrix();
      Object.assign(spot.shadow, spotShadowBias(spot.position.y - floorY, spot.angle, spot.shadow.mapSize.x));
      const share = shadow ? shadowShare : spec.share;
      spot.intensity = spot.visible ? lampPower * level * share : 0;
    }
    if (night) {
      const preset = TIME_PRESETS.night;
      hemisphere.intensity = ceilingOn ? preset.hemisphere : 0;
      scene.environmentIntensity = ceilingOn && environment ? preset.environment : 0;
    }
    if (marker) {marker.visible = ceilingOn; marker.material.color.set(night ? TIME_PRESETS.night.color : DAY_LAMP_COLOR).multiplyScalar(level);}
    // Fixtures glow as authored while the lights are on, in every preset, and not at all when they are off.
    // Whatever material a mesh shows as its own now (物理光照's sky-light copy over these copies) follows.
    const glowScale = lamps.power ? 1 : 0;
    for (const {mesh, copies, bases} of glow) for (const materials of [copies, [ownMaterial(mesh)].flat()]) {
      materials.forEach((material, index) => {if (bases[index] !== undefined) material.emissiveIntensity = bases[index] * glowScale;});
    }
    return pending;
  }
  function setIndoor(value) {
    lamps = indoorLighting(value); const pending = updateIndoor();
    if (selected === 'night') nightWindow.invalidate();
    // Daytime window/sun shadows are unaffected by the unshadowed indoor fill.
    if (['night', 'physical'].includes(selected)) renderer.shadowMap.needsUpdate = true;
    return pending;
  }
  function syncOccluders() {
    const physical = selected !== 'balanced';
    for (const {object, proxy} of roofs) proxy.visible = physical && !object.visible;
    room.traverse(mesh => {
      if (!mesh.isMesh) return;
      // A see-through near wall still stops the sun when the lights are physical.
      const faint = hasLayer(mesh, 'seeThrough');
      const opaque = [ownMaterial(mesh)].flat().every(material => !material.transparent && !(material.transmission > 0));
      const sunThroughCard = daylightCards.has(mesh) && TIME_PRESETS[selected].exteriorTint;
      if (faint) mesh.castShadow = physical && opaque && !sunThroughCard && ownShadows(mesh).castShadow;
      else if (!opaque) {
        if (!glassCasters.has(mesh)) glassCasters.set(mesh, mesh.castShadow);
        mesh.castShadow = physical ? false : glassCasters.get(mesh);
      }
    });
  }
  function apply(value, {warm: warmValue = false} = {}) {
    const previous = selected;
    selected = timePreset(value); warm = warmValue;
    const preset = TIME_PRESETS[selected], base = selected === 'balanced', physicalMode = selected === 'physical';
    if (!physicalMode) physical.deactivate();
    if (selected !== previous) {
      if (previous === 'night') restoreModelLights();
      if (selected === 'night') for (const light of modelLights) {
        if (light.visible) {nightHidden.add(light); light.visible = false;}
      }
      applyExterior(preset);
    }
    if (physicalMode) physical.activate();
    renderer.toneMappingExposure = baseExposure * (preset.exposureScale ?? 1);
    if (!base && selected !== 'night' && !physicalMode) skylight();
    const daylight = selected !== 'night' && !(physicalMode && physical.usesModelLights);
    sun.visible = sun.castShadow = daylight; fill.visible = base;
    if (windowLight) {
      windowLight.visible = windowLight.castShadow = !base && selected !== 'night' && !physicalMode;
      windowLight.intensity = windowLight.position.distanceToSquared(windowLight.target.position) * (preset.window || 0);
      windowLight.color.set(preset.sky || 0xffffff);
    }
    hemisphere.visible = !physicalMode;
    hemisphere.intensity = base ? profile.hemisphere : preset.hemisphere ?? 0;
    hemisphere.color.set(base ? 0xffffff : preset.sky ?? 0xffffff); hemisphere.groundColor.set(preset.ground ?? 0x87919d);
    sun.intensity = base ? profile.key : physicalMode ? physical.sun.intensity : preset.key; fill.intensity = base ? profile.fill : preset.fill ?? 0;
    if (physicalMode) sun.color.setRGB(...physical.sun.color, THREE.LinearSRGBColorSpace);
    else sun.color.set(base ? warm ? 0xffd2a5 : 0xffffff : preset.color);
    fill.color.set(base ? warm ? 0xffd2a5 : 0xffffff : preset.sky ?? 0xffffff);
    scene.environmentIntensity = environment ? base ? profile.environment : physicalMode ? physical.environmentIntensity : preset.environment : 0;
    const pending = updateIndoor();
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
    return pending;
  }
  // Keep reporting the adjustable spot, including when it supplies the night shadow.
  function lampState() {
    const spot = (selected === 'night' ? spots.find(({spec}) => spec.castShadow) : spots[0])?.spot;
    return spot ? {position: spot.position.toArray(), target: spot.target.position.toArray(), source: plan.length ? 'luminaire' : 'room-bounds-center',
      roomBounds: {min: bounds.min.toArray(), max: bounds.max.toArray()}, angle: THREE.MathUtils.radToDeg(spot.angle * 2),
      shadowFov: spot.shadow.camera.fov, shadowBias: spot.shadow.bias, normalBias: spot.shadow.normalBias,
      intensity: spot.intensity, level: TIME_PRESETS[selected].indoor || 0, decay: spot.decay, visible: spot.visible} : null;
  }
  return {
    apply, syncOccluders, setIndoor, invalidateWindowReflection: nightWindow.invalidate,
    // How many ceiling luminaires light the room (0: the central lamp).
    fixtures: luminaires.length,
    previewLights: () => previewLights.map(light => light.clone()),
    snapshot: () => ({preset: selected, windowReflection: nightWindow.snapshot(), physical: physical.snapshot(), window: windows[0]?.name || null, directionBasis: windows.length ? 'principal-window' : 'room-axes',
      indoor: {...lamps}, environmentIntensity: scene.environmentIntensity, exteriorEmissionScale: TIME_PRESETS[selected].exterior ?? 1,
      shadowLight: selected === 'night' ? spots.some(({spot}) => spot.visible && spot.castShadow) ? 'SpotLight' : null : 'DirectionalLight',
      windowLight: windowLight ? {position: windowLight.position.toArray(), intensity: windowLight.intensity, visible: windowLight.visible, castShadow: windowLight.castShadow, mapSize: windowLight.shadow.mapSize.toArray()} : null,
      lamp: lampState(),
      floorArea: floor,
      luminaires: luminaires.map(({name, center, axis, length, width, area}) => ({name, center, axis, length, width, area})),
      lights: [
        ...lampSpecs.flatMap((spec, index) => {
          if (selected === 'night' && !spec.castShadow) return [];
          const spot = spots[index]?.spot;
          return [{type: 'SpotLight', source: spec.source, luminaire: spec.luminaire ?? null, folded: spec.folded ?? [],
            position: spot?.position.toArray() ?? (selected === 'night' && shadowArea ? shadowArea.spec.position : spec.position),
            share: selected === 'night' ? shadowShare : spec.share,
            intensity: spot?.intensity ?? 0, visible: spot?.visible ?? false, castShadow: spot?.castShadow ?? false, shadowCandidate: spec.castShadow}];
        }),
        ...(selected === 'night' ? areas.map(({light, spec, fixture}) => ({type: 'RectAreaLight', source: 'luminaire', luminaire: spec.luminaire,
          folded: spec.folded, position: fixture.center, share: spec.share - (spec === shadowArea?.spec ? shadowShare : 0),
          intensity: light?.visible ? light.intensity : 0, visible: light?.visible ?? false, castShadow: false, shadowCandidate: false})) : []),
      ]}),

    dispose() {
      if (disposed) return;
      disposed = true;
      if (areas[0]?.light) {
        const uniforms = THREE.UniformsLib, users = ltcUsers.get(uniforms) - 1;
        ltcUsers.set(uniforms, users);
        if (!users) for (const key of ['LTC_FLOAT_1', 'LTC_FLOAT_2', 'LTC_HALF_1', 'LTC_HALF_2']) uniforms[key].dispose();
      }
      nightWindow.dispose();
      restoreModelLights();
      physical.dispose();
      renderer.toneMappingExposure = baseExposure;
      applyExterior(TIME_PRESETS.balanced);
      roof.removeFromParent(); roofMaterial.dispose();
      for (const {mesh, source, copies} of glow) {
        setOwnMaterial(mesh, source);
        copies.forEach(material => material.dispose());
      }
      for (const {spot} of spots) {spot.removeFromParent(); spot.target.removeFromParent(); spot.dispose();}
      for (const {light} of areas) if (light) {light.removeFromParent(); light.dispose();}
      if (marker) {marker.removeFromParent(); marker.geometry.dispose(); marker.material.dispose();}
      if (windowLight) {windowLight.removeFromParent(); windowLight.target.removeFromParent(); windowLight.dispose();}
    },
  };
}
