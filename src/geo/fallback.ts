// Bundled schematic scene used when the live Overpass query (src/geo/overpass.ts) is
// unavailable (offline, blocked, or erroring). Coordinates are approximate — see
// src/geo/RESEARCH.md for sources and confidence levels. Geometry is schematic
// (buffered from hand-estimated centerlines), not survey-accurate.

import type { LatLon, Probe, Scene, Structure, WaterBody } from '../types';
import { bufferCenterline } from './buffer';
import { toLatLon, toMetric } from './project';

/** Origin of the local metric frame: near the Dannegracht, close to Brugstraat. */
export const FALLBACK_ORIGIN: LatLon = { lat: 52.1732, lon: 4.9985 };

// ---------------------------------------------------------------------------
// Centerlines (see RESEARCH.md — ESTIMATED / schematic, not survey data)
// ---------------------------------------------------------------------------

// Traced from a screenshot of the app over the OpenStreetMap basemap (2026-09-25), georeferenced
// with the app's own markers: 1 px = 1/41200 deg lon = 1/66750 deg lat. Station Breukelen
// (4.9906 E) lands on its map label, which confirms the fit. Accuracy is roughly 10-20 m.

/** River Vecht through Breukelen, north to south: along the Straatweg, bending south-east at the centre. */
const VECHT_CENTERLINE: LatLon[] = [
  { lat: 52.18166, lon: 5.00666 },
  { lat: 52.18002, lon: 5.00532 },
  { lat: 52.17807, lon: 5.00411 },
  { lat: 52.17627, lon: 5.00374 },
  { lat: 52.17462, lon: 5.00382 },
  { lat: 52.17313, lon: 5.00423 },
  { lat: 52.17208, lon: 5.00556 }, // near the Danne mouth
  { lat: 52.17088, lon: 5.0075 },
  { lat: 52.16923, lon: 5.0092 },
  { lat: 52.16713, lon: 5.0103 },
];

/**
 * The Danne / Dannegracht, from the Vecht (east, near Markt/Kerkvaart) along the Stationsweg to
 * the Amsterdam-Rijnkanaal (west). The route along the Stationsweg is inferred from the bridges
 * over the Danne there (RESEARCH.md); the gracht itself is too narrow to show at the traced zoom.
 */
const DANNE_CENTERLINE: LatLon[] = [
  { lat: 52.17185, lon: 5.00593 }, // Vecht
  { lat: 52.17155, lon: 5.00411 },
  { lat: 52.17136, lon: 5.00217 },
  { lat: 52.17118, lon: 4.99962 },
  { lat: 52.17107, lon: 4.99731 },
  { lat: 52.17098, lon: 4.99513 }, // ~30 m into the ARK, past its east bank
];

/** Amsterdam-Rijnkanaal west of Breukelen centre, north to south, running slightly NNW-SSE. */
const ARK_CENTERLINE: LatLon[] = [
  { lat: 52.18166, lon: 4.99411 },
  { lat: 52.17702, lon: 4.9942 },
  { lat: 52.17253, lon: 4.99452 },
  { lat: 52.16953, lon: 4.99493 },
  { lat: 52.16653, lon: 4.99537 },
];

/** Route through the Dannegracht, Vecht side first; used for virtual boats. */
export const DANNEGRACHT_ROUTE: readonly LatLon[] = DANNE_CENTERLINE;

/**
 * Route along the Amsterdam-Rijnkanaal, north to south; used for virtual boats. Follows the
 * ARK centerline but stops ~80 m short of both ends, so even a 110 m vessel stays in the water
 * when it turns around.
 */
export const ARK_ROUTE: readonly LatLon[] = [
  { lat: 52.18094, lon: 4.99412 },
  ...ARK_CENTERLINE.slice(1, -1),
  { lat: 52.16725, lon: 4.99527 },
];

/**
 * How far the Danne polygon runs on past each river's centerline, so the schematic
 * water bodies clearly overlap instead of only touching at the junction. Both stay
 * inside the far bank (Vecht half-width 15 m, ARK half-width 57 m).
 */
const DANNE_OVERLAP_VECHT_M = 10;
const DANNE_OVERLAP_ARK_M = 45;

/** Prolongs a polyline straight on at both ends by the given distances (metres). */
function extendPolyline(line: LatLon[], startM: number, endM: number): LatLon[] {
  const pts = line.map((p) => toMetric(p, FALLBACK_ORIGIN));
  const prolong = (from: { x: number; y: number }, to: { x: number; y: number }, d: number) => {
    const len = Math.hypot(to.x - from.x, to.y - from.y) || 1;
    return toLatLon(
      { x: to.x + ((to.x - from.x) / len) * d, y: to.y + ((to.y - from.y) / len) * d },
      FALLBACK_ORIGIN,
    );
  };
  const n = pts.length;
  return [prolong(pts[1]!, pts[0]!, startM), ...line, prolong(pts[n - 2]!, pts[n - 1]!, endM)];
}

// ---------------------------------------------------------------------------
// Widths / depths (see RESEARCH.md)
// ---------------------------------------------------------------------------

const VECHT_HALF_WIDTH_M = 15; // ~30 m wide (screenshot)
const DANNE_HALF_WIDTH_M = 5; // ~10 m wide
const ARK_HALF_WIDTH_M = 57; // ~115 m wide (screenshot)

const VECHT_DEPTH_M = 2.5;
const DANNE_DEPTH_M = 1.8;
const ARK_DEPTH_M = 5.5;

function waterBody(
  id: string,
  kind: WaterBody['kind'],
  name: string,
  centerline: LatLon[],
  halfWidthM: number,
  depthM: number,
): WaterBody {
  return {
    id,
    kind,
    name,
    rings: [bufferCenterline(centerline, halfWidthM, FALLBACK_ORIGIN)],
    depthM,
  };
}

// ---------------------------------------------------------------------------
// Structures (see RESEARCH.md for sourcing/confidence of each)
// ---------------------------------------------------------------------------

const DANNE_METRIC = DANNE_CENTERLINE.map((p) => toMetric(p, FALLBACK_ORIGIN));
const DANNE_SEGMENTS = DANNE_METRIC.slice(1).map((b, i) =>
  Math.hypot(b.x - DANNE_METRIC[i]!.x, b.y - DANNE_METRIC[i]!.y),
);
const DANNE_LENGTH_M = DANNE_SEGMENTS.reduce((a, b) => a + b, 0);

/** Point at fraction t (0 = Vecht, 1 = ARK) of the length along the Danne centerline. */
function alongDanne(t: number): LatLon {
  const pts = DANNE_METRIC;
  const seg = DANNE_SEGMENTS;
  let remaining = t * DANNE_LENGTH_M;
  for (let i = 0; i < seg.length; i++) {
    const len = seg[i]!;
    if (remaining <= len || i === seg.length - 1) {
      const f = len > 0 ? Math.min(1, remaining / len) : 0;
      const a = pts[i]!;
      const b = pts[i + 1]!;
      return toLatLon({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }, FALLBACK_ORIGIN);
    }
    remaining -= len;
  }
  return DANNE_CENTERLINE[DANNE_CENTERLINE.length - 1]!;
}

const structures: Structure[] = [
  {
    id: 'schutsluis-dannegracht',
    kind: 'lock',
    name: 'Schutsluis Dannegracht (rijksmonument, bij Straatweg/Kerkbrink)',
    position: alongDanne(0.32),
    blocksFlow: true,
  },
  {
    id: 'brug-stationsweg-1',
    kind: 'bridge',
    name: 'Ophaalbrug Stationsweg 1',
    position: alongDanne(0.1),
    blocksFlow: false,
    openFraction: 0.85,
  },
  {
    id: 'brug-stationsweg-37',
    kind: 'bridge',
    name: 'Ophaalbrug Stationsweg 37',
    position: alongDanne(0.25),
    blocksFlow: false,
    openFraction: 0.85,
  },
  {
    id: 'straatwegbrug',
    kind: 'bridge',
    name: 'Straatwegbrug (Straatweg/Kerkbrink, bij de oude sluis)',
    position: alongDanne(0.35),
    blocksFlow: false,
    openFraction: 0.8,
  },
  {
    id: 'brug-molenwerf',
    kind: 'bridge',
    name: 'Ophaalbrug Molenwerf 14',
    position: alongDanne(0.55),
    blocksFlow: false,
    openFraction: 0.85,
  },
  {
    id: 'brug-dannegracht-9',
    kind: 'bridge',
    name: 'Ophaalbrug Dannegracht 9',
    position: alongDanne(0.75),
    blocksFlow: false,
    openFraction: 0.85,
  },
];

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

/** Probe set shared with the live OSM scene (src/geo/overpass.ts) so switching sources
 *  keeps the same probes. */
export const FALLBACK_PROBES: Probe[] = [
  {
    // The centerline starts on the Vecht centerline; its bank is ~15 m further, so this
    // sits ~15 m inside the gracht.
    id: 'dannegracht-vecht-mouth',
    name: 'Dannegracht bij de Vecht',
    position: alongDanne(30 / DANNE_LENGTH_M),
  },
  {
    // The centerline ends ~30 m inside the ARK, so this sits ~20 m inside the gracht.
    // (At 97 % of the length the probe used to measure the ARK itself.)
    id: 'dannegracht-ark-mouth',
    name: 'Dannegracht bij het Amsterdam-Rijnkanaal',
    position: alongDanne(1 - 50 / DANNE_LENGTH_M),
  },
  {
    id: 'dannegracht-midway',
    name: 'Dannegracht (midden)',
    position: alongDanne(0.5),
  },
];

// ---------------------------------------------------------------------------

/** Bundled offline schematic scene. See src/geo/RESEARCH.md for provenance. */
export function fallbackScene(): Scene {
  return {
    origin: FALLBACK_ORIGIN,
    waterBodies: [
      waterBody('vecht', 'vecht', 'Vecht', VECHT_CENTERLINE, VECHT_HALF_WIDTH_M, VECHT_DEPTH_M),
      waterBody(
        'dannegracht',
        'dannegracht',
        'Dannegracht',
        extendPolyline(DANNE_CENTERLINE, DANNE_OVERLAP_VECHT_M, DANNE_OVERLAP_ARK_M),
        DANNE_HALF_WIDTH_M,
        DANNE_DEPTH_M,
      ),
      waterBody(
        'ark',
        'ark',
        'Amsterdam-Rijnkanaal',
        ARK_CENTERLINE,
        ARK_HALF_WIDTH_M,
        ARK_DEPTH_M,
      ),
    ],
    structures,
    probes: FALLBACK_PROBES,
    source: 'fallback',
  };
}
