# Three.js addons

These source files are from `mrdoob/three.js` tag **r180**, matching the vendored core (`three@0.180.0`). They are used under the MIT license at [`../../LICENSE`](../../LICENSE).

Common environment and static lighting dependencies:

- `exporters/GLTFExporter.js` (complete mobile room snapshots, also pinned to r180)

- `lights/RectAreaLightUniformsLib.js` and `lights/RectAreaLightTexturesLib.js` (r180, with a relative core import and an explicit renderer uniform library so Node, mobile and cache-versioned published editors initialize the correct renderer instance)
- `environments/RoomEnvironment.js`
- `postprocessing/GTAOPass.js`
- `postprocessing/Pass.js`
- `shaders/GTAOShader.js`
- `shaders/PoissonDenoiseShader.js`
- `shaders/CopyShader.js`
- `math/SimplexNoise.js`

Upstream: <https://github.com/mrdoob/three.js/tree/r180/examples/jsm>. Refresh these together with their relative imports when upgrading the core; do not mix current addons with r180.
