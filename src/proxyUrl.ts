// VITE_AIS_PROXY_URL is either an absolute WebSocket URL of a separately
// deployed proxy (wss://…workers.dev/ais) or a path such as `/ais` when the
// app is served by server/ on the same origin. These helpers turn either
// form into the URLs the AIS and levels clients need.

function currentPage(): string | undefined {
  return (globalThis as { location?: { href?: string } }).location?.href;
}

function resolve(proxyUrl: string, base: string | undefined): URL | null {
  try {
    return new URL(proxyUrl, base);
  } catch {
    return null;
  }
}

/** Absolute ws:/wss: URL of the AIS relay, or null when it cannot be resolved. */
export function aisSocketUrl(proxyUrl: string, base = currentPage()): string | null {
  const url = resolve(proxyUrl, base);
  if (!url) return null;
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  return url.href;
}

/** http:/https: base URL of the proxy (the AIS URL without `/ais`), or null. */
export function proxyHttpBase(proxyUrl: string, base = currentPage()): string | null {
  const url = resolve(proxyUrl, base);
  if (!url) return null;
  if (url.protocol === 'wss:') url.protocol = 'https:';
  else if (url.protocol === 'ws:') url.protocol = 'http:';
  url.search = '';
  url.hash = '';
  return url.href.replace(/\/ais\/?$/, '').replace(/\/$/, '');
}
