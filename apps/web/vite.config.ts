import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolveWorkerProxyTarget } from './src/vite-proxy';

export default defineConfig(({ mode }) => {
  // `loadEnv(..., '')` includes VITE_* values from .env.local as well as
  // shell-provided values; the shell takes precedence for one-off ports.
  const env = loadEnv(mode, process.cwd(), '');
  const workerTarget = resolveWorkerProxyTarget(process.env.VITE_WORKER_URL ?? env.VITE_WORKER_URL);

  return {
    plugins: [react(), tailwindcss()],
    build: {
      outDir: 'dist',
      sourcemap: true,
      target: 'es2022',
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react';
            return undefined;
          },
        },
      },
    },
    server: {
      port: 5173,
      strictPort: false,
      proxy: {
        '/api': {
          target: workerTarget,
          changeOrigin: false,
        },
      },
    },
    preview: {
      port: 4173,
      strictPort: false,
    },
  };
});
