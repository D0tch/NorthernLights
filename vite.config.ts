import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'path';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: 'auto',
      manifest: {
        name: 'NorthernLights',
        short_name: 'NorthernLights',
        description: 'A modern web-based music player with local file playback, metadata editing, and playlist management.',
        start_url: '/?source=pwa',
        scope: '/',
        lang: 'en',
        dir: 'ltr',
        theme_color: '#050311',
        background_color: '#050311',
        display: 'standalone',
        display_override: ['standalone', 'browser'],
        orientation: 'portrait-primary',
        categories: ['music', 'entertainment'],
        icons: [
          {
            src: '/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: '/icon-384.png',
            sizes: '384x384',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: '/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: '/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable'
          }
        ],
        screenshots: [
          {
            src: '/splash/pwa-screenshot-wide.png',
            sizes: '2880x1620',
            type: 'image/png',
            form_factor: 'wide',
            label: 'Aurora NorthernLights splash screen'
          },
          {
            src: '/splash/pwa-screenshot-narrow.png',
            sizes: '1290x2796',
            type: 'image/png',
            form_factor: 'narrow',
            label: 'Aurora NorthernLights mobile splash screen'
          }
        ],
        shortcuts: [
          {
            name: 'Open Hub',
            short_name: 'Hub',
            description: 'Browse your music library',
            url: '/library?source=shortcut',
            icons: [{ src: '/icon-192.png', sizes: '192x192' }]
          },
          {
            name: 'Playlists',
            short_name: 'Playlists',
            description: 'View your playlists',
            url: '/playlists?source=shortcut',
            icons: [{ src: '/icon-192.png', sizes: '192x192' }]
          }
        ]
      },
      workbox: {
        runtimeCaching: [
          {
            // HLS transport stream segments — immutable chunks used by browser playback.
            urlPattern: /\/api\/stream\/.*\.ts(\?.*)?$/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'nl-audio-chunks-v1',
              expiration: { maxEntries: 2000, maxAgeSeconds: 604800 }, // 7 days
              cacheableResponse: { statuses: [0, 200] }
            }
          },
          {
            // HLS playlists stay fresh when online, with cache fallback for previously played tracks.
            urlPattern: /\/api\/stream\/.*\.m3u8(\?.*)?$/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'nl-audio-playlists-v1',
              expiration: { maxEntries: 200, maxAgeSeconds: 86400 },
              cacheableResponse: { statuses: [0, 200] }
            }
          },
          {
            // Album art cache (kept from legacy media-cache)
            urlPattern: /\/api\/art(\?.*)?$/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'media-cache',
              expiration: { maxEntries: 500, maxAgeSeconds: 2592000 }, // 30 days
              cacheableResponse: { statuses: [0, 200] }
            }
          },
          {
            // Keep authenticated/user-specific API data out of Cache Storage.
            urlPattern: /\/api\//,
            handler: 'NetworkOnly'
          },
          {
            urlPattern: /\.(?:png|jpg|jpeg|gif|webp|avif)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'image-cache',
              expiration: { maxEntries: 300, maxAgeSeconds: 2592000 },
              cacheableResponse: { statuses: [0, 200] }
            }
          },
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'google-fonts-stylesheets'
            }
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-webfonts',
              expiration: { maxEntries: 30, maxAgeSeconds: 31536000 },
              cacheableResponse: { statuses: [0, 200] }
            }
          }
        ]
      }
    })
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      buffer: path.resolve(__dirname, './node_modules/buffer/'),
    },
  },
  base: '/',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('react') || id.includes('react-dom') || id.includes('react-router')) {
              return 'vendor-react';
            }
            if (id.includes('framer-motion')) {
              return 'vendor-motion';
            }
            if (id.includes('lucide-react')) {
              return 'vendor-icons';
            }
            if (id.includes('hls.js')) {
              return 'vendor-hls';
            }
          }
        }
      }
    }
  },
  server: {
    port: 3000,
    open: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      }
    }
  },
  define: {
    global: 'globalThis'
  },
  optimizeDeps: {
    esbuildOptions: {
      define: {
        global: 'globalThis',
      },
    },
  },
});
