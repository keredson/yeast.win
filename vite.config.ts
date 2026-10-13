import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));
const localHostname = hostname().replace(/\.local$/, '');

export default defineConfig(({ mode }) => ({
  root: projectRoot,
  plugins: [
    react(),
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
      workbox: { navigateFallback: '/index.html' }
    })
  ],
  server: {
    allowedHosts: [localHostname, `${localHostname}.local`],
    proxy: { '/api': `http://127.0.0.1:${loadEnv(mode, projectRoot, 'BREWLOG_PORT').BREWLOG_PORT || 3001}` }
  },
  build: { outDir: 'dist' }
}));
