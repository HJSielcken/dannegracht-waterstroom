// Bundled schematic scene used when the live Overpass query (src/geo/overpass.ts) is
// unavailable (offline, blocked, or erroring). Coordinates are approximate — see
// src/geo/RESEARCH.md for sources and confidence levels. Geometry is schematic
// (buffered from hand-estimated centerlines), not survey-accurate.

import type { LatLon, Probe, Scene, Structure, WaterBody } from '../types';
import { bufferCenterline } from './buffer';

/** Origin of the local metric frame: near the Dannegracht, close to Brugstraat. */
export const FALLBACK_ORIGIN: LatLon = { lat: 52.1732, lon: 4.9985 };

// ---------------------------------------------------------------------------
// Centerlines (see RESEARCH.md — ESTIMATED / schematic, not survey data)
// ---------------------------------------------------------------------------

/** River Vecht, ~1 km stretch through Breukelen centre, running roughly north to south. */
const VECHT_CENTERLINE: LatLon[] = [
  { lat: 52.1775, lon: 5.0055 },
  { lat: 52.1755, lon: 5.0045 },
  { lat: 52.1735, lon: 5.0035 }, // junction with the Danne
  { lat: 52.1715, lon: 5.0025 },
  { lat: 52.1695, lon: 5.0015 },
];

/** The Danne / Dannegracht, from the Vecht (east) to the Amsterdam-Rijnkanaal (west). */
const DANNE_CENTERLINE: LatLon[] = [
  { lat: 52.1735, lon: 5.0035 }, // = Vecht junction point above
  { lat: 52.1733, lon: 4.9985 },
  { lat: 52.173, lon: 4.9935 }, // junction with the ARK
];

/** Amsterdam-Rijnkanaal, ~1 km stretch around the Danne mouth, running north to south. */
const ARK_CENTERLINE: LatLon[] = [
  { lat: 52.178, lon: 4.9932 },
  { lat: 52.173, lon: 4.9935 }, // = Danne junction point above
  { lat: 52.168, lon: 4.9938 },
];

// ---------------------------------------------------------------------------
// Widths / depths (see RESEARCH.md)
// ---------------------------------------------------------------------------

const VECHT_HALF_WIDTH_M = 12.5; // ~25 m wide
const DANNE_HALF_WIDTH_M = 5; // ~10 m wide
const ARK_HALF_WIDTH_M = 55; // ~110 m wide

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

/** Point interpolated along the (east-Vecht -> west-ARK) Danne centerline by fraction t. */
function alongDanne(t: number): LatLon {
  const east = DANNE_CENTERLINE[0]!;
  const west = DANNE_CENTERLINE[2]!;
  return {
    lat: east.lat + (west.lat - east.lat) * t,
    lon: east.lon + (west.lon - east.lon) * t,
  };
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
 *  keeps the same probes, including the pinned Brugstraat 10e probe. */
export const FALLBACK_PROBES: Probe[] = [
  {
    id: 'brugstraat-10e',
    name: 'Brugstraat 10e',
    // APPROXIMATE — see RESEARCH.md. Prefer geocode('Brugstraat 10e, Breukelen') at
    // runtime; this is only the offline placeholder, placed near the Vecht-end
    // bridge/lock cluster consistent with the street/postcode research.
    position: { lat: 52.17355, lon: 5.001 },
    pinned: true,
  },
  {
    id: 'dannegracht-vecht-mouth',
    name: 'Dannegracht bij de Vecht',
    position: DANNE_CENTERLINE[0]!,
  },
  {
    id: 'dannegracht-ark-mouth',
    name: 'Dannegracht bij het Amsterdam-Rijnkanaal',
    position: DANNE_CENTERLINE[2]!,
  },
  {
    id: 'dannegracht-midway',
    name: 'Dannegracht (midden)',
    position: DANNE_CENTERLINE[1]!,
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
        DANNE_CENTERLINE,
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
