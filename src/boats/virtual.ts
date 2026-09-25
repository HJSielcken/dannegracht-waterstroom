// Virtual (user-launched) boats: given a path (polyline of LatLon waypoints)
// and a preset, advance a boat along the path over time.
import type { Boat, LatLon } from '../types';
import { estimateHydrostatics, type AisShipTypeCode } from './hydrostatics';

export type VirtualBoatPresetId = 'sloep' | 'motorjacht' | 'rondvaartboot' | 'binnenvaartschip';

export interface VirtualBoatPreset {
  id: VirtualBoatPresetId;
  label: string;
  lengthM: number;
  beamM: number;
  draughtM: number;
  /** AIS ship-type code used only to pick a block coefficient for the hydrostatics estimate. */
  shipTypeCode: AisShipTypeCode;
  /** Typical cruising speed on a canal like this, m/s. */
  defaultSpeedMs: number;
}

// Dimensions are typical/representative, not any specific vessel:
//  - sloep: small open motor boat common on Dutch canals, ~6 m.
//  - motorjacht: mid-size motor yacht, ~12 m.
//  - rondvaartboot: canal tour boat, ~20 m, shallow draught, flat bottom.
//  - binnenvaartschip: large inland cargo vessel (CEMT class Va, "Large
//    Rhine vessel"), ~110 m x 11.4 m beam — about the largest that could
//    plausibly transit the ARK, included as a stress-test case for the sim
//    even though such a ship would not realistically enter the Dannegracht
//    itself.
export const VIRTUAL_BOAT_PRESETS: Record<VirtualBoatPresetId, VirtualBoatPreset> = {
  sloep: {
    id: 'sloep',
    label: 'Sloep',
    lengthM: 6,
    beamM: 2.2,
    draughtM: 0.5,
    shipTypeCode: 37, // pleasure craft
    defaultSpeedMs: 2.5, // ~5 kn, typical canal cruising speed
  },
  motorjacht: {
    id: 'motorjacht',
    label: 'Motorjacht',
    lengthM: 12,
    beamM: 3.8,
    draughtM: 1.1,
    shipTypeCode: 37,
    defaultSpeedMs: 3.6, // ~7 kn
  },
  rondvaartboot: {
    id: 'rondvaartboot',
    label: 'Rondvaartboot',
    lengthM: 20,
    beamM: 4.2,
    draughtM: 1.0,
    shipTypeCode: 60, // passenger
    defaultSpeedMs: 2.8,
  },
  binnenvaartschip: {
    id: 'binnenvaartschip',
    label: 'Binnenvaartschip (Va-klasse)',
    lengthM: 110,
    beamM: 11.4,
    draughtM: 3.5,
    shipTypeCode: 79, // cargo
    defaultSpeedMs: 3.0,
  },
};

export type VirtualBoatMode = 'ping-pong' | 'stop';

export interface VirtualBoatSpec {
  id: string;
  name?: string;
  preset: VirtualBoatPresetId;
  path: LatLon[];
  speedMs?: number;
  mode?: VirtualBoatMode;
}

interface PathSegment {
  from: LatLon;
  to: LatLon;
  lengthM: number;
  bearingDeg: number;
}

/** Live, advanceable virtual boat. */
export class VirtualBoat {
  readonly id: string;
  readonly name: string | undefined;
  readonly preset: VirtualBoatPreset;
  readonly path: LatLon[];
  readonly speedMs: number;
  readonly mode: VirtualBoatMode;

  private segments: PathSegment[];
  private totalLengthM: number;
  /** Signed distance travelled along the path, metres; can exceed length in ping-pong mode's internal bookkeeping before folding. */
  private distanceM = 0;
  private direction: 1 | -1 = 1;
  private stopped = false;

  constructor(spec: VirtualBoatSpec) {
    if (spec.path.length < 2) {
      throw new Error(`VirtualBoat "${spec.id}" needs a path with at least 2 points`);
    }
    this.id = spec.id;
    this.name = spec.name;
    this.preset = VIRTUAL_BOAT_PRESETS[spec.preset];
    this.path = spec.path;
    this.speedMs = spec.speedMs ?? this.preset.defaultSpeedMs;
    this.mode = spec.mode ?? 'ping-pong';
    this.segments = buildSegments(spec.path);
    this.totalLengthM = this.segments.reduce((sum, s) => sum + s.lengthM, 0);
  }

  /** Advance the boat by `dtS` seconds of simulated time. */
  advance(dtS: number): void {
    if (this.stopped || this.totalLengthM <= 0) return;
    this.distanceM += this.direction * this.speedMs * dtS;
    if (this.distanceM >= this.totalLengthM) {
      if (this.mode === 'stop') {
        this.distanceM = this.totalLengthM;
        this.stopped = true;
      } else {
        this.distanceM = this.totalLengthM - (this.distanceM - this.totalLengthM);
        this.distanceM = clamp(this.distanceM, 0, this.totalLengthM);
        this.direction = -1;
      }
    } else if (this.distanceM <= 0) {
      if (this.mode === 'stop') {
        this.distanceM = 0;
        this.stopped = true;
      } else {
        this.distanceM = -this.distanceM;
        this.distanceM = clamp(this.distanceM, 0, this.totalLengthM);
        this.direction = 1;
      }
    }
  }

  /** Current state as a `Boat`, for the given wall-clock timestamp. */
  toBoat(updatedAt: number): Boat {
    const { position, bearingDeg } = sampleAt(this.segments, this.distanceM);
    const speedMs = this.stopped ? 0 : this.speedMs;
    const hydro = estimateHydrostatics({
      lengthM: this.preset.lengthM,
      beamM: this.preset.beamM,
      draughtM: this.preset.draughtM,
      shipTypeCode: this.preset.shipTypeCode,
    });
    return {
      id: this.id,
      name: this.name ?? this.preset.label,
      source: 'virtual',
      position,
      courseDeg: bearingDeg,
      speedMs,
      lengthM: this.preset.lengthM,
      beamM: this.preset.beamM,
      draughtM: hydro.draughtM,
      displacementM3: hydro.displacementM3,
      massKg: hydro.massKg,
      updatedAt,
    };
  }
}

function buildSegments(path: LatLon[]): PathSegment[] {
  const segments: PathSegment[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const from = path[i]!;
    const to = path[i + 1]!;
    segments.push({ from, to, lengthM: haversineM(from, to), bearingDeg: bearingDegOf(from, to) });
  }
  return segments;
}

function sampleAt(
  segments: PathSegment[],
  distanceM: number,
): { position: LatLon; bearingDeg: number } {
  let remaining = clamp(
    distanceM,
    0,
    segments.reduce((s, seg) => s + seg.lengthM, 0),
  );
  for (const seg of segments) {
    if (remaining <= seg.lengthM || seg === segments[segments.length - 1]) {
      const t = seg.lengthM > 0 ? clamp(remaining / seg.lengthM, 0, 1) : 0;
      return { position: lerpLatLon(seg.from, seg.to, t), bearingDeg: seg.bearingDeg };
    }
    remaining -= seg.lengthM;
  }
  const last = segments[segments.length - 1]!;
  return { position: last.to, bearingDeg: last.bearingDeg };
}

function lerpLatLon(a: LatLon, b: LatLon, t: number): LatLon {
  return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
}

const EARTH_RADIUS_M = 6371000;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}
function toDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

/** Equirectangular-approximation distance in metres; fine at Dannegracht scale (<< 1 km). */
function haversineM(a: LatLon, b: LatLon): number {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b, degrees clockwise from true north. */
function bearingDegOf(a: LatLon, b: LatLon): number {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const deg = toDeg(Math.atan2(y, x));
  return (deg + 360) % 360;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
