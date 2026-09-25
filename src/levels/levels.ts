// Live boundary water levels for the Dannegracht sim: the Vecht level at one
// end, the Amsterdam-Rijnkanaal (ARK) level at the other.
//
// Both upstream sources are Dutch government/water-board HTTP APIs that do
// not send permissive CORS headers for arbitrary browser origins, so the
// browser calls the `/levels` endpoint of server/, which fetches upstream
// server-side (see server/levels.ts: Rijkswaterstaat for the ARK, HDSR
// Lizard for the Vecht) and returns plain JSON.
import { proxyHttpBase } from '../proxyUrl';
import type { BoundaryLevels } from '../types';

/**
 * Fallback levels used when the proxy is not configured or the upstream
 * fetch fails, so the sim always has *something* sane to run with.
 *
 * These are NOT live measurements — they are the regulated/typical target
 * levels ("streefpeil") for these water bodies, both close to NAP -0.40 m:
 *  - The Amsterdam-Rijnkanaal is centrally regulated by Rijkswaterstaat; the
 *    pand (reach) through Maarssen/Breukelen is commonly cited around
 *    NAP -0.40 m.
 *  - The Vecht at Breukelen sits in the boezem system shared by HDSR and
 *    Waternet/AGV, whose boezempeil is also commonly cited around
 *    NAP -0.40 m.
 * ASSUMPTION, not independently verified against a specific peilbesluit
 * document for this exact reach — treat as a reasonable default, not a
 * source of truth. Confirm against a current peilbesluit / waterinfo.rws.nl
 * before relying on the absolute values for anything beyond a plausible
 * simulation starting point.
 */
export const DEFAULT_LEVELS: BoundaryLevels = {
  vechtNapM: -0.4,
  arkNapM: -0.4,
};

export interface LevelsResult {
  levels: BoundaryLevels;
  source: string;
  measuredAt: string;
}

export interface FetchLevelsOptions {
  /** Base URL of the proxy, e.g. https://waterstroom.example.nl. Defaults to `import.meta.env.VITE_AIS_PROXY_URL` (absolute or a same-origin path) with the trailing `/ais` stripped. */
  baseUrl?: string;
  /** Fetch implementation, for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Abort/timeout, ms. Default 8000. */
  timeoutMs?: number;
}

function readDefaultBaseUrl(): string | undefined {
  try {
    const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    const proxyUrl = env?.VITE_AIS_PROXY_URL;
    if (!proxyUrl) return undefined;
    return proxyHttpBase(proxyUrl) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Shape returned by the proxy's GET /levels endpoint. */
interface LevelsResponseBody {
  levels?: { vechtNapM?: unknown; arkNapM?: unknown };
  source?: unknown;
  measuredAt?: unknown;
}

/** Parse (and validate) the proxy's /levels JSON body. Exported for testing. */
export function parseLevelsResponse(body: unknown): LevelsResult | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as LevelsResponseBody;
  const vecht = b.levels?.vechtNapM;
  const ark = b.levels?.arkNapM;
  if (typeof vecht !== 'number' || !Number.isFinite(vecht)) return null;
  if (typeof ark !== 'number' || !Number.isFinite(ark)) return null;
  return {
    levels: { vechtNapM: vecht, arkNapM: ark },
    source: typeof b.source === 'string' ? b.source : 'unknown',
    measuredAt: typeof b.measuredAt === 'string' ? b.measuredAt : new Date(0).toISOString(),
  };
}

/**
 * Fetch live boundary levels via the proxy. Returns `null` (never throws)
 * when no proxy is configured or the fetch/parse fails — callers should
 * fall back to `DEFAULT_LEVELS` in that case.
 */
export async function fetchLevels(options: FetchLevelsOptions = {}): Promise<LevelsResult | null> {
  const baseUrl = options.baseUrl ?? readDefaultBaseUrl();
  if (!baseUrl) return null;
  const fetchImpl = options.fetchImpl ?? (globalThis as { fetch?: typeof fetch }).fetch;
  if (!fetchImpl) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/levels`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return parseLevelsResponse(body);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
