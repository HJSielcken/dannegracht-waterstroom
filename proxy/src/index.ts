import type { Env } from './env';
import { handleAisWebSocket } from './ais';
import { fetchLevelsPayload } from './levels';
import { handleOptions, withCors } from './cors';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return handleOptions(env, request);
    }

    if (url.pathname === '/ais') {
      // WebSocket upgrade responses can't carry extra headers the way a
      // normal fetch Response can here, and the browser doesn't apply CORS
      // to the WebSocket handshake the way it does to fetch/XHR, so no
      // withCors() wrapping for this one.
      return handleAisWebSocket(request, env);
    }

    if (url.pathname === '/levels' && request.method === 'GET') {
      const payload = await fetchLevelsPayload(env);
      return withCors(
        new Response(JSON.stringify(payload), {
          headers: { 'Content-Type': 'application/json' },
        }),
        env,
        request,
      );
    }

    return withCors(new Response('Not found', { status: 404 }), env, request);
  },
} satisfies ExportedHandler<Env>;
