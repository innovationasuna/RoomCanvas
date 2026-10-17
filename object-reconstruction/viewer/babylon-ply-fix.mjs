import { readFile } from "node:fs/promises";

/**
 * Babylon 8.2.0 treats PLYValue.UNDEFINED (85, e.g. nx/ny/nz) as SH_44 (84),
 * creating phantom degree-3 SH even for DC-only Gaussian PLYs. Its degree-2
 * threshold is also SH_24 instead of the last degree-2 coefficient, SH_23.
 * Apply only this pinned loader fix; preserve the asset and all DC values.
 * Upstream: Babylon.js/8.2.0/.../gaussianSplattingMesh.ts, ParseHeader.
 */
export const plyHeaderFix = {
  name: "babylon-8.2-ply-sh-header-fix",
  setup(build) {
    build.onLoad({ filter: /[/\\]@babylonjs[/\\]core[/\\]Meshes[/\\]GaussianSplatting[/\\]gaussianSplattingMesh\.js$/ }, async ({ path }) => {
      const source = await readFile(path, "utf8");
      const original = `if (value >= 84 /* PLYValue.SH_44 */) {
                    shDegree = 3;
                }
                else if (value >= 64 /* PLYValue.SH_24 */) {
                    shDegree = 2;
                }
                else if (value >= 48 /* PLYValue.SH_8 */) {
                    shDegree = 1;
                }`;
      const replacement = `if (value === 84 /* PLYValue.SH_44 */) {
                    shDegree = Math.max(shDegree, 3);
                }
                else if (value >= 63 /* PLYValue.SH_23 */ && value < 84) {
                    shDegree = Math.max(shDegree, 2);
                }
                else if (value >= 48 /* PLYValue.SH_8 */ && value < 63) {
                    shDegree = Math.max(shDegree, 1);
                }`;
      if (!source.includes(original)) throw new Error("Babylon 8.2.0 PLY header patch no longer matches the installed source");
      return { contents: source.replace(original, replacement), loader: "js" };
    });
  },
};
