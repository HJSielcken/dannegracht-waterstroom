// Serves the Vite build (dist/) with sensible cache headers and an
// index.html fallback for unknown paths.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

/**
 * Map a request path to a file inside `root`, or null when it would escape
 * `root` (e.g. `/../etc/passwd`). Exported for testing.
 */
export function resolveStaticPath(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const file = normalize(join(root, decoded));
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (file !== root && !file.startsWith(rootWithSep)) return null;
  return decoded.endsWith('/') ? join(file, 'index.html') : file;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function serveStatic(
  root: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  let file = resolveStaticPath(root, req.url ?? '/');
  if (!file) {
    res.writeHead(400).end();
    return;
  }
  if (!(await isFile(file))) {
    // Unknown page routes get the app; a missing file (e.g. an old asset) is a real 404.
    if (extname(file) && !file.endsWith('index.html')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    file = join(root, 'index.html');
  }

  // Vite emits content-hashed file names under assets/, so they never change.
  const immutable = file.startsWith(join(root, 'assets') + sep);
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
}
