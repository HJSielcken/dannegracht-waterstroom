import { describe, expect, it } from 'vitest';
import { VIRTUAL_BOAT_PRESETS, VirtualBoat } from './virtual';

const straightPath = [
  { lat: 52.17, lon: 5.0 },
  { lat: 52.171, lon: 5.0 }, // due north, ~111 m
];

describe('VIRTUAL_BOAT_PRESETS', () => {
  it('has the four required presets with plausible dimensions', () => {
    expect(VIRTUAL_BOAT_PRESETS.sloep.lengthM).toBeCloseTo(6, 0);
    expect(VIRTUAL_BOAT_PRESETS.motorjacht.lengthM).toBeCloseTo(12, 0);
    expect(VIRTUAL_BOAT_PRESETS.rondvaartboot.lengthM).toBeCloseTo(20, 0);
    expect(VIRTUAL_BOAT_PRESETS.binnenvaartschip.lengthM).toBeCloseTo(110, 0);
    expect(VIRTUAL_BOAT_PRESETS.binnenvaartschip.beamM).toBeCloseTo(11.4, 1);
  });
});

describe('VirtualBoat', () => {
  it('advances along the path in the course direction (north => course ~0)', () => {
    const boat = new VirtualBoat({ id: 'v1', preset: 'sloep', path: straightPath, speedMs: 10 });
    const before = boat.toBoat(0).position;
    boat.advance(1);
    const after = boat.toBoat(1000).position;
    expect(after.lat).toBeGreaterThan(before.lat);
    expect(boat.toBoat(1000).courseDeg).toBeCloseTo(0, 0);
  });

  it('ping-pongs at the end of the path by default', () => {
    const boat = new VirtualBoat({ id: 'v2', preset: 'sloep', path: straightPath, speedMs: 200 });
    boat.advance(1); // overshoots the ~111m segment, should bounce back
    const b1 = boat.toBoat(0);
    expect(b1.speedMs).toBeGreaterThan(0);
    // After bouncing, another full second should move it back toward the start.
    const before = boat.toBoat(0).position;
    boat.advance(0.1);
    const after = boat.toBoat(0).position;
    expect(after.lat).toBeLessThan(before.lat);
  });

  it('stops at the end of the path in stop mode', () => {
    const boat = new VirtualBoat({
      id: 'v3',
      preset: 'sloep',
      path: straightPath,
      speedMs: 1000,
      mode: 'stop',
    });
    boat.advance(10);
    const stopped = boat.toBoat(0);
    expect(stopped.speedMs).toBe(0);
    expect(stopped.position.lat).toBeCloseTo(straightPath[1]!.lat, 5);
    const before = boat.toBoat(0).position;
    boat.advance(10); // further advances should be no-ops
    const after = boat.toBoat(0).position;
    expect(after).toEqual(before);
  });

  it('rejects a degenerate path with fewer than 2 points', () => {
    expect(
      () => new VirtualBoat({ id: 'bad', preset: 'sloep', path: [{ lat: 0, lon: 0 }] }),
    ).toThrow();
  });

  it('produces hydrostatics consistent with the preset', () => {
    const boat = new VirtualBoat({ id: 'v4', preset: 'binnenvaartschip', path: straightPath });
    const state = boat.toBoat(0);
    expect(state.lengthM).toBeCloseTo(110, 0);
    expect(state.massKg).toBeGreaterThan(1_000_000); // a Va-class barge is thousands of tonnes
  });
});
