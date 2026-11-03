// Small content changes never delay application state, camera rendering or input handling.
export function createContentMotion(preference = matchMedia('(prefers-reduced-motion: reduce)')) {
  const running = new Map();
  const cancel = () => {for (const animation of running.values()) animation.cancel(); running.clear();};
  preference.addEventListener('change', cancel);
  return {
    refresh(elements) {
      for (const element of elements) {
        running.get(element)?.cancel(); running.delete(element);
        if (preference.matches || !element.animate) continue;
        const animation = element.animate([
          {opacity:.55, translate:'0 4px'}, {opacity:1, translate:'0 0'},
        ], {duration:180, easing:'cubic-bezier(.22,1,.36,1)'});
        running.set(element, animation);
        const finished = () => {if (running.get(element) === animation) running.delete(element);};
        animation.finished.then(finished, finished);
      }
    },
    dispose() {cancel(); preference.removeEventListener('change', cancel);},
  };
}
