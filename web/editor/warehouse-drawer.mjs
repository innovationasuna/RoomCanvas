// The toolbar opens this overlay; a closed warehouse reserves no canvas space.
export function mountWarehouseDrawer({panel, content, toggle, close}) {
  let open = false;
  function setOpen(next) {
    open = !!next;
    if (!open && content.contains(document.activeElement)) toggle.focus({preventScroll: true});
    panel.classList.toggle('open', open);
    panel.hidden = !open;
    content.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  }
  toggle.addEventListener('click', () => setOpen(!open));
  close.addEventListener('click', () => setOpen(false));
  panel.addEventListener('keydown', event => {
    if (event.key === 'Escape' && open) {
      event.preventDefault(); event.stopPropagation(); setOpen(false);
    }
  });
  setOpen(false);
  return {setOpen};
}
