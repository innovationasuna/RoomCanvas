// Remove one local imported instance, preserving the room's original furniture and other imports.
// Prune old snapshots as well, so undo/redo cannot reference geometry that has been released.
export function forgetImportedObject(id, {entities, ids, layout, placementSpecs, history}) {
  const entity = entities.get(id);
  if (!entity?.added) return null;
  entities.delete(id);
  const index = ids.indexOf(id);
  if (index !== -1) ids.splice(index, 1);
  delete layout[id];
  delete placementSpecs[id];
  for (const snapshot of [...history.past, ...history.future]) delete snapshot[id];
  return entity;
}
