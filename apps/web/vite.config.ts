import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  let files: string[] = [];
  return {
    name: 'hub-service-worker',
    configureServer(server) {
      server.middlewares.use('/sw.js', (_request, response) => {
        response.setHeader('Content-Type', 'text/javascript');
        response.setHeader('Cache-Control', 'no-cache');
        response.end(readFileSync(serviceWorker));
      });
    },
    // Last, after Vite drops the empty script chunks of CSS-only imports;
    // listing one of those would make the worker's install fail on a 404.
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        files = [
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
    },
    // One missing file fails the whole precache, so fail the build instead.
    writeBundle(options) {
      const missing = files.filter(
        (file) =>
          file !== '/favicon.svg' &&
          !existsSync(join(options.dir ?? 'dist', file)),
      );
      if (missing.length)
        throw new Error(
          `The service worker would precache unwritten files: ${missing.join(', ')}`,
        );
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
