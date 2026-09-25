import { describe, expect, it } from 'vitest';
import type { Boat, LatLon, Vec2 } from '../types';
import { boatToSimBoat, boatsToSimBoats, velocityFromSpeedCourse } from './toSim';

const identityProject = (p: LatLon): Vec2 => ({ x: p.lon, y: p.lat });

function makeBoat(overrides: Partial<Boat> = {}): Boat {
  return {
    id: 'b1',
    source: 'virtual',
    position: { lat: 52.17, lon: 5.0 },
    courseDeg: 0,
    speedMs: 3,
    lengthM: 10,
    beamM: 3,
    draughtM: 1,
    displacementM3: 20,
    massKg: 20000,
    updatedAt: 0,
    ...overrides,
  };
}

describe('velocityFromSpeedCourse', () => {
  it('course 0 (north) => (0, speed)', () => {
    const v = velocityFromSpeedCourse(5, 0);
    expect(v.x).toBeCloseTo(0);
    expect(v.y).toBeCloseTo(5);
  });
  it('course 90 (east) => (speed, 0)', () => {
    const v = velocityFromSpeedCourse(5, 90);
    expect(v.x).toBeCloseTo(5);
    expect(v.y).toBeCloseTo(0);
  });
  it('course 180 (south) => (0, -speed)', () => {
    const v = velocityFromSpeedCourse(5, 180);
    expect(v.x).toBeCloseTo(0, 5);
    expect(v.y).toBeCloseTo(-5);
  });
  it('course 270 (west) => (-speed, 0)', () => {
    const v = velocityFromSpeedCourse(5, 270);
    expect(v.x).toBeCloseTo(-5);
    expect(v.y).toBeCloseTo(0, 5);
  });
});

describe('boatToSimBoat / boatsToSimBoats', () => {
  it('projects position and carries dimensions through unchanged', () => {
    const boat = makeBoat({ courseDeg: 90, speedMs: 4 });
    const sim = boatToSimBoat(boat, identityProject);
    expect(sim.id).toBe('b1');
    expect(sim.position).toEqual({ x: 5.0, y: 52.17 });
    expect(sim.velocity.x).toBeCloseTo(4);
    expect(sim.velocity.y).toBeCloseTo(0, 5);
    expect(sim.lengthM).toBe(10);
    expect(sim.beamM).toBe(3);
    expect(sim.draughtM).toBe(1);
  });

  it('maps arrays in order', () => {
    const boats = [makeBoat({ id: 'a' }), makeBoat({ id: 'b' })];
    const sims = boatsToSimBoats(boats, identityProject);
    expect(sims.map((s) => s.id)).toEqual(['a', 'b']);
  });
});
