import {spotShadowBias} from './room-luminaires.mjs';

// "物理光照": the Android walkthrough's PhysicalRoomLighting (Filament) in Three.js.
// Both port the room pipeline's lighting="physical" recipe: a sun, a 60 W lamp under each
// ceiling and a 20 W light inside each window, with a physical camera exposure. A room with
// ceiling luminaires lights from them instead of the generated ceiling lamps (room-luminaires.mjs).
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
  // A room lit from its own luminaires (room-luminaires.mjs) is never dimmer than this one generated
  // lamp: when their watts sum to less than ceilingWatts, they are scaled up to it in proportion.
  ceilingWatts: 60, ceilingKelvin: 4700, ceilingDrop: .05,
  windowWatts: 20, windowKelvin: 6500, windowInset: .08, windowDown: .35,
  // Spot cone half-angles in degrees (Filament spotLightCone inner/outer).
  spotInner: 45, spotOuter: 85,
  // The phone uses 512 with PCSS; PCFSoft needs 1024 to keep cube shadow edges smooth.
  // At most maxLocalLights local lights cast shadows, whatever they are: with the sun, a material with
  // many maps stays inside 16 texture units. With luminaires, their spots take up to 3 of those shadows,
  // at most luminaireWindows window lights are made (largest first) and the shadows left go to them.
  maxLocalLights: 4, localShadowMap: 1024, luminaireWindows: 2,
  // LightManager.EFFICIENCY_LED: 11.71 % of 683 lm/W.
  lumensPerWatt: .1171 * 683,
  // Outside of the walls (see exteriorShell): a soft, even daylight, in output units.
  exteriorLight: .6,
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
// Local lights reach 1.5 room diagonals.
const roomFalloff = room => Math.max(1, Math.hypot(...room.max.map((v, k) => v - room.min[k])) * 1.5);
const windowKey = name => (/^window(?:[_-]?\d+)?/i.exec(name)?.[0] || name).toLowerCase();

// RoomLightLayout.plan with plain boxes ({min, max} arrays): ceilings first, then windows.
// `parts` are [{name, kind: 'ceiling' | 'window', box}], `room` the shell box.
export function planLocalLights(room, parts, max = PHYSICAL.maxLocalLights) {
  if (max <= 0) return [];
  const falloff = roomFalloff(room), center = middle(room);
  const ceilings = parts.filter(part => part.kind === 'ceiling').map(part => {
    const c = middle(part.box);
    return {kind: 'ceiling', name: part.name, position: [c[0], part.box.min[1] - PHYSICAL.ceilingDrop, c[2]], direction: null,
      watts: PHYSICAL.ceilingWatts, kelvin: PHYSICAL.ceilingKelvin, falloff};
  });
  const groups = new Map();
  for (const part of parts) if (part.kind === 'window') {
    // A window root already covers its frame and sashes.
    const key = part.windowRoot ? part.name : windowKey(part.name), entry = groups.get(key);
    groups.set(key, entry ? {names: [...entry.names, part.name], box: union(entry.box, part.box)} : {names: [part.name], box: part.box});
  }
  const windows = [...groups.values()].map(({names, box}) => {
    const c = middle(box);
    let ix = center[0] - c[0], iz = center[2] - c[2];
    const length = Math.hypot(ix, iz);
    if (length < 1e-6) {ix = 0; iz = 1;} else {ix /= length; iz /= length;}
    const d = Math.hypot(1, PHYSICAL.windowDown);
    const size = box.max.map((v, k) => v - box.min[k]);
    return {kind: 'window', name: names.join('+'), area: size[1] * Math.max(size[0], size[2]), position: [c[0] + ix * PHYSICAL.windowInset, c[1], c[2] + iz * PHYSICAL.windowInset],
      direction: [ix / d, -PHYSICAL.windowDown / d, iz / d], watts: PHYSICAL.windowWatts, kelvin: PHYSICAL.windowKelvin, falloff};
  });
  return [...ceilings, ...windows].slice(0, max);
}

// The box of a node's own mesh: a reconstructed room nests furniture under Floor0 and fixtures or curtains
// under Ceiling0 (the editor flattens that, the replay does not). A node without a mesh of its own (a
// ceiling made of several meshes) keeps the box of everything under it.
export function surfaceBox(THREE, object) {
  if (!object.isMesh) return new THREE.Box3().setFromObject(object);
  if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
  object.updateWorldMatrix(true, false);
  return object.geometry.boundingBox.clone().applyMatrix4(object.matrixWorld);
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
    // The replay retains the GLB hierarchy, where a wall can contain an explicitly identified window.
    const windowRoot = config?.windowRoots?.has(object);
    if (claimed.has(object.parent) && !windowRoot) {claimed.add(object); return;}
    const name = nameOf(object), kind = name ? kindOf(name) : null;
    if (!kind) return;
    claimed.add(object);
    if (kind === 'other' || (kind === 'window' && (windowRoot === false || /drape|sheer|curtain|blind/i.test(name)))) return;
    // A ceiling's own surface, not the curtains or fixtures the replay's model nests under it.
    const box = kind === 'ceiling' ? surfaceBox(THREE, object) : new THREE.Box3().setFromObject(object);
    if (!box.isEmpty()) parts.push({name, kind, windowRoot, box: {min: box.min.toArray(), max: box.max.toArray()}});
  });
  const shell = parts.filter(part => part.kind !== 'window').map(part => part.box).reduce((a, b) => a ? union(a, b) : b, null);
  return {parts: parts.filter(part => part.kind !== 'shell'), shell};
}

// The phone only walks inside the room. The editor's overview also looks at the room from
// above and outside: the sun blows the walls' outer faces out to white, and whatever faces up
// above the lamps (wall tops, curtain boxes, a wardrobe's top) gets no light at all and goes
// black. Those surfaces, hidden by the ceiling when walking, get an even sky light instead:
// a wall's outer face, any up-facing surface above the lamps, and anything above the ceiling.
// Everything seen from inside keeps the physical lighting.
const EXTERIOR_UNIFORMS = `
#ifdef ROOM_EXTERIOR
uniform vec3 roomInward;
uniform float roomWallD;
uniform float roomCeilingY;
uniform float roomLampY;
uniform float roomExteriorLight;
#endif`;
const EXTERIOR_CHUNK = `
#ifdef ROOM_EXTERIOR
{
  vec3 exteriorNormal = inverseTransformDirection( geometryNormal, viewMatrix );
  vec3 exteriorPosition = ( inverse( viewMatrix ) * vec4( geometryPosition, 1.0 ) ).xyz;
  // Inside a wall's thickness (end caps, door and window reveals) nothing faces the room.
  bool inWall = dot( exteriorPosition, roomInward ) < roomWallD - 0.005 && dot( exteriorNormal, roomInward ) < 0.5;
  if ( inWall || dot( exteriorNormal, roomInward ) < -0.5 || exteriorPosition.y > roomCeilingY + 0.01
    || ( exteriorNormal.y > 0.5 && exteriorPosition.y > roomLampY ) ) {
    reflectedLight.directDiffuse = vec3( 0.0 );
    reflectedLight.directSpecular = vec3( 0.0 );
    reflectedLight.indirectSpecular = vec3( 0.0 );
    // Tops a little brighter than the sides, as under an overcast sky.
    reflectedLight.indirectDiffuse = material.diffuseColor * roomExteriorLight * ( 0.88 + 0.12 * max( exteriorNormal.y, 0.0 ) );
  }
}
#endif`;
function installChunks(THREE) {
  const chunk = THREE.ShaderChunk;
  if (!chunk.lights_pars_begin.includes('ROOM_EXTERIOR')) chunk.lights_pars_begin += EXTERIOR_UNIFORMS;
  if (!chunk.lights_fragment_end.includes('ROOM_EXTERIOR')) chunk.lights_fragment_end += EXTERIOR_CHUNK;
}
// The wall direction is a per-material uniform, so every material of one kind shares a program.
// MeshStandardMaterial.copy() resets `defines`; these subclasses carry the define (and, through
// userData, the uniforms) over to the clones that see-through and selection layers make.
const exteriorClasses = new Map();
function exteriorClass(Base) {
  if (!exteriorClasses.has(Base)) exteriorClasses.set(Base, class extends Base {
    copy(source) {super.copy(source); this.defines = {...source.defines}; return this;}
    onBeforeCompile(shader) {
      const {inward, wallD, ceiling, lamp, light} = this.userData.roomExterior;
      Object.assign(shader.uniforms, {roomInward: {value: inward}, roomWallD: {value: wallD}, roomCeilingY: {value: ceiling},
        roomLampY: {value: lamp}, roomExteriorLight: {value: light}});
    }
  });
  return exteriorClasses.get(Base);
}
const lit = material => material?.isMaterial && !material.isMeshBasicMaterial && !material.isShaderMaterial && material.lights !== false;

// Which wall a mesh belongs to: the wall's own meshes, and anything whose box reaches the wall's
// inner face from at most `depth` inside the room along that wall (doors, frames, skirting,
// trunking, sockets). Its outer faces only show from outside.
export function wallInward(THREE, {room, walls, depth = .35}) {
  const byName = new Map(walls.map(face => [face.name, face]));
  const inward = new Map(), box = new THREE.Box3(), corner = new THREE.Vector3();
  room.traverse(object => {
    const face = byName.get(object.userData?.name || object.name);
    if (face) object.traverse(mesh => {if (mesh.isMesh) inward.set(mesh, {n: face.n, d: Number.isFinite(face.d) ? face.d : null});});
  });
  room.traverse(mesh => {
    if (!mesh.isMesh || inward.has(mesh)) return;
    box.setFromObject(mesh);
    if (box.isEmpty()) return;
    let best = null;
    for (const face of walls) {
      if (!Number.isFinite(face.d) || !face.tangent || !face.bounds) continue;
      let low = Infinity, high = -Infinity, left = Infinity, right = -Infinity;
      for (let i = 0; i < 8; i++) {
        corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
        const along = face.n[0] * corner.x + face.n[2] * corner.z - face.d, across = face.tangent[0] * corner.x + face.tangent[2] * corner.z;
        low = Math.min(low, along); high = Math.max(high, along); left = Math.min(left, across); right = Math.max(right, across);
      }
      const overlaps = right > face.bounds[0][0] - .05 && left < face.bounds[1][0] + .05;
      if (low < .03 && high < depth && high > -.5 && overlaps && (!best || Math.abs(low) < best.gap)) best = {face, gap: Math.abs(low)};
    }
    if (best) inward.set(mesh, {n: best.face.n, d: null});
  });
  return inward;
}

// meshes: [{mesh, inward}]; inward is {n, d} for a wall's own meshes ({n, d: null} for things on it),
// null elsewhere. A mesh whose own material changed while
// the sky light was on (an imported object switched to its lit look) keeps the new material.
export function exteriorShell(THREE, {meshes, ceilingHeight, light = PHYSICAL.exteriorLight, own, setOwn}) {
  installChunks(THREE);
  const ceiling = Number.isFinite(ceilingHeight) ? ceilingHeight : 1e6;
  const entries = meshes.filter(({mesh}) => [own(mesh)].flat().some(lit)).map(({mesh, inward}) => ({mesh, inward, source: null, copy: null, made: []}));
  function prepare(entry) {
    const source = own(entry.mesh);
    if (entry.source === source) return;
    entry.made.forEach(material => material.dispose());
    const copies = [source].flat().map(material => {
      if (!lit(material)) return material;
      const copy = new (exteriorClass(material.constructor))().copy(material);
      copy.defines = {...copy.defines, ROOM_EXTERIOR: ''};
      copy.userData.roomExterior = {inward: [...(entry.inward?.n || [0, 0, 0])], wallD: entry.inward?.d ?? -1e6, ceiling, lamp: ceiling - PHYSICAL.ceilingDrop - .01, light};
      return copy;
    });
    entry.source = source; entry.copy = Array.isArray(source) ? copies : copies[0];
    entry.made = copies.filter(copy => ![source].flat().includes(copy));
  }
  let on = false;
  return {
    meshes: entries.length,
    walls: entries.filter(entry => entry.inward).length,
    set(value) {
      if (value === on) return; on = value;
      for (const entry of entries) {
        if (on) {prepare(entry); setOwn(entry.mesh, entry.copy);}
        else if (own(entry.mesh) === entry.copy) setOwn(entry.mesh, entry.source);
      }
    },
    dispose() {this.set(false); for (const {made} of entries) made.forEach(material => material.dispose());},
  };
}

// Owns the local lamps only; time-lighting.mjs points the shared sun and hides the other rigs.
// `luminaires`: planLuminaireLights() spots, which replace the generated ceiling lamps. They are spots
// with the user's cone (`angle`, full degrees), converted from watts over that cone, together at least
// ceilingWatts. Shadows: see maxLocalLights.
export function createPhysicalLighting(THREE, {scene, room, config, bounds, toneExposure = 1, walls = [], ceilingY = Infinity, own, setOwn,
  floorY = bounds.min.y, luminaires = [], angle = 160}) {
  const {ev100, exposure} = physicalExposure();
  const preExposure = exposure / toneExposure;
  const gltfLights = [];
  room.traverse(object => {if (object.isLight) gltfLights.push({light: object, intensity: object.intensity});});
  const {parts, shell} = roomLightParts(THREE, {room, config});
  const roomBox = shell || {min: bounds.min.toArray(), max: bounds.max.toArray()};
  const falloff = roomFalloff(roomBox);
  const boost = Math.max(1, PHYSICAL.ceilingWatts / luminaires.reduce((sum, {watts}) => sum + watts, 0));
  const lamps = luminaires.map(({luminaire, position, watts, castShadow}) => ({kind: 'luminaire', name: luminaire, position, direction: [0, -1, 0],
    watts: watts * boost, kelvin: PHYSICAL.ceilingKelvin, falloff, castShadow}));
  const shadowsLeft = PHYSICAL.maxLocalLights - lamps.filter(lamp => lamp.castShadow).length;
  const windows = planLocalLights(roomBox, parts.filter(part => part.kind === 'window'), Infinity)
    .sort((a, b) => b.area - a.area).slice(0, PHYSICAL.luminaireWindows).map((spec, index) => ({...spec, castShadow: index < shadowsLeft}));
  // glTF lamps replace the generated ones, as on the phone (no sun either).
  const specs = gltfLights.length ? [] : lamps.length ? [...lamps, ...windows] : planLocalLights(roomBox, parts);
  const lights = [];
  let active = false, power = true, cone = angle, outside = null;
  const candela = spec => spec.kind === 'luminaire' ? spotCandela(spec.watts, cone / 2) : spec.kind === 'window' ? spotCandela(spec.watts) : pointCandela(spec.watts);
  // The luminaire spots follow the cone setting: the same watts over a wider cone are fewer candela.
  function aim() {
    for (const {spec, light} of lights) if (spec.kind === 'luminaire') {
      light.angle = cone / 2 * Math.PI / 180; light.intensity = candela(spec) * preExposure;
      Object.assign(light.shadow, spotShadowBias(Math.max(.8, spec.position[1] - floorY), light.angle, light.shadow.mapSize.x));
    }
  }
  // The lowest ceiling surface; walls usually rise a little above it.
  const ceilings = parts.filter(part => part.kind === 'ceiling').map(part => part.box.min[1]);
  const ceilingHeight = ceilings.length ? Math.min(...ceilings) : ceilingY;
  const inward = wallInward(THREE, {room, walls});
  const skyMeshes = [];
  room.traverse(mesh => {if (mesh.isMesh) skyMeshes.push({mesh, inward: inward.get(mesh) || null});});

  function build() {
    if (lights.length || !specs.length) return;
    for (const spec of specs) {
      const color = new THREE.Color().setRGB(...illuminantD(spec.kelvin), THREE.LinearSRGBColorSpace);
      let light;
      if (spec.kind === 'luminaire') {
        // Straight down from the light itself: the replay's floor height can be off (see room-view.mjs).
        light = new THREE.SpotLight(color, 1, spec.falloff, 1, .3, 2);
        light.target.position.set(spec.position[0], spec.position[1] - 1, spec.position[2]);
        scene.add(light.target);
      } else if (spec.kind === 'window') {
        light = new THREE.SpotLight(color, spotCandela(spec.watts) * preExposure, spec.falloff,
          PHYSICAL.spotOuter * Math.PI / 180, 1 - PHYSICAL.spotInner / PHYSICAL.spotOuter, 2);
        light.target.position.set(...spec.position.map((v, k) => v + spec.direction[k]));
        scene.add(light.target);
      } else light = new THREE.PointLight(color, pointCandela(spec.watts) * preExposure, spec.falloff, 2);
      light.name = `physical-${spec.kind}-light`; light.userData.lightingRole = `physical-${spec.kind}`;
      light.position.set(...spec.position);
      light.castShadow = spec.castShadow ?? true; light.shadow.mapSize.set(PHYSICAL.localShadowMap, PHYSICAL.localShadowMap);
      // Shadows only matter inside the room: its diagonal, not the light's falloff, sets the depth range.
      light.shadow.camera.near = .05; light.shadow.camera.far = spec.falloff / 1.5;
      // Mostly depth bias (normalised distance, -.003 ≈ 2 cm here): a large normal offset pushes
      // the lookup through thin or inward-facing parts, such as the office's wall trunking.
      // The luminaire spots take the indoor lamp's cone-dependent bias instead (see aim).
      light.shadow.bias = -.003; light.shadow.normalBias = .005;
      scene.add(light); lights.push({spec, light});
    }
    aim();
  }
  function sync() {
    for (const {spec, light} of lights) light.visible = active && (spec.kind === 'window' || power);
    for (const entry of gltfLights) entry.light.intensity = active ? entry.intensity * preExposure : entry.intensity;
    if (active && !outside && own) outside = exteriorShell(THREE, {meshes: skyMeshes, ceilingHeight, own, setOwn});
    outside?.set(active);
  }
  return {
    usesModelLights: gltfLights.length > 0,
    sun: {intensity: PHYSICAL.sunLux * preExposure, color: illuminantD(PHYSICAL.sunKelvin), direction: sunDirection()},
    environmentIntensity: PHYSICAL.environment * preExposure,
    activate() {active = true; build(); sync();},
    deactivate() {if (!active) return; active = false; sync();},
    setIndoor({power: on, angle: degrees}) {power = on; if (degrees !== cone) {cone = degrees; aim();} sync();},
    snapshot: () => ({active, ev100, exposure, preExposure, gltfLights: gltfLights.length,
      shadowCasters: specs.filter(spec => spec.castShadow ?? true).map(spec => `${spec.kind}:${spec.name}`),
      exterior: {onWalls: outside?.walls ?? 0, meshes: outside?.meshes ?? 0, ceilingHeight, light: PHYSICAL.exteriorLight},
      parts: parts.map(({name, kind}) => ({name, kind})),
      lights: specs.map((spec, index) => ({...spec, visible: lights[index]?.light.visible ?? false, candela: candela(spec),
        castShadow: lights[index]?.light.castShadow ?? spec.castShadow ?? true, intensity: lights[index]?.light.intensity ?? null}))}),
    dispose() {
      active = false; sync(); outside?.dispose(); outside = null;
      for (const {light} of lights) {light.removeFromParent(); light.target?.removeFromParent(); light.dispose();}
      lights.length = 0;
    },
  };
}
