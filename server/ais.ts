// Relays aisstream.io's WebSocket stream to the browser on /ais. The API key
// stays on the server.
//
// All browser clients share ONE upstream connection: aisstream.io rate-limits
// connections per API key and answers with HTTP 429 when a connection is
// opened per tab (or per client reconnect). The upstream is opened when the
// first client arrives, kept for a grace period after the last one leaves (so
// page reloads don't churn it), and reconnected with exponential backoff.
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { Env } from './env.ts';
import { AISSTREAM_URL, subscriptionMessage } from './subscription.ts';

const INITIAL_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;
/** Minimum wait after aisstream.io answers 429 Too Many Requests. */
const RATE_LIMITED_BACKOFF_MS = 60_000;
/** Keep the upstream open this long after the last client disconnects. */
const IDLE_CLOSE_MS = 60_000;
/** Replay messages up to this old to newly connected clients. */
const REPLAY_MAX_AGE_MS = 10 * 60_000;

const wss = new WebSocketServer({ noServer: true });
const clients = new Set<WebSocket>();

let upstream: WebSocket | null = null;
let backoffMs = INITIAL_BACKOFF_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

// Latest message per (message type, MMSI), so a client joining the shared
// stream sees known boats (and their names) right away instead of waiting
// for the next reports.
const replay = new Map<string, { data: string; at: number }>();

export function handleAisUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  env: Env,
): void {
  if (!env.AISSTREAM_API_KEY) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    return;
  }
  wss.handleUpgrade(req, socket, head, (client) => addClient(client, env));
}

function addClient(client: WebSocket, env: Env): void {
  clients.add(client);
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }

  const now = Date.now();
  for (const [key, entry] of replay) {
    if (now - entry.at > REPLAY_MAX_AGE_MS) replay.delete(key);
    else client.send(entry.data);
  }

  const remove = (): void => {
    if (!clients.delete(client)) return;
    if (clients.size === 0) idleTimer = setTimeout(closeUpstream, IDLE_CLOSE_MS);
  };
  client.on('close', remove);
  client.on('error', remove);

  if (!upstream && !reconnectTimer) connectUpstream(env);
}

function connectUpstream(env: Env): void {
  reconnectTimer = null;
  if (clients.size === 0) return;

  const socket = new WebSocket(AISSTREAM_URL);
  upstream = socket;
  let rateLimited = false;

  socket.on('open', () => socket.send(subscriptionMessage(env)));
  socket.on('message', (raw) => {
    // aisstream.io sends JSON in binary frames; the browser client expects text.
    const data = raw.toString();
    backoffMs = INITIAL_BACKOFF_MS;
    remember(data);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  });
  socket.on('error', (err) => {
    rateLimited = /\b429\b/.test(err.message);
    console.error('aisstream.io:', err.message);
  });
  socket.on('close', () => {
    if (upstream !== socket) return; // closed on purpose by closeUpstream()
    upstream = null;
    if (clients.size === 0) return;
    const delay = rateLimited ? Math.max(backoffMs, RATE_LIMITED_BACKOFF_MS) : backoffMs;
    backoffMs = Math.min(delay * 2, MAX_BACKOFF_MS);
    console.error(`aisstream.io: reconnecting in ${Math.round(delay / 1000)} s`);
    reconnectTimer = setTimeout(() => connectUpstream(env), delay);
  });
}

function closeUpstream(): void {
  idleTimer = null;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const socket = upstream;
  upstream = null;
  socket?.terminate();
}

function remember(data: string): void {
  try {
    const msg = JSON.parse(data) as { MessageType?: string; MetaData?: { MMSI?: number } };
    const mmsi = msg.MetaData?.MMSI;
    if (msg.MessageType && mmsi !== undefined) {
      replay.set(`${msg.MessageType}:${mmsi}`, { data, at: Date.now() });
    }
  } catch {
    // Not JSON (e.g. an error string); nothing to replay.
  }
}
