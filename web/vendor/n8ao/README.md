# N8AO standalone experiment

Source: [N8python/n8ao](https://github.com/N8python/n8ao/tree/6481f6b39f6ec0301b43648492833cdb8bcd99ac), commit `6481f6b39f6ec0301b43648492833cdb8bcd99ac` (npm version `1.10.2`, peer Three.js `>=0.137`). Tested with the local Three.js r180 in this project.

Only `N8AOPass.js` and its relative source dependencies are included. Local changes:

- Replace the Three.js example import prefix `three/examples/jsm/` with the editor's `three/addons/` import-map prefix.
- Remove the unused `N8AOPostPass` import/export, avoiding the separate `postprocessing` framework dependency.

The upstream checkout's [LICENSE](LICENSE) is CC0-1.0; npm metadata labels the package ISC. Preserve the supplied upstream license; clarify this discrepancy before future redistribution/package changes. No upstream scene or texture assets are included; `BlueNoise.js` is an upstream source dependency.

The adapter in `web/editor/static-lighting.mjs` shares the same half-resolution limit, idle scheduling, world-space radius and final colour conversion with GTAO. Temporal accumulation, gamma conversion and transparency auto-detection are disabled here. This is a finite static AO comparison, not N8AO's full temporal/transparency configuration. The adapter explicitly releases owned resources because this version inherits an empty `Pass.dispose()`.
