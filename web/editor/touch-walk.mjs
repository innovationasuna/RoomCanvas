// Pointer capture + all cancellation paths keep a finger leaving the pad from sticking movement.
export function bindTouchWalk(root, walk) {
  const pointers = new Map();
  const release = event => {
    const code = pointers.get(event.pointerId);
    if (code) {pointers.delete(event.pointerId); if (![...pointers.values()].includes(code)) walk.hold(code, false);}
  };
  const stop = () => {pointers.clear(); walk.stop();};
  const cleanup = [];
  function listen(target, type, fn) {target.addEventListener(type, fn); cleanup.push(() => target.removeEventListener(type, fn));}
  for (const button of root.querySelectorAll('[data-walk-key]')) {
    listen(button, 'pointerdown', event => {
      event.preventDefault(); button.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, button.dataset.walkKey); walk.hold(button.dataset.walkKey, true);
    });
    listen(button, 'pointermove', event => {
      const r = button.getBoundingClientRect();
      if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) release(event);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) listen(button, type, release);
  }
  listen(window, 'blur', stop);
  listen(document, 'visibilitychange', () => {if (document.hidden) stop();});
  return () => {stop(); cleanup.forEach(fn => fn());};
}
