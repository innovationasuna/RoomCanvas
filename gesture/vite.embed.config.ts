import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The recognition runtime as one ES module for RoomCanvas's editor (see src/embed/index.ts):
//   npx vite build --config vite.embed.config.ts
// Writes ../web/vendor/gesture/, which is committed like three.js so web/ needs no build step.
const embeddedTracker = fileURLToPath(new URL('./src/embed/tracker.ts', import.meta.url));
export default defineConfig({
  base: './', publicDir: false,
  worker: { format: 'es', rollupOptions: { output: { entryFileNames: 'gesture-worker.js' } } },
  // integration/runtime.ts imports ../tracking/tracker, which reads MediaPipe from this site's /vision/.
  resolve: { alias: [{ find: /^\.\.\/tracking\/tracker$/, replacement: embeddedTracker }] },
  build: {
    // 固定文件名直接覆盖，保留该目录随仓库维护的来源和许可说明。
    target: 'es2022', outDir: '../web/vendor/gesture', emptyOutDir: false, minify: false,
    lib: { entry: 'src/embed/index.ts', formats: ['es'], fileName: () => 'gesture-runtime.js' },
  },
});
