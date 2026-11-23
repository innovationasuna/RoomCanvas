import {createPlacement} from './placement.mjs';
import {collisionOwners, buildCollision, installCollisionIndexes} from './collision.mjs';
import {createCollisionClient} from './collision-client.mjs';
import {createRayQueries} from './ray-queries.mjs';

// Owns derived scene indexes and the Worker lifetime. Layout/session/UI state stays
// with the editor; changes to membership refresh only the affected geometry.
export function createSceneGeometry(THREE, {room, entities, specs, floorY, ceilingY, openings, label,
  worker = () => new Worker(new URL('./collision-worker.mjs', import.meta.url), {type: 'module'}),
  startStage = () => null, finishStage = () => {}, onError = console.error}) {
  let placement = null, collision = null, queries = null, background = null, revision = 0, disposed = false;
  let indexedOwners = new Set();
  return {
    rebuildPlacement(operation) {
      const started = startStage();
      placement = createPlacement(THREE, room, entities, specs, floorY, ceilingY, {openings});
      finishStage(operation, 'placement', started);
      return placement;
    },
    async rebuildCollision(operation) {
      if (disposed) return null;
      const current = ++revision;
      const geometryStarted = startStage();
      // The floor needs a ray index too; include it in the Worker build but not
      // furniture collision. Otherwise ray queries would silently build it here.
      const owners = collisionOwners(THREE, room, entities, {label, includeQueryOnly: true});
      finishStage(operation, 'collisionGeometry', geometryStarted);
      try {
        // Removing an owner needs no new index. Do not wait behind an obsolete
        // Worker drop check when every remaining mesh is already installed.
        const installed = background && !background.failed && owners.every((owner) => indexedOwners.has(owner));
        const submitStarted = startStage();
        if (background?.failed) {background.dispose(); background = null;}
        background ||= createCollisionClient(worker(), onError);
        const built = background.update(owners);
        finishStage(operation, 'collisionWorkerSubmit', submitStarted);
        if (!installed) {
          const result = await built;
          if (disposed || current !== revision) return null;
          if (!result) throw new Error('Collision Worker did not build an index');
          const installStarted = startStage();
          installCollisionIndexes(owners, result.indexes);
          finishStage(operation, 'collisionIndexInstall', installStarted);
        }
      } catch (error) {
        if (disposed || current !== revision) return null;
        if (!background?.failed) onError(error);
        background?.dispose(); background = null;
      }
      // In the normal path this only attaches cached indexes. A Worker failure
      // falls back to a local build, keeping the same collision rules available.
      const buildStarted = startStage();
      collision = buildCollision(owners, {keepAuthoredOverlaps: true});
      if (queries) queries.rebuild(owners); else queries = createRayQueries(THREE, room, owners);
      indexedOwners = new Set(owners);
      finishStage(operation, 'collisionMainBuild', buildStarted);
      return {collision, queries, background};
    },
    dispose() {disposed = true; revision++; indexedOwners.clear(); background?.dispose(); background = null;},
  };
}
