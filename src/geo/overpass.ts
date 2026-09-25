// Loads live water geometry from OpenStreetMap via the Overpass API. Runs in the
// browser (Overpass/OSM are unreachable from the sandboxed environment this module was
// developed in — see RESEARCH.md). Parsing is factored out as pure functions
// (`parseOverpassResponse` and friends) so it can be unit tested against fixtures
// without any network access; `loadSceneFromOsm` is the only part that talks to the
// network and it is a thin wrapper around them.

import type { LatLon, Scene, Structure, StructureKind, WaterBody, WaterBodyKind } from '../types';
import { FALLBACK_ORIGIN, FALLBACK_PROBES } from './fallback';

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

/** Bounding box around the Vecht / Dannegracht / Amsterdam-Rijnkanaal junction area. */
export interface BBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** Area around the Dannegracht, wide enough to include the ARK west of Breukelen station. */
export const JUNCTION_BBOX: BBox = {
  south: 52.162,
  west: 4.975,
  north: 52.184,
  east: 5.015,
};

const DEPTH_DEFAULTS_M: Record<WaterBodyKind, number> = {
  vecht: 2.5,
  dannegracht: 1.8,
  ark: 5.5,
  other: 2.0,
};

// ---------------------------------------------------------------------------
// Overpass wire types (subset of `out geom` JSON we rely on)
// ---------------------------------------------------------------------------

export interface OverpassLatLon {
  lat: number;
  lon: number;
}

export interface OverpassMember {
  type: 'node' | 'way' | 'relation';
  ref: number;
  role: string;
  geometry?: OverpassLatLon[];
  lat?: number;
  lon?: number;
}

export interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  geometry?: OverpassLatLon[];
  members?: OverpassMember[];
}

export interface OverpassResponse {
  elements: OverpassElement[];
}

// ---------------------------------------------------------------------------
// Query building
// ---------------------------------------------------------------------------

export function buildOverpassQuery(bbox: BBox): string {
  const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  return `
[out:json][timeout:25];
(
  way["natural"="water"](${b});
  way["waterway"="riverbank"](${b});
  way["water"~"^(river|canal)$"](${b});
  relation["natural"="water"]["type"="multipolygon"](${b});
  relation["waterway"="riverbank"]["type"="multipolygon"](${b});
  way["waterway"~"^(river|canal|stream|drain|ditch)$"](${b});
  node["waterway"="lock_gate"](${b});
  way["lock"="yes"](${b});
  node["waterway"="weir"](${b});
  way["waterway"="weir"](${b});
  way["tunnel"="culvert"](${b});
  node["tunnel"="culvert"](${b});
  way["man_made"="bridge"](${b});
  way["bridge"="yes"]["waterway"](${b});
);
out geom;
`.trim();
}

// ---------------------------------------------------------------------------
// Geometry helpers (pure)
// ---------------------------------------------------------------------------

const COORD_EPS = 1e-7;

function samePoint(a: OverpassLatLon, b: OverpassLatLon): boolean {
  return Math.abs(a.lat - b.lat) < COORD_EPS && Math.abs(a.lon - b.lon) < COORD_EPS;
}

function toLatLonArr(pts: OverpassLatLon[]): LatLon[] {
  return pts.map((p) => ({ lat: p.lat, lon: p.lon }));
}

/** Drops a duplicated closing point (ring where first == last), if present. */
function openRing(ring: LatLon[]): LatLon[] {
  if (ring.length >= 2) {
    const first = ring[0]!;
    const last = ring[ring.length - 1]!;
    if (Math.abs(first.lat - last.lat) < COORD_EPS && Math.abs(first.lon - last.lon) < COORD_EPS) {
      return ring.slice(0, -1);
    }
  }
  return ring;
}

/**
 * Joins a set of (possibly split) way segments sharing endpoints into closed rings.
 * This implements the OSM multipolygon assembly step: a relation's outer/inner role
 * is often split across several ways that need to be strung together by matching
 * shared end nodes. Segments that never close are still returned (best effort) so
 * callers can decide whether to keep or discard them.
 */
export function joinWaysIntoRings(segments: OverpassLatLon[][]): LatLon[][] {
  const remaining = segments.map((s) => s.slice()).filter((s) => s.length >= 2);
  const rings: LatLon[][] = [];

  while (remaining.length > 0) {
    let chain = remaining.shift()!;
    let extended = true;
    while (extended && !samePoint(chain[0]!, chain[chain.length - 1]!)) {
      extended = false;
      for (let i = 0; i < remaining.length; i++) {
        const seg = remaining[i]!;
        const chainEnd = chain[chain.length - 1]!;
        if (samePoint(seg[0]!, chainEnd)) {
          chain = chain.concat(seg.slice(1));
          remaining.splice(i, 1);
          extended = true;
          break;
        }
        if (samePoint(seg[seg.length - 1]!, chainEnd)) {
          chain = chain.concat(seg.slice(0, -1).reverse());
          remaining.splice(i, 1);
          extended = true;
          break;
        }
      }
    }
    rings.push(openRing(toLatLonArr(chain)));
  }

  return rings;
}

/** Sutherland-Hodgman polygon clip against an axis-aligned lat/lon bbox. */
export function clipRingToBBox(ring: LatLon[], bbox: BBox): LatLon[] {
  type Edge = (p: LatLon) => boolean;
  const edges: { inside: Edge; intersect: (a: LatLon, b: LatLon) => LatLon }[] = [
    {
      inside: (p) => p.lon >= bbox.west,
      intersect: (a, b) => lerpAtLon(a, b, bbox.west),
    },
    {
      inside: (p) => p.lon <= bbox.east,
      intersect: (a, b) => lerpAtLon(a, b, bbox.east),
    },
    {
      inside: (p) => p.lat >= bbox.south,
      intersect: (a, b) => lerpAtLat(a, b, bbox.south),
    },
    {
      inside: (p) => p.lat <= bbox.north,
      intersect: (a, b) => lerpAtLat(a, b, bbox.north),
    },
  ];

  function lerpAtLon(a: LatLon, b: LatLon, lon: number): LatLon {
    const t = (lon - a.lon) / (b.lon - a.lon);
    return { lat: a.lat + (b.lat - a.lat) * t, lon };
  }
  function lerpAtLat(a: LatLon, b: LatLon, lat: number): LatLon {
    const t = (lat - a.lat) / (b.lat - a.lat);
    return { lat, lon: a.lon + (b.lon - a.lon) * t };
  }

  let output = ring;
  for (const edge of edges) {
    if (output.length === 0) break;
    const input = output;
    output = [];
    for (let i = 0; i < input.length; i++) {
      const curr = input[i]!;
      const prev = input[(i - 1 + input.length) % input.length]!;
      const currIn = edge.inside(curr);
      const prevIn = edge.inside(prev);
      if (currIn) {
        if (!prevIn) output.push(edge.intersect(prev, curr));
        output.push(curr);
      } else if (prevIn) {
        output.push(edge.intersect(prev, curr));
      }
    }
  }
  return output;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function classifyByName(name: string | undefined): WaterBodyKind | null {
  if (!name) return null;
  const n = name.toLowerCase();
  if (n.includes('amsterdam-rijnkanaal') || n === 'ark' || n.includes('rijnkanaal')) return 'ark';
  if (n.includes('dannegracht') || n.includes('danne')) return 'dannegracht';
  if (n === 'vecht' || n.includes('vecht')) return 'vecht';
  return null;
}

function ringCentroid(ring: LatLon[]): LatLon {
  const n = ring.length || 1;
  const sum = ring.reduce((acc, p) => ({ lat: acc.lat + p.lat, lon: acc.lon + p.lon }), {
    lat: 0,
    lon: 0,
  });
  return { lat: sum.lat / n, lon: sum.lon / n };
}

function dist2(a: LatLon, b: LatLon): number {
  const dLat = a.lat - b.lat;
  const dLon = a.lon - b.lon;
  return dLat * dLat + dLon * dLon;
}

/** Named waterway line used as a fallback classification hint for unnamed polygons. */
interface NamedLine {
  kind: WaterBodyKind;
  points: LatLon[];
}

function classifyByProximity(centroid: LatLon, lines: NamedLine[]): WaterBodyKind {
  let best: { kind: WaterBodyKind; d: number } | null = null;
  for (const line of lines) {
    for (const p of line.points) {
      const d = dist2(centroid, p);
      if (!best || d < best.d) best = { kind: line.kind, d };
    }
  }
  return best?.kind ?? 'other';
}

// ---------------------------------------------------------------------------
// Element classification helpers
// ---------------------------------------------------------------------------

function isWaterPolygonWay(tags: Record<string, string>): boolean {
  return (
    tags.natural === 'water' ||
    tags.waterway === 'riverbank' ||
    tags.water === 'river' ||
    tags.water === 'canal'
  );
}

function isWaterwayLine(tags: Record<string, string>): boolean {
  return ['river', 'canal', 'stream', 'drain', 'ditch'].includes(tags.waterway ?? '');
}

function structureKindOf(tags: Record<string, string>): StructureKind | null {
  if (tags.waterway === 'lock_gate' || tags.lock === 'yes') return 'lock';
  if (tags.waterway === 'weir') return 'weir';
  if (tags.tunnel === 'culvert') return 'culvert';
  if (tags.man_made === 'bridge' || (tags.bridge === 'yes' && tags.waterway)) return 'bridge';
  return null;
}

function elementCentroid(el: OverpassElement): LatLon | null {
  if (el.type === 'node' && el.lat !== undefined && el.lon !== undefined) {
    return { lat: el.lat, lon: el.lon };
  }
  if (el.geometry && el.geometry.length > 0) {
    return ringCentroid(toLatLonArr(el.geometry));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Response parsing (pure — this is what's unit tested)
// ---------------------------------------------------------------------------

export function parseOverpassResponse(response: OverpassResponse, bbox: BBox): Scene {
  const elements = response.elements ?? [];

  const namedLines: NamedLine[] = [];
  for (const el of elements) {
    if (el.type !== 'way' || !el.tags || !el.geometry) continue;
    if (!isWaterwayLine(el.tags)) continue;
    const kind = classifyByName(el.tags.name);
    if (kind) namedLines.push({ kind, points: toLatLonArr(el.geometry) });
  }

  const waterBodies: WaterBody[] = [];
  let anonIdx = 0;

  for (const el of elements) {
    if (el.type === 'way' && el.tags && el.geometry && isWaterPolygonWay(el.tags)) {
      const ring = clipRingToBBox(openRing(toLatLonArr(el.geometry)), bbox);
      if (ring.length < 3) continue;
      const kind =
        classifyByName(el.tags.name) ?? classifyByProximity(ringCentroid(ring), namedLines);
      waterBodies.push({
        id: `way-${el.id}`,
        kind,
        name: el.tags.name ?? kind,
        rings: [ring],
        depthM: DEPTH_DEFAULTS_M[kind],
      });
      continue;
    }

    if (el.type === 'relation' && el.tags && el.members) {
      const isMultipolygonWater =
        el.tags.type === 'multipolygon' &&
        (el.tags.natural === 'water' || el.tags.waterway === 'riverbank');
      if (!isMultipolygonWater) continue;

      const outerSegs = el.members
        .filter((m) => m.role === 'outer' && m.geometry)
        .map((m) => m.geometry!);
      const innerSegs = el.members
        .filter((m) => m.role === 'inner' && m.geometry)
        .map((m) => m.geometry!);

      const outerRings = joinWaysIntoRings(outerSegs).filter((r) => r.length >= 3);
      const innerRings = joinWaysIntoRings(innerSegs).filter((r) => r.length >= 3);

      for (const outer of outerRings) {
        const clippedOuter = clipRingToBBox(outer, bbox);
        if (clippedOuter.length < 3) continue;
        const kind =
          classifyByName(el.tags.name) ??
          classifyByProximity(ringCentroid(clippedOuter), namedLines);
        const rings = [
          clippedOuter,
          ...innerRings.map((r) => clipRingToBBox(r, bbox)).filter((r) => r.length >= 3),
        ];
        waterBodies.push({
          id: `rel-${el.id}-${anonIdx++}`,
          kind,
          name: el.tags.name ?? kind,
          rings,
          depthM: DEPTH_DEFAULTS_M[kind],
        });
      }
    }
  }

  const structures: Structure[] = [];
  for (const el of elements) {
    if (!el.tags) continue;
    const kind = structureKindOf(el.tags);
    if (!kind) continue;
    const position = elementCentroid(el);
    if (!position) continue;
    structures.push({
      id: `${el.type}-${el.id}`,
      kind,
      name: el.tags.name ?? `${kind} (${el.type} ${el.id})`,
      position,
      blocksFlow: kind === 'lock' || kind === 'weir',
      ...(kind === 'bridge' || kind === 'culvert' ? { openFraction: 0.85 } : {}),
    });
  }

  return {
    origin: FALLBACK_ORIGIN,
    waterBodies,
    structures,
    probes: FALLBACK_PROBES,
    source: 'osm',
  };
}

// ---------------------------------------------------------------------------
// Network loader
// ---------------------------------------------------------------------------

async function fetchOverpass(query: string, signal?: AbortSignal): Promise<OverpassResponse> {
  let lastError: unknown;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        body: `data=${encodeURIComponent(query)}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal,
      });
      if (!res.ok) {
        lastError = new Error(`Overpass ${endpoint} responded ${res.status}`);
        continue;
      }
      return (await res.json()) as OverpassResponse;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Overpass request failed');
}

/**
 * Loads the water geometry scene live from OpenStreetMap/Overpass. Throws on any
 * network/parse failure — callers (e.g. the scene loader in src/ui) should catch and
 * fall back to `fallbackScene()` from `./fallback`.
 */
export async function loadSceneFromOsm(signal?: AbortSignal): Promise<Scene> {
  const query = buildOverpassQuery(JUNCTION_BBOX);
  const response = await fetchOverpass(query, signal);
  return parseOverpassResponse(response, JUNCTION_BBOX);
}
