// A bottom drawer with one reserved handle row: opening it never resizes the room canvas.
export function mountWarehouseDrawer({panel, content, handle, toggle, close, hint}) {
  let open = false, drag = null, ignoreClick = false;
  function setOpen(next) {
    open = !!next;
    if (!open && content.contains(document.activeElement)) handle.focus({preventScroll: true});
    panel.classList.toggle('open', open);
    content.hidden = !open;
    for (const button of [handle, toggle]) button.setAttribute('aria-expanded', String(open));
    handle.setAttribute('aria-label', open ? '收起仓库' : '展开仓库');
    hint.textContent = open ? '下拉收起' : '上拉展开';
  }
  handle.addEventListener('click', event => {
    // Pointer drags also produce a click. Keyboard and hand-gesture clicks still work.
    if (ignoreClick && event.detail !== 0) {ignoreClick = false; return;}
    setOpen(!open);
  });
  toggle.addEventListener('click', () => setOpen(!open));
  close.addEventListener('click', () => setOpen(false));
  panel.addEventListener('keydown', event => {
    if (event.key === 'Escape' && open) {
      event.preventDefault(); event.stopPropagation(); setOpen(false);
    }
  });
  handle.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    ignoreClick = false;
    drag = {id: event.pointerId, x: event.clientX, y: event.clientY};
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener('pointerup', event => {
    if (drag?.id !== event.pointerId) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    ignoreClick = Math.hypot(dx, dy) > 8;
    if (Math.abs(dy) >= 24 && Math.abs(dy) > Math.abs(dx)) setOpen(dy < 0);
    drag = null;
  });
  handle.addEventListener('lostpointercapture', () => {drag = null;});
  handle.addEventListener('pointercancel', () => {drag = null; ignoreClick = false;});
  setOpen(false);
  return {setOpen};
}
