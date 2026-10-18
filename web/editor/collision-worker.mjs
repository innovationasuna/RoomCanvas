// The full collision checks of a drop, off the page's thread: the piano beside its stool takes
// a second or more, which would freeze the room and the hand. Same code and same triangles as
// the page's own collision (collision.mjs), so the answers are the same.
import {buildCollision, unpackOwners} from './collision.mjs';

let collision = null;
self.onmessage = ({data}) => {
  if (data.type === 'build') {
    collision = buildCollision(unpackOwners(data.owners), {keepAuthoredOverlaps: data.keepAuthoredOverlaps});
    self.postMessage({type: 'built', generation: data.generation});
  } else if (data.type === 'drop' && collision) {
    const contact = collision.checkPlacement(data.candidate, data.moved);
    const sweep = contact.ok ? collision.limit(data.source, data.candidate, data.moved) : null;
    self.postMessage({type: 'drop', ticket: data.ticket, generation: data.generation,
      contact: {ok: contact.ok, other: contact.other}, sweep: sweep && {blocked: sweep.blocked, fraction: sweep.fraction, other: sweep.other}});
  }
};
