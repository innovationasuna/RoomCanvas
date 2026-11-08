// "物理光照": the Android walkthrough's PhysicalRoomLighting (Filament) in Three.js.
// Both port the room pipeline's lighting="physical" recipe: a sun, a 60 W lamp under each
// ceiling and a 20 W light inside each window, with a physical camera exposure.
//
// Filament pre-multiplies light intensities by the camera exposure; emissive and unlit
// surfaces are not exposed. The editor does the same: lights keep their physical units
// times `preExposure`, and renderer.toneMappingExposure stays untouched, so window photos,
// placement previews and the ground grid keep their brightness.

export const PHYSICAL = Object.freeze({
  aperture: .7, shutter: 1 / 125, iso: 100,
  // Filament IndirectLight intensity on the phone (absolute units, not a multiplier).
  environment: .25,
  sunLux: 2500, sunKelvin: 6500, sunElevation: 40, sunRotation: 35,
  ceilingWatts: 60, ceilingKelvin: 4700, ceilingDrop: .05,
  windowWatts: 20, windowKelvin: 6500, windowInset: .08, windowDown: .35,
  // Spot cone half-angles in degrees (Filament spotLightCone inner/outer).
  spotInner: 45, spotOuter: 85,
  // The phone uses 512 with PCSS; PCFSoft needs 1024 to keep cube shadow edges smooth.
  maxLocalLights: 4, localShadowMap: 1024,
  // LightManager.EFFICIENCY_LED: 11.71 % of 683 lm/W.
  lumensPerWatt: .1171 * 683,
});

// Filament Exposure::exposure(aperture, shutter, ISO) = 1 / (1.2 * 2^EV100).
export function physicalExposure({aperture, shutter, iso} = PHYSICAL) {
  const ev100 = Math.log2(aperture * aperture / shutter * 100 / iso);
  return {ev100, exposure: 1 / (1.2 * 2 ** ev100)};
}

// Filament Colors.illuminantD: CIE daylight locus -> linear sRGB, normalised to max 1.
export function illuminantD(kelvin) {
  const t = Math.min(25000, Math.max(4000, kelvin)), i = 1 / t, i2 = i * i, i3 = i2 * i;
  const x = t <= 7000 ? .244063 + 99.11 * i + 2.9678e6 * i2 - 4.607e9 * i3
    : .23704 + 247.48 * i + 1.9018e6 * i2 - 2.0064e9 * i3;
  const y = -3 * x * x + 2.87 * x - .275, X = x / y, Z = (1 - x - y) / y;
  const rgb = [3.2404542 * X - 1.5371385 - .4985314 * Z, -.969266 * X + 1.8760108 + .041556 * Z, .0556434 * X - .2040259 + 1.0572252 * Z];
  const top = Math.max(...rgb);
  return rgb.map(value => Math.min(1, Math.max(0, value / top)));
}

// Direction the sunlight travels, glTF Y-up (RoomLightLayout.sunDirection).
export function sunDirection({sunElevation, sunRotation} = PHYSICAL) {
  const e = sunElevation * Math.PI / 180, r = sunRotation * Math.PI / 180;
  return [-Math.cos(e) * Math.sin(r), -Math.sin(e), -Math.cos(e) * Math.cos(r)];
}

// Luminous intensity in candela, as Filament converts watts for each light type.
export function pointCandela(watts) {return watts * PHYSICAL.lumensPerWatt / (4 * Math.PI);}
export function spotCandela(watts, outerDegrees = PHYSICAL.spotOuter) {
  return watts * PHYSICAL.lumensPerWatt / (2 * Math.PI * (1 - Math.cos(outerDegrees * Math.PI / 180)));
}

const union = (a, b) => ({min: a.min.map((v, k) => Math.min(v, b.min[k])), max: a.max.map((v, k) => Math.max(v, b.max[k]))});
const middle = box => box.min.map((v, k) => (v + box.max[k]) / 2);
const windowKey = name => (/^window(?:[_-]?\d+)?/i.exec(name)?.[0] || name).toLowerCase();

// RoomLightLayout.plan with plain boxes ({min, max} arrays): ceilings first, then windows.
// `parts` are [{name, kind: 'ceiling' | 'window', box}], `room` the shell box.
export function planLocalLights(room, parts, max = PHYSICAL.maxLocalLights) {
  if (max <= 0) return [];
  const size = room.max.map((v, k) => v - room.min[k]);
  const falloff = Math.max(1, Math.hypot(...size) * 1.5), center = middle(room);
  const ceilings = parts.filter(part => part.kind === 'ceiling').map(part => {
    const c = middle(part.box);
    return {kind: 'ceiling', name: part.name, position: [c[0], part.box.min[1] - PHYSICAL.ceilingDrop, c[2]], direction: null,
      watts: PHYSICAL.ceilingWatts, kelvin: PHYSICAL.ceilingKelvin, falloff};
  });
  const groups = new Map();
  for (const part of parts) if (part.kind === 'window') {
    const key = windowKey(part.name), entry = groups.get(key);
    groups.set(key, entry ? {names: [...entry.names, part.name], box: union(entry.box, part.box)} : {names: [part.name], box: part.box});
  }
  const windows = [...groups.values()].map(({names, box}) => {
    const c = middle(box);
    let ix = center[0] - c[0], iz = center[2] - c[2];
    const length = Math.hypot(ix, iz);
    if (length < 1e-6) {ix = 0; iz = 1;} else {ix /= length; iz /= length;}
    const d = Math.hypot(1, PHYSICAL.windowDown);
    return {kind: 'window', name: names.join('+'), position: [c[0] + ix * PHYSICAL.windowInset, c[1], c[2] + iz * PHYSICAL.windowInset],
      direction: [ix / d, -PHYSICAL.windowDown / d, iz / d], watts: PHYSICAL.windowWatts, kelvin: PHYSICAL.windowKelvin, falloff};
  });
  return [...ceilings, ...windows].slice(0, max);
}

// Ceilings, windows and the shell come from the room's own labels; a room without
// labels falls back to the node-name prefixes the phone and the pipeline use.
// The office's ceiling grid and lamp fixtures are not ceilings; curtains and the
// photographed exterior are not windows.
export function roomLightParts(THREE, {room, config}) {
  const nameOf = object => object.userData?.name || object.name;
  const label = name => (name && config?.label?.(name)) || null;
  let labelled = false;
  room.traverse(object => {if (label(nameOf(object))) labelled = true;});
  const kindOf = name => {
    if (labelled) {
      const value = label(name);
      return value === '天花板' ? 'ceiling' : value === '窗户' ? 'window' : ['墙面', '地面'].includes(value) ? 'shell' : value ? 'other' : null;
    }
    return /^ceiling/i.test(name) ? 'ceiling' : /^window/i.test(name) ? 'window' : /^(wall|floor)/i.test(name) ? 'shell' : null;
  };
  // The first named match on a path claims its whole subtree (a window's frame, a grid's tees).
  const parts = [], claimed = new Set();
  room.traverse(object => {
    if (object === room) return;
    if (claimed.has(object.parent)) {claimed.add(object); return;}
    const name = nameOf(object), kind = name ? kindOf(name) : null;
    if (!kind) return;
    claimed.add(object);
    if (kind === 'other' || (kind === 'window' && /drape|sheer|curtain|blind/i.test(name))) return;
    const box = new THREE.Box3().setFromObject(object);
    if (!box.isEmpty()) parts.push({name, kind, box: {min: box.min.toArray(), max: box.max.toArray()}});
  });
  const shell = parts.filter(part => part.kind !== 'window').map(part => part.box).reduce((a, b) => a ? union(a, b) : b, null);
  return {parts: parts.filter(part => part.kind !== 'shell'), shell};
}

// Owns the local lamps only; time-lighting.mjs points the shared sun and hides the other rigs.
export function createPhysicalLighting(THREE, {scene, room, config, bounds, toneExposure = 1}) {
  const {ev100, exposure} = physicalExposure();
  const preExposure = exposure / toneExposure;
  const gltfLights = [];
  room.traverse(object => {if (object.isLight) gltfLights.push({light: object, intensity: object.intensity});});
  const {parts, shell} = roomLightParts(THREE, {room, config});
  const roomBox = shell || {min: bounds.min.toArray(), max: bounds.max.toArray()};
  // glTF lamps replace the generated ones, as on the phone (no sun either).
  const specs = gltfLights.length ? [] : planLocalLights(roomBox, parts);
  const lights = [];
  let active = false, power = true;

  function build() {
    if (lights.length || !specs.length) return;
    for (const spec of specs) {
      const color = new THREE.Color().setRGB(...illuminantD(spec.kelvin), THREE.LinearSRGBColorSpace);
      let light;
      if (spec.kind === 'window') {
        light = new THREE.SpotLight(color, spotCandela(spec.watts) * preExposure, spec.falloff,
          PHYSICAL.spotOuter * Math.PI / 180, 1 - PHYSICAL.spotInner / PHYSICAL.spotOuter, 2);
        light.target.position.set(...spec.position.map((v, k) => v + spec.direction[k]));
        scene.add(light.target);
      } else light = new THREE.PointLight(color, pointCandela(spec.watts) * preExposure, spec.falloff, 2);
      light.name = `physical-${spec.kind}-light`; light.userData.lightingRole = `physical-${spec.kind}`;
      light.position.set(...spec.position);
      light.castShadow = true; light.shadow.mapSize.set(PHYSICAL.localShadowMap, PHYSICAL.localShadowMap);
      // Shadows only matter inside the room: its diagonal, not the light's falloff, sets the depth range.
      light.shadow.camera.near = .05; light.shadow.camera.far = spec.falloff / 1.5;
      // Mostly depth bias (normalised distance, -.003 ≈ 2 cm here): a large normal offset pushes
      // the lookup through thin or inward-facing parts, such as the office's wall trunking.
      light.shadow.bias = -.003; light.shadow.normalBias = .005;
      scene.add(light); lights.push({spec, light});
    }
  }
  function sync() {
    for (const {spec, light} of lights) light.visible = active && (spec.kind !== 'ceiling' || power);
    for (const entry of gltfLights) entry.light.intensity = active ? entry.intensity * preExposure : entry.intensity;
  }
  return {
    usesModelLights: gltfLights.length > 0,
    sun: {intensity: PHYSICAL.sunLux * preExposure, color: illuminantD(PHYSICAL.sunKelvin), direction: sunDirection()},
    environmentIntensity: PHYSICAL.environment * preExposure,
    activate() {active = true; build(); sync();},
    deactivate() {if (!active) return; active = false; sync();},
    setPower(value) {power = value; sync();},
    snapshot: () => ({active, ev100, exposure, preExposure, gltfLights: gltfLights.length,
      parts: parts.map(({name, kind}) => ({name, kind})),
      lights: specs.map((spec, index) => ({...spec, visible: lights[index]?.light.visible ?? false,
        candela: spec.kind === 'window' ? spotCandela(spec.watts) : pointCandela(spec.watts),
        intensity: lights[index]?.light.intensity ?? null}))}),
    dispose() {
      active = false; sync();
      for (const {light} of lights) {light.removeFromParent(); light.target?.removeFromParent(); light.dispose();}
      lights.length = 0;
    },
  };
}
