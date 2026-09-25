import { describe, expect, it } from 'vitest';
import {
  applyAisMessage,
  parseAisRawMessage,
  pruneStaleTracks,
  trackToBoat,
  type AisRawMessage,
  type AisTrack,
} from './aisMessages';

const classAStatic: AisRawMessage = {
  MessageType: 'ShipStaticData',
  MetaData: { MMSI: 244660000, ShipName: 'RIJNVAART', latitude: 52.173, longitude: 5.0 },
  Message: {
    ShipStaticData: {
      Name: 'RIJNVAART',
      Dimension: { A: 90, B: 20, C: 5, D: 6 },
      MaximumStaticDraught: 3.2,
      Type: 79,
    },
  },
};

const classAPosition: AisRawMessage = {
  MessageType: 'PositionReport',
  MetaData: {
    MMSI: 244660000,
    latitude: 52.174,
    longitude: 5.001,
    time_utc: '2026-09-25 10:00:00 +0000 UTC',
  },
  Message: {
    PositionReport: { Sog: 6.0, Cog: 88.5, TrueHeading: 89, Latitude: 52.174, Longitude: 5.001 },
  },
};

const classBStatic: AisRawMessage = {
  MessageType: 'StaticDataReport',
  MetaData: { MMSI: 244001234, ShipName: 'SLOEPJE' },
  Message: {
    StaticDataReport: {
      ReportA: { Name: 'SLOEPJE' },
      ReportB: { Dimension: { A: 4, B: 2, C: 1, D: 1 } },
      Dimension: undefined,
    },
  },
};

const classBPosition: AisRawMessage = {
  MessageType: 'StandardClassBPositionReport',
  MetaData: { MMSI: 244001234, latitude: 52.171, longitude: 4.999 },
  Message: {
    StandardClassBPositionReport: {
      Sog: 2.0,
      Cog: 270,
      TrueHeading: 511,
      Latitude: 52.171,
      Longitude: 4.999,
    },
  },
};

describe('parseAisRawMessage', () => {
  it('accepts recognised message types with MMSI', () => {
    expect(parseAisRawMessage(classAStatic)).not.toBeNull();
    expect(parseAisRawMessage(classAPosition)).not.toBeNull();
    expect(parseAisRawMessage(classBStatic)).not.toBeNull();
    expect(parseAisRawMessage(classBPosition)).not.toBeNull();
  });

  it('rejects malformed/unknown payloads', () => {
    expect(parseAisRawMessage(null)).toBeNull();
    expect(parseAisRawMessage({})).toBeNull();
    expect(
      parseAisRawMessage({ MessageType: 'PositionReport', MetaData: {}, Message: {} }),
    ).toBeNull();
    expect(
      parseAisRawMessage({
        MessageType: 'SomeOtherType',
        MetaData: { MMSI: 1 },
        Message: { SomeOtherType: {} },
      }),
    ).toBeNull();
  });
});

describe('applyAisMessage (class A merge)', () => {
  it('merges static then dynamic messages into one track', () => {
    let track: AisTrack | undefined;
    track = applyAisMessage(track, classAStatic, 1000);
    expect(track.lengthM).toBe(110);
    expect(track.beamM).toBe(11);
    expect(track.draughtM).toBe(3.2);
    expect(track.shipTypeCode).toBe(79);
    expect(track.position).toBeUndefined();

    track = applyAisMessage(track, classAPosition, 2000);
    expect(track.position).toEqual({ lat: 52.174, lon: 5.001 });
    expect(track.courseDeg).toBe(89); // TrueHeading preferred over Cog
    expect(track.speedMs).toBeCloseTo(6.0 * 0.514444, 4);
    expect(track.updatedAt).toBe(2000);
    // Static fields survive the dynamic update.
    expect(track.lengthM).toBe(110);
  });

  it('merges dynamic then static (order independence)', () => {
    let track: AisTrack | undefined;
    track = applyAisMessage(track, classAPosition, 500);
    track = applyAisMessage(track, classAStatic, 1500);
    expect(track.position).toEqual({ lat: 52.174, lon: 5.001 });
    expect(track.lengthM).toBe(110);
  });
});

describe('applyAisMessage (class B merge)', () => {
  it('merges StaticDataReport (nested ReportA/ReportB) and StandardClassBPositionReport', () => {
    let track: AisTrack | undefined;
    track = applyAisMessage(track, classBStatic, 1000);
    expect(track.name).toBe('SLOEPJE');
    expect(track.lengthM).toBe(6);
    expect(track.beamM).toBe(2);
    expect(track.draughtM).toBeUndefined(); // class B rarely reports draught

    track = applyAisMessage(track, classBPosition, 2000);
    expect(track.position).toEqual({ lat: 52.171, lon: 4.999 });
    // TrueHeading 511 = not available -> falls back to Cog.
    expect(track.courseDeg).toBe(270);
    expect(track.speedMs).toBeCloseTo(2.0 * 0.514444, 4);
  });
});

describe('trackToBoat', () => {
  it('returns null without a position', () => {
    expect(trackToBoat({ mmsi: 1, updatedAt: 0 })).toBeNull();
  });

  it('fills in a generic hull when dimensions are missing', () => {
    const boat = trackToBoat({ mmsi: 1, updatedAt: 0, position: { lat: 52.17, lon: 5.0 } });
    expect(boat).not.toBeNull();
    expect(boat!.lengthM).toBeGreaterThan(0);
    expect(boat!.beamM).toBeGreaterThan(0);
    expect(boat!.massKg).toBeGreaterThan(0);
    expect(boat!.source).toBe('ais');
    expect(boat!.id).toBe('ais:1');
  });

  it('produces sane hydrostatics for a fully-known class A cargo track', () => {
    const track: AisTrack = {
      mmsi: 244660000,
      position: { lat: 52.174, lon: 5.001 },
      lengthM: 110,
      beamM: 11,
      draughtM: 3.2,
      shipTypeCode: 79,
      courseDeg: 89,
      speedMs: 3.1,
      updatedAt: 2000,
    };
    const boat = trackToBoat(track);
    expect(boat).not.toBeNull();
    expect(boat!.draughtM).toBe(3.2);
    expect(boat!.displacementM3).toBeCloseTo(110 * 11 * 3.2 * 0.875, 0);
  });
});

describe('pruneStaleTracks', () => {
  it('drops tracks older than maxAgeMs and keeps the rest', () => {
    const tracks = new Map<number, AisTrack>([
      [1, { mmsi: 1, updatedAt: 0 }],
      [2, { mmsi: 2, updatedAt: 9000 }],
    ]);
    const pruned = pruneStaleTracks(tracks, 10000, 5000);
    expect(pruned.has(1)).toBe(false);
    expect(pruned.has(2)).toBe(true);
  });
});
