// 漫游: walk through the room at eye height. WASD or the arrow keys walk, Shift hurries, Q and E
// raise and lower the eye, dragging looks and Esc leaves. The mouse is never captured: a captured
// mouse brings the browser's own banner, and Esc would only give the mouse back. A click on a door,
// cabinet door or drawer opens or closes it, as in 预览.
// The body is a column of RADIUS. Rays across the floor at knee, waist and chest height, from its
// middle and both edges, stop it at walls and furniture, and it slides along what it meets.

export const EYE = 1.6, RADIUS = .25, WALK = 1.4, RUN = 2.8, LOOK = .003, RISE = .8, EYES = [.5, 2.2];
const HEIGHTS = [.3, .9, 1.45], EDGE = .7, PITCH = 1.45;
const KEYS = {KeyW: [0, 1], ArrowUp: [0, 1], KeyS: [0, -1], ArrowDown: [0, -1], KeyA: [-1, 0], ArrowLeft: [-1, 0], KeyD: [1, 0], ArrowRight: [1, 0]};
const SHIFT = new Set(['ShiftLeft', 'ShiftRight']), LIFT = {KeyQ: 1, KeyE: -1};

// The direction on the floor ([x, z], unit) for the held keys, facing `yaw` (0 faces -Z, as a camera does).
export function walkDirection(held, yaw) {
  let right = 0, forward = 0;
  for (const code of held) if (KEYS[code]) {right += KEYS[code][0]; forward += KEYS[code][1];}
  const length = Math.hypot(right, forward);
  if (!length) return null;
  right /= length; forward /= length;
  const sin = Math.sin(yaw), cos = Math.cos(yaw);
  return [right * cos - forward * sin, -right * sin - forward * cos];
}

// One step of `move` ([x, z] metres) from `at`: as far as the nearest obstacle allows, then the rest
// along it; up to three times, for a corner. cast(at, direction, far) → {gap, normal} | null, where
// gap is how far the body's middle can go before touching and normal is the obstacle's on the floor.
export function slide(at, move, cast) {
  let [x, z] = at, [dx, dz] = move;
  for (let bounce = 0; bounce < 3; bounce++) {
    const length = Math.hypot(dx, dz);
    if (length < 1e-5) break;
    const dir = [dx / length, dz / length];
    const hit = cast([x, z], dir, length + RADIUS);
    if (!hit || hit.gap >= length) {x += dx; z += dz; break;}
    const go = Math.max(0, hit.gap - .01);
    x += dir[0] * go; z += dir[1] * go;
    let [nx, nz] = hit.normal;
    if (dir[0] * nx + dir[1] * nz > 0) {nx = -nx; nz = -nz;}
    const into = dir[0] * nx + dir[1] * nz, rest = length - go;
    dx = (dir[0] - nx * into) * rest; dz = (dir[1] - nz * into) * rest;
  }
  return [x, z];
}

// Where to stand first: the room's middle, else the nearest free point on rings around it.
export function* spots(center, bounds, step = .35) {
  yield center;
  const reach = Math.max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1]);
  for (let r = step; r <= reach; r += step) {
    const count = Math.ceil(2 * Math.PI * r / step);
    for (let i = 0; i < count; i++) {
      const a = i / count * 2 * Math.PI, x = center[0] + r * Math.cos(a), z = center[1] + r * Math.sin(a);
      if (x > bounds.min[0] && x < bounds.max[0] && z > bounds.min[1] && z < bounds.max[1]) yield [x, z];
    }
  }
}

// The body against the room: cast (for slide) and free (nothing on or around a spot).
// room: the room's root; solid(hit): whether a ray hit counts (shown, not see-through).
export function createBody(THREE, {room, floorY, solid}) {
  const ray = new THREE.Raycaster(), origin = new THREE.Vector3(), direction = new THREE.Vector3(), normal = new THREE.Vector3();

  function firstSolid(hits) {for (const hit of hits) if (solid(hit)) return hit; return null;}

  function cast([px, pz], [dx, dz], far) {
    let best = null;
    for (const offset of [0, -EDGE * RADIUS, EDGE * RADIUS]) {
      const front = Math.sqrt(RADIUS ** 2 - offset ** 2);
      for (const height of HEIGHTS) {
        origin.set(px - dz * offset, floorY + height, pz + dx * offset);
        ray.set(origin, direction.set(dx, 0, dz)); ray.far = far;
        const hit = firstSolid(ray.intersectObject(room, true));
        if (!hit?.face) continue;
        normal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
        // A sloping top (a cushion, a lid) faces up: it is not in the way at this height.
        if (Math.abs(normal.y) > .7) continue;
        const flat = Math.hypot(normal.x, normal.z), gap = hit.distance - front;
        if (!best || gap < best.gap) best = {gap, normal: [normal.x / flat, normal.z / flat]};
      }
    }
    return best;
  }

  // Nothing stands on this spot (straight down reaches the floor) and nothing is within reach around it.
  function free([px, pz]) {
    ray.set(origin.set(px, floorY + 1.85, pz), direction.set(0, -1, 0)); ray.far = 1.9;
    const below = firstSolid(ray.intersectObject(room, true));
    if (below && below.point.y > floorY + .12) return false;
    for (let i = 0; i < 8; i++) {
      const a = i / 8 * 2 * Math.PI, hit = cast([px, pz], [Math.cos(a), Math.sin(a)], RADIUS + .1);
      if (hit && hit.gap < .05) return false;
    }
    return true;
  }

  return {cast, free};
}

// bounds: {min: [x, z], max: [x, z]} to stay inside; onChange: the view moved; onClick(ndc): a click
// at a screen point; onHover(ndc, event): the mouse rests over a screen point; onExit: Esc.
export function createWalk(THREE, {canvas, room, floorY, bounds, solid, onChange, onClick, onHover = () => {}, onExit}) {
  const camera = new THREE.PerspectiveCamera(70, 1, .05, 200);
  camera.rotation.order = 'YXZ';
  const {cast, free} = createBody(THREE, {room, floorY, solid});
  const held = new Set();
  let x = 0, z = 0, eye = EYE, yaw = 0, pitch = 0, active = false, frame = 0, last = 0, lookedAt = 0, drag = null;
  const inside = [bounds.min[0] + RADIUS, bounds.min[1] + RADIUS, bounds.max[0] - RADIUS, bounds.max[1] - RADIUS];

  // Face the longest clear view from where the walk starts.
  function openest([px, pz]) {
    let best = 0, far = -1;
    for (let i = 0; i < 12; i++) {
      const a = i / 12 * 2 * Math.PI, hit = cast([px, pz], [Math.sin(-a), -Math.cos(a)], 20);
      const gap = hit ? hit.gap : 20;
      if (gap > far) {far = gap; best = a;}
    }
    return best;
  }

  function place() {
    camera.position.set(x, floorY + eye, z);
    camera.rotation.set(pitch, yaw, 0);
    camera.updateMatrixWorld();
  }

  function look(dx, dy) {
    yaw -= dx * LOOK;
    pitch = Math.max(-PITCH, Math.min(PITCH, pitch - dy * LOOK));
    lookedAt = performance.now();
    place(); onChange();
  }

  function tick(now) {
    frame = 0;
    const dt = Math.min(.05, (now - last) / 1000); last = now;
    const step = walkDirection(held, yaw), lift = [...held].reduce((sum, code) => sum + (LIFT[code] || 0), 0);
    if (!step && !lift) return;
    if (step) {
      const speed = [...held].some((code) => SHIFT.has(code)) ? RUN : WALK;
      [x, z] = slide([x, z], [step[0] * speed * dt, step[1] * speed * dt], cast);
      x = Math.min(inside[2], Math.max(inside[0], x)); z = Math.min(inside[3], Math.max(inside[1], z));
    }
    eye = Math.min(EYES[1], Math.max(EYES[0], eye + lift * RISE * dt));
    place(); onChange();
    frame = requestAnimationFrame(tick);
  }

  const typing = (event) => event.target.closest?.('input,select,textarea,[contenteditable="true"]');
  function keydown(event) {
    if (typing(event) || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.code === 'Escape') {event.preventDefault(); onExit(); return;}
    if (!KEYS[event.code] && !LIFT[event.code] && !SHIFT.has(event.code)) return;
    event.preventDefault();
    held.add(event.code);
    if (!frame && (KEYS[event.code] || LIFT[event.code])) {last = performance.now(); frame = requestAnimationFrame(tick);}
  }
  const keyup = (event) => {held.delete(event.code);};
  const blur = () => {held.clear();};
  const at = (event) => {
    const rect = canvas.getBoundingClientRect();
    return {x: (event.clientX - rect.left) / rect.width * 2 - 1, y: -(event.clientY - rect.top) / rect.height * 2 + 1};
  };
  function pointerdown(event) {
    if (event.button !== 0 || !event.isPrimary) return;
    canvas.setPointerCapture?.(event.pointerId);
    drag = {x: event.clientX, y: event.clientY, px: event.clientX, py: event.clientY, moved: false};
  }
  function pointermove(event) {
    if (!drag) {if (event.pointerType === 'mouse') onHover(at(event), event); return;}
    if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 5) drag.moved = true;
    if (drag.moved) look(event.clientX - drag.px, event.clientY - drag.py);
    drag.px = event.clientX; drag.py = event.clientY;
  }
  function pointerup(event) {
    if (event.button !== 0 || !drag) return;
    const click = !drag.moved; drag = null;
    if (click) onClick(at(event));
  }
  const pointercancel = () => {drag = null;};
  const listeners = [[document, 'keydown', keydown], [document, 'keyup', keyup], [window, 'blur', blur],
    [canvas, 'pointerdown', pointerdown], [canvas, 'pointermove', pointermove], [canvas, 'pointerup', pointerup], [canvas, 'pointercancel', pointercancel]];

  let start = null;
  return {
    camera,
    get active() {return active;},
    // Walking or just turned: the settled lighting waits.
    moving: () => active && (frame !== 0 || drag?.moved || performance.now() - lookedAt < 200),
    enter() {
      if (active) return;
      active = true;
      room.updateMatrixWorld(true);
      // Back where the last walk ended, if that is still free; else the free spot nearest the middle.
      if (!start || !free(start)) {
        const middle = [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2];
        start = middle;
        for (const spot of spots(middle, {min: inside.slice(0, 2), max: inside.slice(2)})) if (free(spot)) {start = spot; break;}
        [x, z] = start; yaw = openest(start); pitch = -.08; eye = EYE;
      } else [x, z] = start;
      for (const [target, type, handler] of listeners) target.addEventListener(type, handler);
      place(); onChange();
    },
    exit() {
      if (!active) return;
      active = false; start = [x, z];
      cancelAnimationFrame(frame); frame = 0; held.clear(); drag = null;
      for (const [target, type, handler] of listeners) target.removeEventListener(type, handler);
    },
    resize(width, height) {camera.aspect = width / height; camera.updateProjectionMatrix();},
    snapshot: () => ({active, position: [x, floorY + eye, z], eye, yaw, pitch}),
  };
}
