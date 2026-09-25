// Relays aisstream.io's WebSocket stream to the browser on /ais: the Node
// counterpart of proxy/src/ais.ts. The API key stays on the server.
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { Env } from '../proxy/src/env.ts';
import { AISSTREAM_URL, subscriptionMessage } from '../proxy/src/subscription.ts';

const wss = new WebSocketServer({ noServer: true });

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
  wss.handleUpgrade(req, socket, head, (client) => relay(client, env));
}

function relay(client: WebSocket, env: Env): void {
  const upstream = new WebSocket(AISSTREAM_URL);
  const closeBoth = (): void => {
    upstream.terminate();
    client.close();
  };

  upstream.on('open', () => upstream.send(subscriptionMessage(env)));
  upstream.on('message', (data) => {
    // aisstream.io sends JSON in binary frames; the browser client expects text.
    if (client.readyState === WebSocket.OPEN) client.send(data.toString());
  });
  upstream.on('close', closeBoth);
  upstream.on('error', (err) => {
    console.error('aisstream.io:', err.message);
    closeBoth();
  });
  client.on('close', closeBoth);
  client.on('error', closeBoth);
}
