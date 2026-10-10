import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, repositoryRoot, '');
  const proxy = {
    '/api': { target: environment.API_PROXY_TARGET || 'http://127.0.0.1:3001' },
  };
  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: Number(environment.WEB_PORT || 5173),
      strictPort: true,
      proxy,
    },
    preview: { host: '127.0.0.1', port: 4173, strictPort: true, proxy },
  };
});
