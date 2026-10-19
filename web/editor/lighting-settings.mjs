// Fit the existing directional light's orthographic shadow camera, in light-view metres.
// Keep a margin for contact details; very large rooms crossing the light plane retain the original setup.
export function shadowSettings(corners, resolution = 2048) {
  if (corners.length !== 8 || corners.some(p => p.some(v => !Number.isFinite(v))) || !Number.isFinite(resolution) || resolution <= 0) return null;
  const min = [0, 1, 2].map(axis => Math.min(...corners.map(p => p[axis])));
  const max = [0, 1, 2].map(axis => Math.max(...corners.map(p => p[axis])));
  const margin = Math.max(.1, Math.max(max[0] - min[0], max[1] - min[1]) * .05);
  if (max[2] >= -.1) return null;
  const camera = {left: min[0] - margin, right: max[0] + margin, bottom: min[1] - margin, top: max[1] + margin,
    near: Math.max(.01, -max[2] - margin), far: Math.max(.02, -min[2] + margin)};
  const texel = Math.max(camera.right - camera.left, camera.top - camera.bottom) / resolution;
  return {camera, bias: -Math.min(.001, texel * .25 / (camera.far - camera.near)), normalBias: Math.min(.02, Math.max(.002, texel))};
}
