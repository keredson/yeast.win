import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { sourceBuildInfo } from './server/buildInfo.ts';
import type { BuildInfo } from './shared/buildInfo.ts';

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

function buildInfoAsset(info: BuildInfo): Plugin {
  return {
    name: 'yeast-build-info',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'build-info.json', source: JSON.stringify(info) });
    }
  };
}

export default defineConfig(({ command }) => {
  const socketPath = resolve(projectRoot, '.brewlog-api.sock');
  if (command === 'serve' && (process.env.BREWLOG_DEV_ROOT !== projectRoot
    || process.env.BREWLOG_DEV_SOCKET !== socketPath)) {
    throw new Error('Start the development app with yarn dev so Vite and the API use this checkout socket.');
  }
  const buildInfo = sourceBuildInfo(projectRoot, command === 'serve' ? 'development' : 'production');
  return ({
  root: projectRoot,
  define: { __YEAST_BUILD_INFO__: JSON.stringify(buildInfo) },
  plugins: [
    react(), appAssetManifest(), buildInfoAsset(buildInfo),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Yeast.Win!',
        short_name: 'Yeast.Win!',
        description: 'A notebook for fermentation experiments and batches',
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
  server: {
    port: Number(process.env.VITE_PORT) || 5173,
    strictPort: true,
    proxy: { '/api': { target: { host: 'localhost', port: 80, socketPath } } }
  },
  build: { outDir: 'dist' }
  });
});
