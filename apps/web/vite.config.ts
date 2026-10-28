import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { createDevLogger } from './devProxyLogger.ts';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, '..', '..');
const runtimeFile = path.join(repoRoot, '.devpilot', 'server.json');

const serverOrigin = process.env.DEVPILOT_SERVER_ORIGIN;
const configuredWebPort = process.env.DEVPILOT_WEB_PORT
  ? Number(process.env.DEVPILOT_WEB_PORT)
  : undefined;

function readLocalToken(): string {
  try {
    const runtime = JSON.parse(fs.readFileSync(runtimeFile, 'utf8')) as {
      token?: string;
    };
    return runtime.token ?? '';
  } catch {
    return '';
  }
}

function devTokenPlugin() {
  return {
    name: 'devpilot-dev-token',
    apply: 'serve' as const,
    transformIndexHtml(html: string) {
      const token = readLocalToken();
      if (!token) return html;
      return html.replace(
        '</head>',
        `  <meta name="devpilot-token" content="${token}" />\n  </head>`,
      );
    },
  };
}

export default defineConfig(({ command }) => {
  if (command === 'serve' && !serverOrigin) {
    console.warn(
      '[devpilot] DEVPILOT_SERVER_ORIGIN is not set. Start the app with `npm run dev` from the repository root.',
    );
  }

  return {
    customLogger: command === 'serve' ? createDevLogger() : undefined,
    plugins: [react(), devTokenPlugin()],
    server: {
      host: '127.0.0.1',
      port: configuredWebPort ?? 5173,
      strictPort: configuredWebPort !== undefined,
      proxy: serverOrigin
        ? {
            '/api': {
              target: serverOrigin,
              changeOrigin: false,
              configure(proxy) {
                proxy.on(
                  'proxyReq',
                  (proxyReq: { setHeader: (name: string, value: string) => void }) => {
                    const token = readLocalToken();
                    if (token) proxyReq.setHeader('x-devpilot-token', token);
                  },
                );
              },
            },
            '/ws': {
              target: serverOrigin,
              changeOrigin: false,
              ws: true,
            },
          }
        : undefined,
    },
  };
});
