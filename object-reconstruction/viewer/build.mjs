import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createHash } from "node:crypto";
import { plyHeaderFix } from "./babylon-ply-fix.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(root, "../scripts/assets");
await mkdir(out, { recursive: true });
const result = await build({
  absWorkingDir: root,
  entryPoints: ["src/viewer.ts"],
  outfile: path.join(out, "cover-viewer.js"),
  bundle: true,
  splitting: false,
  format: "iife",
  platform: "browser",
  target: ["chrome110", "firefox115", "safari16.4"],
  minify: true,
  legalComments: "eof",
  metafile: true,
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "info",
  plugins: [plyHeaderFix],
});
const assetVersion = createHash('sha256').update(await readFile(path.join(out, 'cover-viewer.js')))
  .update(await readFile(path.join(out, 'cover-viewer.css'))).digest('hex').slice(0, 12);
const html = (await readFile(path.join(root, 'src/index.html'), 'utf8'))
  .replace('./cover-viewer.js', `./cover-viewer.js?v=${assetVersion}`)
  .replace('./cover-viewer.css', `./cover-viewer.css?v=${assetVersion}`);
await writeFile(path.join(out, 'cover-viewer.html'), html);
const license = await readFile(path.join(root, "node_modules/@babylonjs/core/license.md"), "utf8");
await writeFile(path.join(out, "cover-viewer-LICENSE"), `ViewForge viewer bundles @babylonjs/core 8.2.0 and @babylonjs/loaders 8.2.0.\nLocal compatibility change: bound PLY SH-property detection to recognized SH fields; correct degree-2 threshold. See viewer/babylon-ply-fix.mjs.\n\n${license}`);
await writeFile(path.join(out, "cover-viewer-build.json"), JSON.stringify({
  renderer: "Babylon.js", version: "8.2.0", build: "cover-viewer-1.5.0", format: "iife", externalRuntimeDependencies: [],
  compatibilityPatches: [plyHeaderFix.name],
  outputs: Object.fromEntries(Object.entries(result.metafile.outputs).map(([name, info]) => [path.basename(name), { bytes: info.bytes, imports: info.imports }])),
}, null, 2) + "\n");
