// Pure parsing/merging logic for aisstream.io messages.
//
// Kept separate from the WebSocket plumbing in ais.ts so it can be unit
// tested without a network or a real WebSocket implementation.
//
// aisstream.io message envelope (verified against
// https://aisstream.io/documentation and the public AsyncAPI spec at
// https://github.com/aisstream/ais-message-models):
//
//   {
//     "MessageType": "PositionReport" | "ShipStaticData" |
//                     "StandardClassBPositionReport" | "StaticDataReport" | ...,
//     "MetaData": { "MMSI": number, "ShipName"?: string,
//                   "latitude": number, "longitude": number,
//                   "time_utc": string },
//     "Message": { "<MessageType>": { ...decoded ITU-R M.1371 fields } }
//   }
//
// Class A vessels send PositionReport (dynamic) and ShipStaticData (static,
// incl. Dimension A/B/C/D, MaximumStaticDraught, Type, Name).
// Class B vessels (most small pleasure craft that carry AIS at all) send
// StandardClassBPositionReport (dynamic; no rate-of-turn, coarser fields)
// and StaticDataReport (static; same Dimension/Type shape, no draught field
// in Part A messages, so draught is nearly always unknown for these boats).
import type { Boat, LatLon } from '../types';
import { classifyHull, estimateHydrostatics } from './hydrostatics';

export interface AisMetaData {
  MMSI: number;
  ShipName?: string;
  latitude?: number;
  longitude?: number;
  Latitude?: number;
  Longitude?: number;
  time_utc?: string;
}

export interface AisPositionReportBody {
  Sog?: number; // knots
  Cog?: number; // degrees, true, clockwise from north
  TrueHeading?: number; // degrees, 511 = not available
  Latitude?: number;
  Longitude?: number;
}

export interface AisDimension {
  A?: number; // bow, metres from GPS antenna
  B?: number; // stern
  C?: number; // port
  D?: number; // starboard
}

export interface AisShipStaticDataBody {
  Name?: string;
  Dimension?: AisDimension;
  MaximumStaticDraught?: number; // metres, 0 = not available
  Type?: number; // AIS ship & cargo type code, 0-99
}

export type AisRawMessage =
  | {
      MessageType: 'PositionReport';
      MetaData: AisMetaData;
      Message: { PositionReport: AisPositionReportBody };
    }
  | {
      MessageType: 'StandardClassBPositionReport';
      MetaData: AisMetaData;
      Message: { StandardClassBPositionReport: AisPositionReportBody };
    }
  | {
      MessageType: 'ShipStaticData';
      MetaData: AisMetaData;
      Message: { ShipStaticData: AisShipStaticDataBody };
    }
  | {
      MessageType: 'StaticDataReport';
      MetaData: AisMetaData;
      // aisstream nests Part A / Part B report bodies for Class B static data.
      Message: {
        StaticDataReport: AisShipStaticDataBody & {
          ReportA?: AisShipStaticDataBody;
          ReportB?: AisShipStaticDataBody &
            Pick<AisDimension, never> & { Dimension?: AisDimension };
        };
      };
    };

/** Internal accumulator: everything we know about one MMSI so far. */
export interface AisTrack {
  mmsi: number;
  name?: string;
  position?: LatLon;
  courseDeg?: number;
  speedMs?: number;
  lengthM?: number;
  beamM?: number;
  draughtM?: number;
  shipTypeCode?: number;
  /** True once a class B message (the transponder type of most pleasure craft) was received. */
  classB?: boolean;
  /** Epoch ms of the last message (static or dynamic) received for this MMSI. */
  updatedAt: number;
  /** Epoch ms of the last position fix (its AIS timestamp), i.e. the time `position` refers to. */
  positionAt?: number;
  /** Metres from the GPS antenna forward to the middle of the hull, from Dimension A/B. */
  antennaForwardM?: number;
  /** Metres from the GPS antenna to starboard to the middle of the hull, from Dimension C/D. */
  antennaStarboardM?: number;
}

const KNOTS_TO_MS = 0.514444;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Epoch ms of an aisstream.io `time_utc` stamp such as "2026-09-25 10:00:00.123456 +0000 UTC",
 * or undefined if it cannot be read.
 */
export function parseAisTime(timeUtc: string | undefined): number | undefined {
  const m = timeUtc?.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d{1,3})?/);
  if (!m) return undefined;
  const t = Date.parse(`${m[1]}T${m[2]}${m[3] ?? ''}Z`);
  return Number.isFinite(t) ? t : undefined;
}

/** Narrow an arbitrary parsed-JSON value into a recognised AIS message, or null. */
export function parseAisRawMessage(raw: unknown): AisRawMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const type = obj['MessageType'];
  const metaData = obj['MetaData'];
  const message = obj['Message'];
  if (typeof type !== 'string' || typeof metaData !== 'object' || metaData === null) return null;
  if (typeof message !== 'object' || message === null) return null;
  const meta = metaData as Record<string, unknown>;
  if (!isFiniteNumber(meta['MMSI'])) return null;

  if (
    (type === 'PositionReport' ||
      type === 'StandardClassBPositionReport' ||
      type === 'ShipStaticData' ||
      type === 'StaticDataReport') &&
    Object.prototype.hasOwnProperty.call(message, type)
  ) {
    return raw as AisRawMessage;
  }
  return null;
}

/**
 * Apply one parsed AIS message to a track (creating it if `existing` is
 * undefined). Pure function: returns a new track, never mutates `existing`.
 */
export function applyAisMessage(
  existing: AisTrack | undefined,
  msg: AisRawMessage,
  now: number,
): AisTrack {
  const meta = msg.MetaData;
  const mmsi = meta.MMSI;
  const isClassB =
    msg.MessageType === 'StandardClassBPositionReport' || msg.MessageType === 'StaticDataReport';
  const known: AisTrack = existing ?? { mmsi, updatedAt: now };
  const base: AisTrack = isClassB ? { ...known, classB: true } : known;

  if (msg.MessageType === 'PositionReport' || msg.MessageType === 'StandardClassBPositionReport') {
    // The fix time is the AIS timestamp, not the time we received it: the relay replays reports
    // up to 10 minutes old to a client that just connected (server/ais.ts), and those must not
    // count as fresh. A timestamp ahead of our clock is taken as now.
    const fixAt = Math.min(now, parseAisTime(meta.time_utc) ?? now);
    // A report older than the fix we already have (a replay arriving after live data) is dropped.
    if (base.positionAt !== undefined && fixAt < base.positionAt) {
      return { ...base, mmsi, name: meta.ShipName ?? base.name, updatedAt: now };
    }
    const body =
      msg.MessageType === 'PositionReport'
        ? msg.Message.PositionReport
        : msg.Message.StandardClassBPositionReport;
    const lat = firstFinite(body.Latitude, meta.Latitude, meta.latitude);
    const lon = firstFinite(body.Longitude, meta.Longitude, meta.longitude);
    const position = lat !== undefined && lon !== undefined ? { lat, lon } : base.position;
    const speedMs =
      isFiniteNumber(body.Sog) && body.Sog < 102.3 ? body.Sog * KNOTS_TO_MS : base.speedMs;
    // Prefer true heading over course-over-ground when available and valid
    // (511/511.0 = not available); course over ground is the fallback and
    // is what we generally have for slow/stopped small craft anyway.
    const heading =
      isFiniteNumber(body.TrueHeading) && body.TrueHeading < 511 ? body.TrueHeading : undefined;
    const cog = isFiniteNumber(body.Cog) && body.Cog < 360 ? body.Cog : undefined;
    const courseDeg = heading ?? cog ?? base.courseDeg;
    return {
      ...base,
      mmsi,
      name: meta.ShipName ?? base.name,
      position,
      positionAt: position !== base.position ? fixAt : base.positionAt,
      speedMs,
      courseDeg,
      updatedAt: now,
    };
  }

  // ShipStaticData (class A) or StaticDataReport (class B).
  const staticBody: AisShipStaticDataBody =
    msg.MessageType === 'ShipStaticData'
      ? msg.Message.ShipStaticData
      : (msg.Message.StaticDataReport.ReportA ?? msg.Message.StaticDataReport);
  const dimensionSource: AisDimension | undefined =
    msg.MessageType === 'ShipStaticData'
      ? msg.Message.ShipStaticData.Dimension
      : (msg.Message.StaticDataReport.ReportB?.Dimension ?? msg.Message.StaticDataReport.Dimension);

  const a = numOr0(dimensionSource?.A);
  const b = numOr0(dimensionSource?.B);
  const c = numOr0(dimensionSource?.C);
  const d = numOr0(dimensionSource?.D);
  const lengthM = a + b > 0 ? a + b : base.lengthM;
  const beamM = c + d > 0 ? c + d : base.beamM;
  // The reported position is that of the GPS antenna, often near the stern of a cargo ship.
  // A zero on one side means the antenna position is unknown, so no offset then.
  const hasAB = a > 0 && b > 0;
  const hasCD = c > 0 && d > 0;

  return {
    ...base,
    mmsi,
    name: meta.ShipName ?? staticBody.Name ?? base.name,
    lengthM,
    beamM,
    draughtM:
      isFiniteNumber(staticBody.MaximumStaticDraught) && staticBody.MaximumStaticDraught > 0
        ? staticBody.MaximumStaticDraught
        : base.draughtM,
    shipTypeCode: isFiniteNumber(staticBody.Type) ? staticBody.Type : base.shipTypeCode,
    antennaForwardM: hasAB ? (a - b) / 2 : a + b > 0 ? undefined : base.antennaForwardM,
    antennaStarboardM: hasCD ? (d - c) / 2 : c + d > 0 ? undefined : base.antennaStarboardM,
    updatedAt: now,
  };
}

function firstFinite(...values: Array<number | undefined>): number | undefined {
  for (const v of values) {
    if (isFiniteNumber(v)) return v;
  }
  return undefined;
}

function numOr0(v: number | undefined): number {
  return isFiniteNumber(v) ? v : 0;
}

/** Stand-in hull for a class A vessel whose static data has not arrived yet: a Rijn-Herne ship. */
export const DEFAULT_CARGO_HULL = { lengthM: 86, beamM: 9.5, shipTypeCode: 79 } as const;
/** Stand-in hull for class B or pleasure-craft tracks without dimensions: a small motor boat. */
export const DEFAULT_SMALL_HULL = { lengthM: 8, beamM: 2.5 } as const;

/**
 * Convert a track into a `Boat`, if it has enough data (position + some
 * notion of size) to be worth showing. Missing dimensions fall back to a
 * generic hull so the boat still renders and drives the sim, rather than
 * being dropped: small for class B transponders and pleasure-craft type
 * codes, otherwise an inland cargo vessel, since class A AIS on the ARK is
 * mostly commercial shipping.
 */
export function trackToBoat(track: AisTrack): Boat | null {
  if (!track.position) return null;
  const small = track.classB === true || classifyHull(track.shipTypeCode) === 'pleasure-sailing';
  const fallback = small ? DEFAULT_SMALL_HULL : DEFAULT_CARGO_HULL;
  const hasLength = track.lengthM !== undefined && track.lengthM > 0;
  const lengthM = hasLength ? track.lengthM! : fallback.lengthM;
  const beamM = track.beamM && track.beamM > 0 ? track.beamM : fallback.beamM;
  const hydro = estimateHydrostatics({
    lengthM,
    beamM,
    draughtM: track.draughtM,
    // Without a type code, a guessed cargo hull should also get a cargo hull form.
    shipTypeCode:
      track.shipTypeCode ?? (!small && !hasLength ? DEFAULT_CARGO_HULL.shipTypeCode : undefined),
  });
  const courseDeg = track.courseDeg ?? 0;
  return {
    id: `ais:${track.mmsi}`,
    name: track.name,
    source: 'ais',
    position: hullCentre(track.position, courseDeg, track.antennaForwardM, track.antennaStarboardM),
    courseDeg,
    speedMs: track.speedMs ?? 0,
    lengthM,
    beamM,
    draughtM: hydro.draughtM,
    displacementM3: hydro.displacementM3,
    massKg: hydro.massKg,
    updatedAt: track.positionAt ?? track.updatedAt,
  };
}

/**
 * The middle of the hull, given the antenna position and heading: `forwardM` ahead of the antenna
 * and `starboardM` to its right. A 110 m ship with its antenna 10 m from the stern has its middle
 * 45 m ahead of the reported position, some 15 s of sailing at 3 m/s.
 */
export function hullCentre(
  antenna: LatLon,
  headingDeg: number,
  forwardM = 0,
  starboardM = 0,
): LatLon {
  let p = antenna;
  if (forwardM !== 0) p = moveAlong(p, headingDeg, forwardM);
  if (starboardM !== 0) p = moveAlong(p, headingDeg + 90, starboardM);
  return p;
}

/** Never extrapolate further than this (5 min) past the last fix; boats stop and turn. */
export const MAX_DEAD_RECKON_S = 300;
const M_PER_DEG_LAT = 111_320;

/**
 * AIS positions arrive every few seconds (class A underway) to several
 * minutes (class B), so between reports the boat is moved along its
 * reported course and speed from the time of the last fix. Capped at
 * `maxS` so a boat that went quiet doesn't drift off along a straight line.
 */
export function deadReckon(boat: Boat, now: number, maxS = MAX_DEAD_RECKON_S): Boat {
  const t = Math.min(maxS, Math.max(0, (now - boat.updatedAt) / 1000));
  if (t === 0 || boat.speedMs <= 0) return boat;
  return { ...boat, position: moveAlong(boat.position, boat.courseDeg, boat.speedMs * t) };
}

/**
 * Below this speed over ground (0.3 m/s, about 0.6 kn) an AIS boat counts as lying still:
 * moored boats report a few tenths of a knot of GPS jitter.
 */
export const MIN_UNDERWAY_MS = 0.3;

/** Whether an AIS boat is sailing, rather than moored or at anchor. */
export function isUnderway(boat: Boat): boolean {
  return boat.speedMs >= MIN_UNDERWAY_MS;
}

/** The point `distanceM` metres from `position` along `courseDeg` (clockwise from north). */
export function moveAlong(position: LatLon, courseDeg: number, distanceM: number): LatLon {
  const rad = (courseDeg * Math.PI) / 180;
  const { lat, lon } = position;
  return {
    lat: lat + (distanceM * Math.cos(rad)) / M_PER_DEG_LAT,
    lon: lon + (distanceM * Math.sin(rad)) / (M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180)),
  };
}

/** Drop tracks whose last update is older than `maxAgeMs`. Pure, returns a new Map. */
export function pruneStaleTracks(
  tracks: Map<number, AisTrack>,
  now: number,
  maxAgeMs: number,
): Map<number, AisTrack> {
  const next = new Map<number, AisTrack>();
  for (const [mmsi, track] of tracks) {
    if (now - track.updatedAt <= maxAgeMs) next.set(mmsi, track);
  }
  return next;
}

export const STALE_AFTER_MS = 10 * 60 * 1000;
