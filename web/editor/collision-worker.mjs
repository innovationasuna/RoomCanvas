// The full collision checks of a drop, off the page's thread: the piano beside its stool takes
// a second or more, which would freeze the room and the hand. Same code and same triangles as
// the page's own collision (collision.mjs), so the answers are the same.
import {buildCollision, unpackOwners, collisionIndexes} from './collision.mjs';

let collision = null;
let owners = new Map(), generation = 0;
self.onmessage = ({data}) => {
  if (data.type === 'build' || data.type === 'update') {
    if (data.generation <= generation) return;
    generation = data.generation;
    if (data.type === 'build') owners = new Map();
    for (const id of data.removed || []) owners.delete(id);
    const changed = unpackOwners(data.owners);
    for (const owner of changed) owners.set(owner.id, owner);
    // In the page's order, so both name the same obstacle when a move meets several.
    collision = buildCollision(data.order.map((id) => owners.get(id)), {keepAuthoredOverlaps: data.keepAuthoredOverlaps});
    self.postMessage({type: 'built', generation, audit: collision.audit,
      indexes: collisionIndexes(data.indexIds ? data.indexIds.map((id) => owners.get(id)) : changed)});
  } else if (data.type === 'drop' && collision && data.generation === generation) {
    const contact = collision.checkPlacement(data.candidate, data.moved);
    const sweep = contact.ok ? collision.limit(data.source, data.candidate, data.moved) : null;
    self.postMessage({type: 'drop', ticket: data.ticket, generation: data.generation,
      contact: {ok: contact.ok, other: contact.other}, sweep: sweep && {blocked: sweep.blocked, fraction: sweep.fraction, other: sweep.other}});
  }
};
