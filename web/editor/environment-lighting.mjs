import {PMREMGenerator} from 'three';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';

// One neutral, small prefiltered environment for every room. This is a generic reflection
// source, not an estimate of the scanned room's actual illumination; keep its contribution modest.
export function createEnvironmentLighting(renderer, scene, {intensity: contribution = .18} = {}) {
  if (scene.environment) return {dispose() {}, snapshot: () => ({state: 'existing'})};
  if (!renderer.extensions.has('EXT_color_buffer_float')) return {dispose() {}, snapshot: () => ({state: 'unsupported'})};
  const source = new RoomEnvironment(), generator = new PMREMGenerator(renderer);
  const previous = scene.environment, intensity = scene.environmentIntensity;
  let target;
  try {
    target = generator.fromScene(source, .04, .1, 100, {size: 128});
    scene.environment = target.texture;
    scene.environmentIntensity = contribution;
  } finally {source.dispose(); generator.dispose();}
  return {
    dispose() {scene.environment = previous; scene.environmentIntensity = intensity; target.dispose();},
    snapshot: () => ({state: 'ready', size: 128, intensity: contribution}),
  };
}
