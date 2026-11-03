import test from 'node:test';
import assert from 'node:assert/strict';
import {createPanelCoordinator} from '../workspace-panels.mjs';
import {mountWarehouseDrawer} from '../warehouse-drawer.mjs';

function panels() {
  const visible = {library: false, gesture: false, environment: false, tools: false};
  const coordinator = createPanelCoordinator(Object.fromEntries(Object.keys(visible).map(name => [name, () => {
    visible[name] = false;
    coordinator.setOpen(name, false);
  }])));
  return {visible, coordinator, open(name) {visible[name] = true; coordinator.setOpen(name, true);}};
}

test('switching between any two rail panels leaves only the latest panel visible', () => {
  const p = panels();
  for (const first of Object.keys(p.visible)) for (const second of Object.keys(p.visible)) {
    p.open(first); p.open(second);
    assert.deepEqual(Object.keys(p.visible).filter(name => p.visible[name]), [second]);
    assert.equal(p.coordinator.active, second);
  }
});

test('late close events and a failed camera start do not dismiss the newer panel', () => {
  const p = panels();
  p.open('gesture'); p.open('environment');
  p.coordinator.setOpen('gesture', false);
  assert.equal(p.coordinator.active, 'environment');
  assert.equal(p.visible.environment, true);
  p.open('library');
  p.coordinator.setOpen('environment', false);
  assert.equal(p.coordinator.active, 'library');
  p.coordinator.setOpen('library', false);
  assert.equal(p.coordinator.active, null);
});

test('programmatic library opens and toolbar clicks both coordinate with other panels', () => {
  const previousDocument = globalThis.document;
  globalThis.document = {activeElement: null};
  const element = () => {
    const events = new Map();
    return {hidden: true, attributes: {}, contains: () => false, focus() {},
      classList: {toggle() {}}, setAttribute(key, value) {this.attributes[key] = value;},
      addEventListener(name, callback) {events.set(name, callback);},
      click() {events.get('click')?.();},
    };
  };
  try {
    const panel = element(), content = element(), toggle = element(), close = element();
    let gestureVisible = true, drawer;
    const coordinator = createPanelCoordinator({
      library: () => drawer?.setOpen(false),
      gesture: () => {gestureVisible = false; coordinator.setOpen('gesture', false);},
    });
    drawer = mountWarehouseDrawer({panel, content, toggle, close, onOpenChange: open => coordinator.setOpen('library', open)});
    coordinator.setOpen('gesture', true);
    drawer.setOpen(true); // The search shortcut, density switch and hand controls use this path.
    assert.equal(gestureVisible, false);
    assert.equal(panel.hidden, false);
    assert.equal(content.hidden, false);
    assert.equal(toggle.attributes['aria-expanded'], 'true');
    gestureVisible = true; coordinator.setOpen('gesture', true);
    assert.equal(panel.hidden, true);
    assert.equal(toggle.attributes['aria-expanded'], 'false');
    toggle.click();
    assert.equal(gestureVisible, false);
    assert.equal(panel.hidden, false);
    close.click();
    assert.equal(panel.hidden, true);
    assert.equal(coordinator.active, null);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
