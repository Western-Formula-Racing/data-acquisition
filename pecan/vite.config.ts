import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import type { Plugin } from "vite";
import { VitePWA } from 'vite-plugin-pwa';
import { execSync } from 'node:child_process';

function getGitCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

// Custom domain: pecan.westernformularacing.org (no base path needed)

// WebSocket server plugin - runs in both development and production
const websocketPlugin = (): Plugin => ({
  name: 'websocket-server',
  configureServer() {
    if (process.env.VITEST) return;
    // Run WebSocket server in development
    startWebSocketServer();
  },
  configurePreviewServer() {
    if (process.env.VITEST) return;
    // Run WebSocket server in preview mode (production testing)
    startWebSocketServer();
  }
});

// Shared WebSocket server function
function startWebSocketServer() {
  // Dynamic import to avoid build-time dependency issues
  import('ws').then(({ WebSocketServer }) => {
    const wss = new WebSocketServer({ port: 9080 });

    // eslint-disable-next-line no-console
    console.log('WebSocket server started on ws://localhost:9080');

    wss.on('connection', (ws) => {
      // eslint-disable-next-line no-console
      console.log('Client connected (Dashboard or Data Sender)');

      ws.on('message', (message) => {
        try {
          const data = JSON.parse(message.toString());
          const messageCount = Array.isArray(data) ? data.length : 1;
          // eslint-disable-next-line no-console
          console.log(`Received ${messageCount} message(s) to broadcast:`, data);

          // Broadcast to all OTHER connected WebSocket clients (not sender)
          wss.clients.forEach(client => {
            if (client !== ws && client.readyState === 1) { // WebSocket.OPEN
              client.send(JSON.stringify(data));
            }
          });
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error('Error parsing WebSocket message:', error);
        }
      });

      ws.on('close', () => {
        // eslint-disable-next-line no-console
        console.log('Client disconnected');
      });

      ws.on('error', (error) => {
        // eslint-disable-next-line no-console
        console.error('WebSocket error:', error);
      });
    });

    // eslint-disable-next-line no-console
    console.log('WebSocket server is running on port 9080');
    // eslint-disable-next-line no-console
    console.log('Data Sender and Dashboard can connect to ws://localhost:9080');
  }).catch((error) => {
    // eslint-disable-next-line no-console
    console.error('Failed to start WebSocket server:', error);
  });
}

// https://vite.dev/config/
const gitCommit = getGitCommit();
export default defineConfig({
  base: '/',
  define: {
    __GIT_COMMIT__: JSON.stringify(gitCommit),
  },
  plugins: [
    react(),
    tailwindcss(),
    websocketPlugin(),
    VitePWA({
      registerType: 'autoUpdate',
      devOptions: {
        enabled: true
      },
      manifest: {
        name: 'PECAN Dashboard',
        short_name: 'PECAN',
        description: 'Western Formula Racing Live Telemetry Dashboard',
        theme_color: '#4F2683',
        background_color: '#18181b',
        display: 'standalone',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png'
          }
        ]
      },
      workbox: {
        // Increase limit to 10MB to accommodate large visualization libraries
        maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,ico,png,svg,dbc}']
      }
    })
  ],
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        '**/*.config.{js,ts}',
        '**/test-*.{js,ts}',
        '**/*.d.ts'
      ]
    }
  }
});
