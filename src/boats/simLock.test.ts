import { describe, expect, it } from 'vitest';
import type { Boat } from '../types';
import { SimWaterLock } from './simLock';

/** Simulated water: everything south of 52.18 N. */
const inWater = (p: { lat: number }) => p.lat < 52.18;

function aisBoat(lat: number, extra: Partial<Boat> = {}): Boat {
  return {
    id: 'ais:1',
    source: 'ais',
    position: { lat, lon: 5.0 },
    courseDeg: 180,
    speedMs: 2,
    lengthM: 86,
    beamM: 9.5,
    draughtM: 2.6,
    displacementM3: 1900,
    massKg: 1_900_000,
    updatedAt: 0,
    ...extra,
  };
}

describe('SimWaterLock', () => {
  it('shows boats outside the simulated water but does not send them to the sim', () => {
    const lock = new SimWaterLock();
    const { shown, sim } = lock.apply([aisBoat(52.19)], inWater);
    expect(shown).toHaveLength(1);
    expect(sim).toHaveLength(0);
  });

  it('ignores AIS positions once a boat is in the simulated water', () => {
    const lock = new SimWaterLock();
    lock.apply([aisBoat(52.175)], inWater);
    const { shown, sim } = lock.apply([aisBoat(52.1752, { courseDeg: 90, speedMs: 5 })], inWater);
    expect(sim).toHaveLength(1);
    expect(shown[0]!.position.lat).toBe(52.175);
    expect(sim[0]!.courseDeg).toBe(180);
    expect(sim[0]!.speedMs).toBe(2);
  });

  it('moves locked boats with the simulation clock', () => {
    const lock = new SimWaterLock();
    lock.apply([aisBoat(52.175)], inWater);
    lock.advance(10);
    const { sim } = lock.apply([aisBoat(52.175)], inWater);
    expect((52.175 - sim[0]!.position.lat) * 111_320).toBeCloseTo(20, 1);
  });

  it('keeps following AIS dimensions while locked', () => {
    const lock = new SimWaterLock();
    lock.apply([aisBoat(52.175)], inWater);
    const { sim } = lock.apply([aisBoat(52.175, { lengthM: 40, beamM: 6 })], inWater);
    expect(sim[0]!.lengthM).toBe(40);
  });

  it('releases a boat that leaves the simulated water and does not re-lock it at once', () => {
    const lock = new SimWaterLock();
    lock.apply([aisBoat(52.179, { courseDeg: 0 })], inWater);
    lock.advance(100); // 200 m north: out of the water
    let r = lock.apply([aisBoat(52.1795)], inWater);
    expect(r.sim).toHaveLength(0);
    expect(r.shown[0]!.position.lat).toBe(52.1795);
    expect(lock.isLocked('ais:1')).toBe(false);
    // Its AIS position leaves the water, then comes back: it may be locked again.
    lock.apply([aisBoat(52.185)], inWater);
    r = lock.apply([aisBoat(52.178)], inWater);
    expect(r.sim).toHaveLength(1);
  });

  it('forgets boats that disappear from AIS', () => {
    const lock = new SimWaterLock();
    lock.apply([aisBoat(52.175)], inWater);
    lock.apply([], inWater);
    expect(lock.isLocked('ais:1')).toBe(false);
  });
});
