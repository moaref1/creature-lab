import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  worker: { format: 'es' },
  // build outputs and run folders are not source: don't watch them (Electron locks its files)
  server: { port: 5173, strictPort: false, watch: { ignored: ['**/dist/**', '**/dist-desktop/**', '**/.creaturelab-runs/**', '**/python/**'] } },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
});
