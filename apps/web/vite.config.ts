import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const serviceWorker = fileURLToPath(new URL('./src/sw.js', import.meta.url));

/** Serves the service worker in development and emits it with a precache
 *  manifest of every built asset, so lazy-loaded views work offline. The
 *  version changes with the asset list, which makes browsers install the
 *  new worker and drop the previous cache. */
function serviceWorkerPlugin(): Plugin {
  return {
    name: 'hub-service-worker',
    configureServer(server) {
      server.middlewares.use('/sw.js', (_request, response) => {
        response.setHeader('Content-Type', 'text/javascript');
        response.setHeader('Cache-Control', 'no-cache');
        response.end(readFileSync(serviceWorker));
      });
    },
    generateBundle(_options, bundle) {
      const files = [
        '/favicon.svg',
        ...Object.keys(bundle)
          .filter((name) => name !== 'index.html' && !name.endsWith('.map'))
          .map((name) => `/${name}`),
      ].sort();
      const version = createHash('sha256')
        .update(files.join('\n'))
        .digest('hex')
        .slice(0, 16);
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: `self.__HUB_PRECACHE__ = ${JSON.stringify({ version, files })};\n${readFileSync(serviceWorker, 'utf8')}`,
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, repositoryRoot, '');
  const proxy = {
    '/api': { target: environment.API_PROXY_TARGET || 'http://127.0.0.1:3001' },
  };
  return {
    plugins: [react(), serviceWorkerPlugin()],
    // Oldest verified Android WebView; Kompakt hardware is not yet measured.
    build: { target: 'chrome113', cssTarget: 'chrome113' },
    server: {
      host: '127.0.0.1',
      port: Number(environment.WEB_PORT || 5173),
      strictPort: true,
      proxy,
    },
    preview: { host: '127.0.0.1', port: 4173, strictPort: true, proxy },
  };
});
