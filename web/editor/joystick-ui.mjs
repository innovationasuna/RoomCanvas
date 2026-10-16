// Input controls only. Placement, collision and commit decisions stay in the editor.
export function mountJoysticks(stage, actions) {
  const doc = stage.ownerDocument;
  const panel = doc.createElement('section');
  panel.className = 'rc-joysticks';
  panel.setAttribute('aria-label', '移动和旋转家具');
  panel.hidden = true;
  panel.innerHTML = `
    <div class="rc-joystick-control">
      <button type="button" class="rc-move-stick" aria-label="移动摇杆，方向键移动家具">
        <span class="rc-stick-axis rc-stick-axis-x" aria-hidden="true"></span>
        <span class="rc-stick-axis rc-stick-axis-y" aria-hidden="true"></span>
        <span class="rc-stick-knob" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 4v16M4 12h16M9 7l3-3 3 3M9 17l3 3 3-3M7 9l-3 3 3 3M17 9l3 3-3 3"/></svg></span>
      </button>
      <span class="rc-joystick-label rc-move-label">移动</span>
    </div>
    <div class="rc-joystick-control">
      <button type="button" class="rc-rotate-dial" aria-label="旋转圆盘，左右方向键旋转家具">
        <span class="rc-dial-pointer" aria-hidden="true"></span>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 8a8 8 0 1 0 1 8M19 3v5h-5"/></svg>
      </button>
      <span class="rc-joystick-label rc-rotate-label">旋转</span>
    </div>
    <div class="rc-lift-row">
      <button type="button" class="rc-lift-button rc-lift-up" aria-label="按住升高家具">升高 ↑</button>
      <button type="button" class="rc-lift-button rc-lift-down" aria-label="按住降低家具">降低 ↓</button>
    </div>
    <span class="rc-landing-hint" aria-live="polite"></span>
    <button type="button" class="rc-surface-button" hidden>换墙</button>`;
  stage.append(panel);
  const move = panel.querySelector('.rc-move-stick');
  const knob = panel.querySelector('.rc-stick-knob');
  const dial = panel.querySelector('.rc-rotate-dial');
  const indicator = panel.querySelector('.rc-dial-pointer');
  const surface = panel.querySelector('.rc-surface-button');
  const liftRow = panel.querySelector('.rc-lift-row');
  const liftUp = panel.querySelector('.rc-lift-up');
  const liftDown = panel.querySelector('.rc-lift-down');
  const landingHint = panel.querySelector('.rc-landing-hint');
  const win = doc.defaultView;
  const keys = new Set();
  let enabled = false, wall = false, active = null, pointerId = null, captureElement = null;
  let vector = [0, 0], frame = 0, lastTime = null, lastAngle = null, dialAngle = 0, liftSign = 0;

  function renderKnob() {
    const radius = Math.max(0, (move.clientWidth - knob.offsetWidth) / 2 - 4);
    knob.style.transform = `translate(${vector[0] * radius}px, ${-vector[1] * radius}px)`;
  }
  function renderDial() { indicator.style.transform = `rotate(${-dialAngle}rad)`; }
  function begin(kind) {
    if (active) stop();
    active = kind;
    panel.dataset.active = kind;
    actions.onStart?.(kind);
  }
  function stop() {
    const ended = active, captured = captureElement, id = pointerId;
    active = null; pointerId = null; captureElement = null;
    win.cancelAnimationFrame(frame); frame = 0; lastTime = null;
    keys.clear(); vector = [0, 0]; lastAngle = null; dialAngle = 0; liftSign = 0;
    delete panel.dataset.active;
    delete panel.dataset.lift;
    renderKnob(); renderDial();
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
      if (active === 'lift' && liftSign && !wall) actions.onLift?.(liftSign, dt);
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
  function wirePointer(element, kind, liftDirection = 0) {
    element.addEventListener('pointerdown', event => {
      if (!enabled || (kind !== 'move' && wall) || event.button !== 0 || (active && pointerId !== null)) return;
      event.preventDefault(); event.stopPropagation();
      begin(kind);
      if (!enabled || active !== kind) return;
      pointerId = event.pointerId; captureElement = element;
      element.setPointerCapture(pointerId); element.focus({preventScroll: true});
      if (kind === 'move') { movePointer(event); startFrames(); }
      else if (kind === 'rotate') rotatePointer(event, true);
      else { liftSign = liftDirection; panel.dataset.lift = String(liftSign); actions.onLift?.(liftSign, .075); startFrames(); }
    });
    element.addEventListener('pointermove', event => {
      if (pointerId !== event.pointerId || active !== kind) return;
      event.preventDefault(); event.stopPropagation();
      if (kind === 'move') movePointer(event); else if (kind === 'rotate') rotatePointer(event);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) element.addEventListener(type, event => {
      if (pointerId !== event.pointerId || active !== kind) return;
      event.stopPropagation(); stop();
    });
    element.addEventListener('click', event => event.stopPropagation());
  }
  function wireKeyboard(element, kind, accepted, liftDirection = 0) {
    element.addEventListener('keydown', event => {
      if (!accepted.includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      if (!enabled || (kind !== 'move' && wall) || pointerId !== null) return;
      if (active !== kind) begin(kind);
      if (!enabled || active !== kind) return;
      const firstPress = !keys.size;
      keys.add(event.key);
      if (kind === 'move') {
        const x = Number(keys.has('ArrowRight')) - Number(keys.has('ArrowLeft'));
        const y = Number(keys.has('ArrowUp')) - Number(keys.has('ArrowDown'));
        const length = Math.max(1, Math.hypot(x, y)); vector = [x / length, y / length]; renderKnob();
      }
      if (kind === 'lift') { liftSign = liftDirection; panel.dataset.lift = String(liftSign); if (firstPress) actions.onLift?.(liftSign, .075); }
      startFrames();
    });
    element.addEventListener('keyup', event => {
      if (!accepted.includes(event.key)) return;
      event.preventDefault(); event.stopPropagation(); keys.delete(event.key);
      if (!keys.size && active === kind && pointerId === null) stop();
      else if (kind === 'move') {
        const x = Number(keys.has('ArrowRight')) - Number(keys.has('ArrowLeft'));
        const y = Number(keys.has('ArrowUp')) - Number(keys.has('ArrowDown'));
        const length = Math.max(1, Math.hypot(x, y)); vector = [x / length, y / length]; renderKnob();
      }
    });
    element.addEventListener('blur', () => { if (active === kind && pointerId === null) stop(); });
  }
  wirePointer(move, 'move'); wirePointer(dial, 'rotate');
  wirePointer(liftUp, 'lift', 1); wirePointer(liftDown, 'lift', -1);
  wireKeyboard(move, 'move', ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);
  wireKeyboard(dial, 'rotate', ['ArrowLeft', 'ArrowRight']);
  wireKeyboard(liftUp, 'lift', [' ', 'Enter'], 1); wireKeyboard(liftDown, 'lift', [' ', 'Enter'], -1);
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
      panel.hidden = !enabled; panel.dataset.wall = String(wall);
      move.disabled = !enabled; dial.disabled = !enabled || wall; surface.disabled = !enabled;
      liftUp.disabled = liftDown.disabled = !enabled || wall;
      liftRow.hidden = wall; landingHint.hidden = wall; surface.hidden = !wall;
      panel.querySelector('.rc-move-label').textContent = wall ? '沿墙移动' : '移动';
      panel.querySelector('.rc-rotate-label').textContent = wall ? '朝向随墙面' : '旋转';
      dial.title = wall ? '壁挂物的朝向随墙面，使用换墙调整' : '沿圆盘拖动旋转，也可使用左右方向键';
      const landing = typeof state.landing === 'string' ? state.landing : '';
      const landingText = landing ? `落点：${landing}` : '确认后落下';
      if (landingHint.textContent !== landingText) landingHint.textContent = landingText;
      landingHint.title = landingHint.textContent;
      liftUp.title = '按住升高家具，也可按住空格或回车';
      liftDown.title = '按住降低家具，也可按住空格或回车';
      move.title = wall ? '拖动摇杆沿墙面左右、上下移动' : '拖动摇杆全向移动，使用升高和降低调整高度';
      positionPanel();
    },
    stop,
  };
}
