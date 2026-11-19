import {createPlacement} from './placement.mjs';
import {collisionOwners, buildCollision} from './collision.mjs';
import {createCollisionClient} from './collision-client.mjs';
import {createRayQueries} from './ray-queries.mjs';

// Owns derived scene indexes and the Worker lifetime. Layout/session/UI state stays
// with the editor; changes to membership refresh only the affected geometry.
export function createSceneGeometry(THREE, {room, entities, specs, floorY, ceilingY, openings, label,
  worker = () => new Worker(new URL('./collision-worker.mjs', import.meta.url), {type: 'module'}),
  startStage = () => null, finishStage = () => {}, onError = console.error}) {
  let placement = null, collision = null, queries = null, background = null;
  return {
    rebuildPlacement(operation) {
      const started = startStage();
      placement = createPlacement(THREE, room, entities, specs, floorY, ceilingY, {openings});
      finishStage(operation, 'placement', started);
      return placement;
    },
    rebuildCollision(operation) {
      const geometryStarted = startStage();
      const owners = collisionOwners(THREE, room, entities, {label});
      finishStage(operation, 'collisionGeometry', geometryStarted);
      const buildStarted = startStage();
      collision = buildCollision(owners, {keepAuthoredOverlaps: true});
      if (queries) queries.rebuild(owners); else queries = createRayQueries(THREE, room, owners);
      finishStage(operation, 'collisionMainBuild', buildStarted);
      try {
        const submitStarted = startStage();
        if (background?.failed) {background.dispose(); background = null;}
        background ||= createCollisionClient(worker(), onError);
        background.update(owners);
        finishStage(operation, 'collisionWorkerSubmit', submitStarted);
      } catch (error) {onError(error); background?.dispose(); background = null;}
      return {collision, queries, background};
    },
    dispose() {background?.dispose(); background = null;},
  };
}
