// Input controls only. Placement, collision and commit decisions stay in the editor.
export function mountJoysticks(stage, actions) {
  const doc = stage.ownerDocument;
  const panel = doc.createElement('section');
  panel.className = 'rc-joysticks';
  panel.setAttribute('aria-label', '移动、旋转和升降物品');
  panel.hidden = true;
  panel.innerHTML = `
    <div class="rc-joystick-control rc-move-control">
      <button type="button" class="rc-move-stick" aria-label="移动摇杆，方向键移动物品">
        <span class="rc-stick-axis rc-stick-axis-x" aria-hidden="true"></span>
        <span class="rc-stick-axis rc-stick-axis-y" aria-hidden="true"></span>
        <span class="rc-stick-knob" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 4v16M4 12h16M9 7l3-3 3 3M9 17l3 3 3-3M7 9l-3 3 3 3M17 9l3 3-3 3"/></svg></span>
      </button>
      <span class="rc-joystick-label rc-move-label">移动</span>
    </div>
    <div class="rc-joystick-control rc-rotate-control">
      <button type="button" class="rc-rotate-dial" aria-label="旋转圆盘，左右方向键旋转物品">
        <span class="rc-dial-pointer" aria-hidden="true"></span>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 8a8 8 0 1 0 1 8M19 3v5h-5"/></svg>
      </button>
      <span class="rc-joystick-label rc-rotate-label">旋转</span>
    </div>
    <div class="rc-joystick-control rc-lift-control">
      <button type="button" class="rc-lift-lever" role="slider" aria-label="升降拉杆" aria-orientation="vertical" aria-valuemin="-100" aria-valuemax="100" aria-valuenow="0" aria-valuetext="已停止" aria-describedby="lift-control-hint">
        <span class="rc-lift-end rc-lift-top" aria-hidden="true">升高 ↑</span>
        <span class="rc-lift-track" aria-hidden="true"></span>
        <span class="rc-lift-center" aria-hidden="true"></span>
        <span class="rc-lift-handle" aria-hidden="true"><i></i><i></i><i></i></span>
        <span class="rc-lift-end rc-lift-bottom" aria-hidden="true">降低 ↓</span>
      </button>
      <span class="rc-joystick-label rc-lift-label">升降</span>
      <span class="rc-sr-only" id="lift-control-hint">向上拖动升高，向下拖动降低，拖得越远速度越快，松手停止。也可按住上下方向键。</span>
    </div>
    <span class="rc-landing-hint" aria-live="polite"></span>
    <button type="button" class="rc-surface-button" hidden>换墙</button>`;
  stage.append(panel);
  const move = panel.querySelector('.rc-move-stick');
  const knob = panel.querySelector('.rc-stick-knob');
  const dial = panel.querySelector('.rc-rotate-dial');
  const indicator = panel.querySelector('.rc-dial-pointer');
  const surface = panel.querySelector('.rc-surface-button');
  const lift = panel.querySelector('.rc-lift-lever');
  const liftHandle = panel.querySelector('.rc-lift-handle');
  const landingHint = panel.querySelector('.rc-landing-hint');
  const win = doc.defaultView;
  const keys = new Set();
  let enabled = false, wall = false, active = null, pointerId = null, captureElement = null;
  let vector = [0, 0], frame = 0, lastTime = null, lastAngle = null, dialAngle = 0, liftValue = 0, liftOriginY = 0;

  function renderKnob() {
    const radius = Math.max(0, (move.clientWidth - knob.offsetWidth) / 2 - 4);
    knob.style.transform = `translate(${vector[0] * radius}px, ${-vector[1] * radius}px)`;
  }
  function renderDial() { indicator.style.transform = `rotate(${-dialAngle}rad)`; }
  function liftRadius() { return Math.max(1, (lift.clientHeight - liftHandle.offsetHeight) / 2 - 30); }
  function renderLift() {
    liftHandle.style.transform = `translate(-50%, -50%) translateY(${-liftValue * liftRadius()}px)`;
    const percent = Math.round(liftValue * 100);
    lift.setAttribute('aria-valuenow', String(percent));
    lift.setAttribute('aria-valuetext', percent ? `${percent > 0 ? '升高' : '降低'}，速度 ${Math.abs(percent)}%` : '已停止');
    panel.dataset.lift = String(Math.sign(liftValue));
  }
  function begin(kind) {
    if (active) stop();
    // The editor may create a preview and update this panel synchronously.
    // Prepare it before acquiring the pointer so that initialization cannot end the new drag.
    if (actions.onStart?.(kind) === false || !enabled) return false;
    active = kind;
    panel.dataset.active = kind;
    return true;
  }
  function stop() {
    const ended = active, captured = captureElement, id = pointerId;
    active = null; pointerId = null; captureElement = null;
    win.cancelAnimationFrame(frame); frame = 0; lastTime = null;
    keys.clear(); vector = [0, 0]; lastAngle = null; dialAngle = 0; liftValue = 0;
    delete panel.dataset.active;
    renderKnob(); renderDial(); renderLift();
    if (captured && id !== null && captured.hasPointerCapture?.(id)) captured.releasePointerCapture(id);
    if (ended) actions.onEnd?.(ended);
  }
  function tick(time) {
    frame = 0;
    if (!active || !enabled) return;
    const dt = lastTime === null ? 0 : Math.min(.05, Math.max(0, (time - lastTime) / 1000));
    lastTime = time;
    if (dt) {
      if (active === 'move' && (vector[0] || vector[1])) actions.onMove?.(vector[0], vector[1], dt);
      if (active === 'lift' && liftValue && !wall) actions.onLift?.(liftValue, dt);
      if (active === 'rotate' && keys.size) {
        const direction = Number(keys.has('ArrowLeft')) - Number(keys.has('ArrowRight'));
        const delta = direction * Math.PI / 2 * dt;
        if (delta) { dialAngle += delta; renderDial(); actions.onRotate?.(delta); }
      }
    }
    if (active && enabled) frame = win.requestAnimationFrame(tick);
  }
  function startFrames() {
    if (!frame) { lastTime = null; frame = win.requestAnimationFrame(tick); }
  }
  function point(event, element) {
    const bounds = element.getBoundingClientRect();
    return [event.clientX - bounds.left - bounds.width / 2, bounds.top + bounds.height / 2 - event.clientY];
  }
  function movePointer(event) {
    const [x, y] = point(event, move);
    const length = Math.hypot(x, y), radius = move.clientWidth / 2 - 8;
    const magnitude = Math.min(1, length / radius), deadzone = .12;
    const speed = magnitude <= deadzone ? 0 : (magnitude - deadzone) / (1 - deadzone);
    vector = length ? [x / length * speed, y / length * speed] : [0, 0];
    renderKnob();
  }
  function rotatePointer(event, first = false) {
    const [x, y] = point(event, dial);
    if (Math.hypot(x, y) < dial.clientWidth * .16) { lastAngle = null; return; }
    const angle = Math.atan2(y, x);
    // atan2 wrapping must not turn a seam crossing into a full revolution.
    const delta = first || lastAngle === null ? 0 : Math.atan2(Math.sin(angle - lastAngle), Math.cos(angle - lastAngle));
    lastAngle = angle; dialAngle = angle - Math.PI / 2; renderDial();
    if (delta) actions.onRotate?.(delta);
  }
  function liftPointer(event) {
    const value = Math.max(-1, Math.min(1, (liftOriginY - event.clientY) / liftRadius()));
    const magnitude = Math.abs(value), deadzone = .08;
    liftValue = magnitude <= deadzone ? 0 : Math.sign(value) * (magnitude - deadzone) / (1 - deadzone);
    renderLift();
  }
  function wirePointer(element, kind) {
    element.addEventListener('pointerdown', event => {
      if (!enabled || (kind !== 'move' && wall) || event.button !== 0 || (active && pointerId !== null)) return;
      event.preventDefault(); event.stopPropagation();
      if (!begin(kind)) return;
      pointerId = event.pointerId; captureElement = element;
      element.setPointerCapture(pointerId); element.focus({preventScroll: true});
      if (kind === 'move') { movePointer(event); startFrames(); }
      else if (kind === 'rotate') rotatePointer(event, true);
      else { liftOriginY = event.clientY; liftValue = 0; renderLift(); startFrames(); }
    });
    element.addEventListener('pointermove', event => {
      if (pointerId !== event.pointerId || active !== kind) return;
      event.preventDefault(); event.stopPropagation();
      if (kind === 'move') movePointer(event); else if (kind === 'rotate') rotatePointer(event); else liftPointer(event);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) element.addEventListener(type, event => {
      if (pointerId !== event.pointerId || active !== kind) return;
      event.stopPropagation(); stop();
    });
    element.addEventListener('click', event => event.stopPropagation());
  }
  function updateKeyboardVector(kind) {
    if (kind === 'move') {
      const x = Number(keys.has('ArrowRight')) - Number(keys.has('ArrowLeft'));
      const y = Number(keys.has('ArrowUp')) - Number(keys.has('ArrowDown'));
      const length = Math.max(1, Math.hypot(x, y)); vector = [x / length, y / length]; renderKnob();
    } else if (kind === 'lift') {
      liftValue = Number(keys.has('ArrowUp')) - Number(keys.has('ArrowDown')); renderLift();
    }
  }
  function wireKeyboard(element, kind, accepted) {
    element.addEventListener('keydown', event => {
      if (!accepted.includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      if (!enabled || (kind !== 'move' && wall) || pointerId !== null) return;
      if (active !== kind && !begin(kind)) return;
      keys.add(event.key);
      updateKeyboardVector(kind);
      startFrames();
    });
    element.addEventListener('keyup', event => {
      if (!accepted.includes(event.key)) return;
      event.preventDefault(); event.stopPropagation(); keys.delete(event.key);
      if (!keys.size && active === kind && pointerId === null) stop();
      else if (active === kind) updateKeyboardVector(kind);
    });
    element.addEventListener('blur', () => { if (active === kind && pointerId === null) stop(); });
  }
  wirePointer(move, 'move'); wirePointer(dial, 'rotate');
  wirePointer(lift, 'lift');
  wireKeyboard(move, 'move', ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);
  wireKeyboard(dial, 'rotate', ['ArrowLeft', 'ArrowRight']);
  wireKeyboard(lift, 'lift', ['ArrowUp', 'ArrowDown']);
  surface.addEventListener('click', event => { event.stopPropagation(); if (enabled && wall) { stop(); actions.onSurface?.(); } });
  win.addEventListener('blur', stop);
  doc.addEventListener('visibilitychange', () => { if (doc.hidden) stop(); });

  // The mobile confirmation card can grow when details are opened. Reserve its
  // actual height, so neither pointer control covers the confirmation actions.
  const card = stage.querySelector('.rc-controls');
  function positionPanel() {
    const height = card && !card.hidden ? card.getBoundingClientRect().height : 0;
    panel.style.setProperty('--rc-card-height', `${height}px`);
  }
  if (win.ResizeObserver && card) new win.ResizeObserver(positionPanel).observe(card);

  return {
    setState(state) {
      const nextEnabled = !!state.enabled, nextWall = !!state.wall;
      if ((!nextEnabled || (nextWall && active !== 'move')) && active) stop();
      enabled = nextEnabled; wall = nextWall;
      panel.hidden = !(state.visible ?? enabled); panel.dataset.wall = String(wall);
      move.disabled = !enabled; dial.disabled = !enabled || wall; surface.disabled = !enabled;
      lift.disabled = !enabled || wall;
      landingHint.hidden = wall; surface.hidden = !wall;
      panel.querySelector('.rc-move-label').textContent = wall ? '沿墙移动' : '移动';
      panel.querySelector('.rc-rotate-label').textContent = wall ? '朝向随墙面' : '旋转';
      dial.title = wall ? '壁挂物的朝向随墙面，使用换墙调整' : '沿圆盘拖动旋转，也可使用左右方向键';
      const landing = typeof state.landing === 'string' ? state.landing : '';
      const landingText = landing ? `落点：${landing}` : '确认后落下';
      if (landingHint.textContent !== landingText) landingHint.textContent = landingText;
      landingHint.title = landingHint.textContent;
      lift.title = wall ? '壁挂物品使用左侧摇杆沿墙升降' : '上下拖动升降，松手即停；也可按住上下方向键';
      move.title = wall ? '拖动摇杆沿墙面左右、上下移动' : '拖动摇杆全向移动，使用右侧拉杆调整高度';
      positionPanel();
    },
    stop,
  };
}
