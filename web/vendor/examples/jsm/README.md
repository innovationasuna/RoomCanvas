# Three.js addons

These source files are from `mrdoob/three.js` tag **r180**, matching the vendored core (`three@0.180.0`). They are used without source changes under the MIT license at [`../../LICENSE`](../../LICENSE).

Common environment and static lighting dependencies:

- `environments/RoomEnvironment.js`
- `postprocessing/GTAOPass.js`
- `postprocessing/Pass.js`
- `shaders/GTAOShader.js`
- `shaders/PoissonDenoiseShader.js`
- `shaders/CopyShader.js`
- `math/SimplexNoise.js`

Upstream: <https://github.com/mrdoob/three.js/tree/r180/examples/jsm>. Refresh these together with their relative imports when upgrading the core; do not mix current addons with r180.
