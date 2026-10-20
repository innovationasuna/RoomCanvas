/** 封面可点击开启；拖动达标后松手开启，短拉或中断沿弹簧曲线回位。 */
export function setupCoverPull(cover: HTMLElement, options: {
  canStart: () => boolean;
  open: () => void;
  reducedMotion: MediaQueryList;
}) {
  const cue = cover.querySelector<HTMLButtonElement>('#open-cover')!;
  const label = cue.querySelector<HTMLElement>('.pull-label')!;
  let offset = 0, spring: Animation | undefined, suppressClick = false;
  let drag: {id: number; capture: HTMLElement; x: number; y: number; base: number; distance: number; limit: number; active: boolean} | undefined;

  function displayedOffset() {
    const transform = getComputedStyle(cover).transform;
    return transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m41;
  }
  function stopSpring() {
    spring?.cancel(); spring = undefined;
    cover.classList.remove('is-rebounding');
  }
  function resetHint() {
    cover.style.setProperty('--pull-progress', '0');
    cover.classList.remove('is-pulling', 'is-pull-ready');
    label.textContent = '左拉开启';
  }
  function releasePointer() {
    const previous = drag; drag = undefined;
    if (previous?.capture.hasPointerCapture(previous.id)) previous.capture.releasePointerCapture(previous.id);
  }
  function reset() {
    releasePointer(); stopSpring(); resetHint();
    offset = 0; suppressClick = false; cover.style.transform = '';
  }
  function settle() {
    const from = offset;
    stopSpring(); resetHint(); offset = 0; cover.style.transform = '';
    if (!from || options.reducedMotion.matches) return;
    // 阻尼振荡，初始速度为零；少量越过原位，再平稳收束。
    const frames = Array.from({length: 41}, (_, index) => {
      const t = index / 40;
      const value = index === 40 ? 0 : from * Math.exp(-7 * t) * (Math.cos(10 * t) + .7 * Math.sin(10 * t));
      return {transform: `translateX(${value}px)`, offset: t};
    });
    cover.classList.add('is-rebounding');
    const animation = cover.animate(frames, {duration: 620, easing: 'linear'});
    spring = animation;
    void animation.finished.then(() => {
      if (spring === animation) {spring = undefined; cover.classList.remove('is-rebounding');}
    }).catch(() => {});
  }
  function move(dx: number) {
    if (!drag) return;
    const travel = Math.max(0, -dx), progress = Math.min(1, travel / drag.distance);
    // 位移小于手的行程，越往外拉阻力越明显；反方向只允许轻微形变。
    offset = drag.base + (dx > 0 ? 28 * (1 - Math.exp(-dx / 120)) : -drag.limit * (1 - Math.exp(-travel / drag.limit)));
    cover.style.transform = `translateX(${offset}px)`;
    cover.style.setProperty('--pull-progress', String(progress));
    cover.classList.toggle('is-pull-ready', progress >= 1);
    label.textContent = progress >= 1 ? '松手开启' : '继续左拉';
  }

  cue.addEventListener('click', event => {
    event.preventDefault();
    // 阻止拖动结束后合成的鼠标点击；键盘及辅助技术激活仍可直接开启。
    if (!options.canStart() || (suppressClick && event.detail !== 0)) return;
    options.open();
  });
  cover.addEventListener('pointerdown', event => {
    if (!options.canStart() || drag || !event.isPrimary || event.button !== 0) return;
    const base = displayedOffset(); stopSpring(); suppressClick = false;
    offset = base; cover.style.transform = `translateX(${base}px)`;
    const capture = cue.contains(event.target as Node) ? cue : cover;
    drag = {id: event.pointerId, capture, x: event.clientX, y: event.clientY, base,
      distance: innerWidth / 8, limit: innerWidth * 1.25, active: false};
    // 立即捕获，快速移出封面或缺少 pointermove 时也能收到松手；手柄保持点击目标。
    capture.setPointerCapture(event.pointerId);
  });
  cover.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.active && Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) {suppressClick = true; releasePointer(); settle(); return;}
    if (!drag.active && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
      drag.active = true; cover.classList.add('is-pulling');
    }
    if (drag.active) move(dx);
  });
  function finish(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    // 浏览器可能合并移动事件；松手坐标本身也可以建立一次有效的水平拖动。
    if (event.type === 'pointerup' && !drag.active && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) drag.active = true;
    if (drag.active && event.type === 'pointerup') move(dx);
    const completed = event.type === 'pointerup' && drag.active && -dx >= drag.distance;
    suppressClick = drag.active || Math.hypot(dx, dy) > 8 || event.type !== 'pointerup';
    releasePointer(); resetHint();
    if (completed && options.canStart()) options.open(); else settle();
  }
  cover.addEventListener('pointerup', finish);
  cover.addEventListener('pointercancel', finish);
  cover.addEventListener('lostpointercapture', finish);
  window.addEventListener('blur', () => {if (drag) {releasePointer(); settle();}});
  return {reset, takeOffset() {const value = displayedOffset(); reset(); return value;}};
}
