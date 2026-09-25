// Relays aisstream.io's WebSocket stream to the browser.
//
// aisstream.io does not allow direct browser connections (see
// https://aisstream.io/documentation: "you cannot connect directly from a
// browser due to CORS restrictions—you must connect through a backend
// server") and requires the API key to stay server-side. This Worker holds
// the key as a secret, opens the upstream connection itself, sends the
// subscription message, and pipes the raw JSON messages straight through to
// the browser unmodified (parsing/merging happens client-side in
// src/boats/aisMessages.ts, so both sides speak the same aisstream.io wire
// format).
import type { Env } from './env';
import { AISSTREAM_URL, subscriptionMessage } from './subscription';

export async function handleAisWebSocket(request: Request, env: Env): Promise<Response> {
  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('Expected Upgrade: websocket', { status: 426 });
  }
  if (!env.AISSTREAM_API_KEY) {
    return new Response('AISSTREAM_API_KEY is not configured on the proxy', { status: 503 });
  }

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

  server.accept();
  connectUpstreamAndRelay(server, env).catch((err) => {
    try {
      server.send(JSON.stringify({ MessageType: 'Error', error: String(err) }));
    } catch {
      // client socket may already be gone
    }
    try {
      server.close(1011, 'upstream error');
    } catch {
      // already closed
    }
  });

  return new Response(null, { status: 101, webSocket: client });
}

async function connectUpstreamAndRelay(clientSocket: WebSocket, env: Env): Promise<void> {
  const upstreamResponse = await fetch(AISSTREAM_URL, {
    headers: { Upgrade: 'websocket' },
  });
  const upstream = upstreamResponse.webSocket;
  if (!upstream) {
    throw new Error('aisstream.io did not upgrade the connection');
  }
  upstream.accept();

  // The subscription message must be sent within 3 seconds of the socket
  // opening, per aisstream.io's docs.
  upstream.send(subscriptionMessage(env));

  upstream.addEventListener('message', (event: MessageEvent) => {
    try {
      clientSocket.send(event.data as string);
    } catch {
      // client already closed; upstream close below will follow.
    }
  });

  const closeBoth = (): void => {
    try {
      upstream.close();
    } catch {
      // ignore
    }
    try {
      clientSocket.close();
    } catch {
      // ignore
    }
  };

  upstream.addEventListener('close', closeBoth);
  upstream.addEventListener('error', closeBoth);
  clientSocket.addEventListener('close', closeBoth);
  clientSocket.addEventListener('error', closeBoth);
}
