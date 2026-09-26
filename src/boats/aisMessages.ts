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
  /** Epoch ms of the last position report, i.e. the time `position` refers to. */
  positionAt?: number;
}

const KNOTS_TO_MS = 0.514444;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
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
      positionAt: position !== base.position ? now : base.positionAt,
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
  return {
    id: `ais:${track.mmsi}`,
    name: track.name,
    source: 'ais',
    position: track.position,
    courseDeg: track.courseDeg ?? 0,
    speedMs: track.speedMs ?? 0,
    lengthM,
    beamM,
    draughtM: hydro.draughtM,
    displacementM3: hydro.displacementM3,
    massKg: hydro.massKg,
    updatedAt: track.positionAt ?? track.updatedAt,
  };
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
  const rad = (boat.courseDeg * Math.PI) / 180;
  const east = boat.speedMs * Math.sin(rad) * t;
  const north = boat.speedMs * Math.cos(rad) * t;
  const { lat, lon } = boat.position;
  return {
    ...boat,
    position: {
      lat: lat + north / M_PER_DEG_LAT,
      lon: lon + east / (M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180)),
    },
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
