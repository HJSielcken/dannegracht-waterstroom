// Self-hosted app server: serves the built front end from dist/ and the
// proxy endpoints on the same origin, so no CORS and no separate proxy
// deployment are needed:
//   GET /levels  live water levels (server/levels.ts)
//   WS  /ais     aisstream.io relay (server/ais.ts)
//   GET /healthz liveness check
// Configuration comes from environment variables; see README.md (Docker).
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import type { Env } from './env.ts';
import { fetchLevelsPayload } from './levels.ts';
import { handleAisUpgrade } from './ais.ts';
import { serveStatic } from './static.ts';

const e = process.env;
const env: Env = {
  AISSTREAM_API_KEY: e.AISSTREAM_API_KEY ?? '',
  AIS_BBOX_SOUTH: e.AIS_BBOX_SOUTH || '52.15',
  AIS_BBOX_WEST: e.AIS_BBOX_WEST || '4.97',
  AIS_BBOX_NORTH: e.AIS_BBOX_NORTH || '52.20',
  AIS_BBOX_EAST: e.AIS_BBOX_EAST || '5.03',
  // Rijkswaterstaat gauge on the ARK at Maarssen, about 4 km from the Dannegracht.
  RWS_ARK_LOCATION_CODE: e.RWS_ARK_LOCATION_CODE || 'maarssen.kanaal',
  // HDSR gauge "DAALSEWEG_2153-w_Vecht" (H.G.15, m NAP) at Oud-Zuilen, the nearest
  // Vecht gauge upstream of Breukelen on the same boezem (about 9 km along the river).
  HDSR_VECHT_TIMESERIES_UUID:
    e.HDSR_VECHT_TIMESERIES_UUID || '66ca9d96-6454-411f-a2a5-65c51225befe',
};
const port = Number(e.PORT || 8080);
const distDir = resolve(e.DIST_DIR || 'dist');

const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  if (path === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
    return;
  }
  if (path === '/levels' && req.method === 'GET') {
    fetchLevelsPayload(env).then(
      (payload) => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payload));
      },
      (err: unknown) => {
        console.error('/levels:', err);
        res.writeHead(502).end();
      },
    );
    return;
  }
  serveStatic(distDir, req, res).catch((err: unknown) => {
    console.error(req.url, err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});

server.on('upgrade', (req, socket, head) => {
  if ((req.url ?? '').split('?')[0] === '/ais') handleAisUpgrade(req, socket, head, env);
  else socket.destroy();
});

server.listen(port, () => {
  console.log(`Dannegracht waterstroom on http://localhost:${port}`);
  console.log(`  AIS:   ${env.AISSTREAM_API_KEY ? 'on' : 'off (AISSTREAM_API_KEY not set)'}`);
  console.log(`  ARK:   ${env.RWS_ARK_LOCATION_CODE}`);
  console.log(`  Vecht: ${env.HDSR_VECHT_TIMESERIES_UUID}`);
});

const shutdown = (): void => {
  server.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
