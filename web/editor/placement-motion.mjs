import {wallBasis} from './layout.mjs';

// Analog input keeps its diagonal direction and magnitude; wall input replaces
// floor-forward with vertical movement while preserving camera-relative right.
export function analogDelta(x, y, distance, axes, tangent = null) {
  const frame = tangent ? wallBasis(tangent, axes) : axes;
  return {x: distance * (x * frame.right.x + (tangent ? 0 : y * frame.forward.x)),
    y: tangent ? distance * y : 0,
    z: distance * (x * frame.right.z + (tangent ? 0 : y * frame.forward.z))};
}
