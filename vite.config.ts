import { defineConfig } from 'vite';
export default defineConfig({ worker: { format: 'es' }, build: { target: 'es2022', rollupOptions: { input: { demo: 'index.html', viewforge: 'viewforge.html' } } } });
