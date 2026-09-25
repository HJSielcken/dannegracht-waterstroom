// Fetches the water geometry around the Dannegracht from OpenStreetMap (Overpass) and stores
// it as src/geo/osm-snapshot.json. The app uses this snapshot when Overpass is unreachable
// at runtime, so the offline map is real OSM data instead of a hand-drawn sketch.
//
// The snapshot is written even when classification fails, so it can be inspected.
//
// Usage: npm run osm:snapshot   (runs in CI via .github/workflows/osm-snapshot.yml)

import { writeFileSync } from 'node:fs';
import {
  JUNCTION_BBOX,
  buildOverpassQuery,
  parseOverpassResponse,
  type OverpassResponse,
} from '../src/geo/overpass';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const OUT = new URL('../src/geo/osm-snapshot.json', import.meta.url);

async function fetchOverpass(query: string): Promise<OverpassResponse> {
  let lastError: unknown;
  for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: new URLSearchParams({ data: query }),
        headers: { 'User-Agent': 'dannegracht-waterstroom snapshot (GitHub Actions)' },
      });
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return (await res.json()) as OverpassResponse;
    } catch (err) {
      console.warn(String(err));
      lastError = err;
    }
  }
  throw lastError;
}

const response = await fetchOverpass(buildOverpassQuery(JUNCTION_BBOX));

// One element per line keeps diffs of future refreshes readable.
const lines = response.elements.map((el) => JSON.stringify(el));
writeFileSync(OUT, `{"elements":[\n${lines.join(',\n')}\n]}\n`);

// Report what the snapshot contains, so problems show up in the workflow log.
const scene = parseOverpassResponse(response, JUNCTION_BBOX);
console.log(`Wrote ${response.elements.length} elements.`);
console.log('Water bodies:', scene.waterBodies.map((w) => `${w.kind}:${w.name}`).join(', '));
console.log('Structures:', scene.structures.map((s) => `${s.kind}:${s.name}`).join(', '));
const named = response.elements
  .filter((el) => el.tags?.waterway || el.tags?.natural === 'water')
  .map(
    (el) => `${el.type}/${el.id} ${el.tags?.waterway ?? el.tags?.natural} "${el.tags?.name ?? ''}"`,
  );
console.log('Water elements:\n  ' + named.join('\n  '));
const kinds = new Set(scene.waterBodies.map((w) => w.kind));
const missing = (['dannegracht', 'vecht', 'ark'] as const).filter((k) => !kinds.has(k));
if (missing.length) console.warn(`WARNING: no water body classified as ${missing.join(', ')}`);
