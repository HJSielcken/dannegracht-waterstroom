// Browser-side geocoding via the PDOK Locatieserver (Dutch national address/location
// search), used to let a user add their own probe by address. Only reachable from the
// browser at runtime — see RESEARCH.md for why this could not be exercised live during
// development of this module.

import type { LatLon } from '../types';

const PDOK_FREE_URL = 'https://api.pdok.nl/bzk/locatieserver/search/v3_1/free';

interface PdokDoc {
  centroide_ll?: string; // "POINT(lon lat)"
  weergavenaam?: string;
}

interface PdokFreeResponse {
  response?: {
    docs?: PdokDoc[];
  };
}

/** Parses a WKT `POINT(lon lat)` string as returned by PDOK's `centroide_ll` field. */
export function parseWktPoint(wkt: string): LatLon | null {
  const match = /^POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)$/i.exec(wkt.trim());
  if (!match) return null;
  const lon = Number(match[1]);
  const lat = Number(match[2]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return { lat, lon };
}

/**
 * Geocodes a free-text query (e.g. "Brugstraat 10e, Breukelen") via the PDOK
 * Locatieserver. Resolves to `null` (rather than throwing) if the service is
 * unreachable, returns no results, or returns an unparseable result, so callers can
 * fall back to manual placement without a try/catch.
 */
export async function geocode(query: string, signal?: AbortSignal): Promise<LatLon | null> {
  const url = new URL(PDOK_FREE_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('rows', '1');

  try {
    const res = await fetch(url.toString(), { signal });
    if (!res.ok) return null;
    const json = (await res.json()) as PdokFreeResponse;
    const doc = json.response?.docs?.[0];
    if (!doc?.centroide_ll) return null;
    return parseWktPoint(doc.centroide_ll);
  } catch {
    return null;
  }
}
