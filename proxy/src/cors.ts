import type { Env } from './env';

/** Build CORS response headers, restricted to `env.ALLOWED_ORIGIN` (or "*" if configured that way). */
export function corsHeaders(env: Env, _request: Request): HeadersInit {
  // The browser itself checks that Access-Control-Allow-Origin matches the
  // page's actual origin, so we just echo the configured allowed origin (or
  // "*"); no need to compare against the request's Origin header here.
  const allowed =
    env.ALLOWED_ORIGIN && env.ALLOWED_ORIGIN.trim().length > 0 ? env.ALLOWED_ORIGIN : '*';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

export function withCors(response: Response, env: Env, request: Request): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(env, request))) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function handleOptions(env: Env, request: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(env, request) });
}
