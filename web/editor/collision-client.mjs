import {packOwners} from './collision.mjs';

// Owns index generations and the single-flight drop queue. Every superseded or
// failed request settles, so stale Worker replies cannot confirm a newer layout.
export function createCollisionClient(worker, onError = console.error) {
  let generation = 0, tickets = 0, ready = false, failed = false, busy = null, queued = null, previous = new Map();
  function cancel() {
    busy?.resolve(null); queued?.resolve(null);
    busy = queued = null;
  }
  function send() {
    if (!ready || busy || !queued) return;
    busy = queued; queued = null;
    const {ticket, candidate, moved, source} = busy;
    worker.postMessage({type: 'drop', generation, ticket, candidate, moved, source});
  }
  worker.onmessage = ({data}) => {
    if (data.generation !== generation) return;
    if (data.type === 'built') {ready = true; send(); return;}
    if (data.type !== 'drop' || data.ticket !== busy?.ticket) return;
    busy.resolve(data); busy = null; send();
  };
  worker.onerror = (error) => {ready = false; failed = true; cancel(); onError(error);};
  return {
    get ready() {return ready;},
    get failed() {return failed;},
    get generation() {return generation;},
    update(owners) {
      const current = new Map(owners.map((owner) => [owner.id, owner]));
      const changed = owners.filter((owner) => previous.get(owner.id) !== owner);
      const removed = [...previous.keys()].filter((id) => !current.has(id));
      const {owners: packed, transfer} = packOwners(changed);
      generation++; ready = false; cancel();
      worker.postMessage({type: generation === 1 ? 'build' : 'update', generation, owners: packed, removed, order: owners.map((owner) => owner.id), keepAuthoredOverlaps: true}, transfer);
      previous = current;
    },
    request(candidate, moved, source) {
      queued?.resolve(null);
      return new Promise((resolve) => {queued = {ticket: ++tickets, candidate, moved, source, resolve}; send();});
    },
    dispose() {ready = false; cancel(); previous.clear(); worker.terminate();},
  };
}
