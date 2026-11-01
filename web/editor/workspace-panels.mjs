// Only one left-side workspace panel is visible. Hiding a panel never stops its feature.
export function createPanelCoordinator(hide) {
  let active = null;
  return {
    get active() {return active;},
    setOpen(name, open) {
      if (!Object.hasOwn(hide, name)) throw new Error(`Unknown workspace panel: ${name}`);
      if (!open) {
        if (active === name) active = null;
        return;
      }
      // A synchronous close callback from the previous panel must not clear the new one.
      active = name;
      for (const [other, close] of Object.entries(hide)) if (other !== name) close();
    },
  };
}
