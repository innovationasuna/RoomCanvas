import {packOwners} from './collision.mjs';

// Owns index generations and the single-flight drop queue. Every superseded or
// failed request settles, so stale Worker replies cannot confirm a newer layout.
export function createCollisionClient(worker, onError = console.error) {
  let generation = 0, tickets = 0, ready = false, failed = false, disposed = false, building = null, busy = null, queued = null, previous = new Map();
  const indexes = new Map();
  function cancel() {
    busy?.resolve(null); queued?.resolve(null);
    busy = queued = null;
  }
  function cancelBuild() {building?.resolve(null); building = null;}
  function fail(error) {
    if (disposed || failed) return;
    ready = false; failed = true; cancel(); cancelBuild(); onError(error);
  }
  function send() {
    if (!ready || busy || !queued) return;
    busy = queued; queued = null;
    const {ticket, candidate, moved, source} = busy;
    try {worker.postMessage({type: 'drop', generation, ticket, candidate, moved, source});} catch (error) {fail(error);}
  }
  worker.onmessage = ({data}) => {
    if (disposed || failed || data.generation !== generation) return;
    if (data.type === 'error') {fail(new Error(data.message)); return;}
    if (data.type === 'built') {
      if (!building) return;
      for (const index of data.indexes || []) {
        const owner = building.owners.get(index.id);
        if (owner) indexes.set(index.id, {owner, index});
      }
      ready = true;
      // Keep received buffers until the caller can install them. A newer update
      // can supersede this Promise before its continuation runs.
      building.resolve({...data, indexes: [...building.owners.values()].flatMap((owner) => {
        const cached = indexes.get(owner.id);
        return cached?.owner === owner ? [cached.index] : [];
      })});
      building = null; send(); return;
    }
    if (data.type !== 'drop' || data.ticket !== busy?.ticket) return;
    busy.resolve(data); busy = null; send();
  };
  worker.onerror = fail;
  worker.onmessageerror = fail;
  return {
    get ready() {return ready;},
    get failed() {return failed;},
    get generation() {return generation;},
    update(owners) {
      if (disposed || failed) return Promise.resolve(null);
      const current = new Map(owners.map((owner) => [owner.id, owner]));
      const changed = owners.filter((owner) => previous.get(owner.id) !== owner);
      const removed = [...previous.keys()].filter((id) => !current.has(id));
      generation++; ready = false; cancel(); cancelBuild();
      for (const [id, cached] of indexes) if (current.get(id) !== cached.owner) indexes.delete(id);
      const completed = new Promise((resolve) => {building = {resolve, owners: current};});
      try {
        const {owners: packed, transfer} = packOwners(changed);
        // A superseded initial build may never have delivered its buffers. Ask
        // for those cached Worker indexes again, without rebuilding geometry.
        const indexIds = owners.filter((owner) => !indexes.has(owner.id)).map((owner) => owner.id);
        worker.postMessage({type: generation === 1 ? 'build' : 'update', generation, owners: packed, removed, order: owners.map((owner) => owner.id), indexIds, keepAuthoredOverlaps: true}, transfer);
        previous = current;
      } catch (error) {fail(error);}
      return completed;
    },
    request(candidate, moved, source) {
      if (disposed || failed) return Promise.resolve(null);
      queued?.resolve(null);
      return new Promise((resolve) => {queued = {ticket: ++tickets, candidate, moved, source, resolve}; send();});
    },
    dispose() {disposed = true; ready = false; cancel(); cancelBuild(); previous.clear(); indexes.clear(); worker.terminate();},
  };
}
