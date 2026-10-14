import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

function appAssetManifest(): Plugin {
  return {
    name: 'brewlog-app-assets',
    generateBundle(_options, bundle) {
      const assets = Object.values(bundle).filter(item => item.fileName.startsWith('assets/')
        && !(item.type === 'chunk' && item.facadeModuleId?.endsWith('/client/bootstrap.ts')))
        .map(item => ({ url: `/${item.fileName}`, size: item.type === 'chunk'
          ? Buffer.byteLength(item.code) : typeof item.source === 'string'
            ? Buffer.byteLength(item.source) : item.source.byteLength }));
      this.emitFile({ type: 'asset', fileName: 'app-assets.json', source: JSON.stringify({ assets }) });
    }
  };
}

export default defineConfig(({ mode, command }) => {
  const apiPort = loadEnv(mode, projectRoot, 'BREWLOG_PORT').BREWLOG_PORT;
  if (command === 'serve' && (process.env.BREWLOG_DEV_ROOT !== projectRoot || !apiPort)) {
    throw new Error('Start the development app with yarn dev so Vite and the API use the same checkout and port.');
  }
  return ({
  root: projectRoot,
  plugins: [
    react(), appAssetManifest(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Brewlog',
        short_name: 'Brewlog',
        description: 'A batch-first brewing log',
        theme_color: '#193b39',
        background_color: '#f5f3ed',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }
        ]
      },
      workbox: {
        navigateFallback: '/index.html',
        // The generated file has a stable URL; refresh its precache entry on every build.
        additionalManifestEntries: [{ url: '/app-assets.json', revision: String(Date.now()) }],
        globPatterns: ['index.html', 'registerSW.js', 'assets/index-*.js', 'assets/index-*.css'],
        maximumFileSizeToCacheInBytes: 100_000,
        runtimeCaching: [
          { urlPattern: ({ url }) => url.origin === self.location.origin && url.pathname.startsWith('/assets/'),
            handler: 'CacheFirst', options: { cacheName: 'brewlog-app-assets-v1' } },
          { urlPattern: ({ url, request }) => url.protocol === 'https:' && url.origin !== self.location.origin
              && request.destination === 'image',
            handler: 'StaleWhileRevalidate', options: { cacheName: 'brewlog-catalog-images-v1',
              cacheableResponse: { statuses: [0, 200] } } }
        ]
      }
    })
  ],
  server: { proxy: { '/api': `http://127.0.0.1:${apiPort || 3001}` } },
  build: { outDir: 'dist' }
  });
});
