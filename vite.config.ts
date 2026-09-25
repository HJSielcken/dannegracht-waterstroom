import { spawn, type ChildProcess } from 'node:child_process';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

// `npm run dev` forwards /levels and /ais to server/, so
// VITE_AIS_PROXY_URL=/ais works in development as well. By default the dev
// server starts server/ itself on DEV_SERVER_PORT; set DEV_PROXY_TARGET to
// use one that is already running instead (e.g. Docker on :8533).
const devServerPort = process.env.DEV_SERVER_PORT || '8787';
const devProxyTarget = process.env.DEV_PROXY_TARGET || `http://localhost:${devServerPort}`;

function localServer(): Plugin {
  let child: ChildProcess | undefined;
  return {
    name: 'local-server',
    apply: 'serve',
    configureServer(server) {
      if (process.env.DEV_PROXY_TARGET || process.env.VITEST) return;
      child = spawn(process.execPath, ['--env-file-if-exists=.env', 'server/index.ts'], {
        env: { ...process.env, PORT: devServerPort },
        stdio: 'inherit',
      });
      const stop = () => child?.kill();
      server.httpServer?.once('close', stop);
      process.once('exit', stop);
    },
  };
}

// GitHub Pages serves the site from /<repo-name>/.
export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/dannegracht-waterstroom/' : '/',
  plugins: [localServer()],
  server: {
    proxy: {
      '/levels': devProxyTarget,
      '/ais': { target: devProxyTarget, ws: true },
    },
  },
  test: { environment: 'node' },
});
