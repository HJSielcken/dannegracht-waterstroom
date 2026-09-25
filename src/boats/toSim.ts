// Convert live `Boat[]` (WGS84, AIS/virtual) into `SimBoat[]` (metric frame,
// velocity vector) for the flow solver.
//
// The projection from LatLon to the metric Vec2 frame is owned by another
// module (src/geo) that is being built concurrently; to avoid a dependency
// on it, the projection function is passed in by the caller.
import type { Boat, LatLon, SimBoat, Vec2 } from '../types';

export type Project = (p: LatLon) => Vec2;

/**
 * Velocity from speed (m/s) and course (degrees, clockwise from north), in
 * the metric frame where x = east, y = north:
 *   x = speed * sin(course), y = speed * cos(course)
 */
export function velocityFromSpeedCourse(speedMs: number, courseDeg: number): Vec2 {
  const rad = (courseDeg * Math.PI) / 180;
  return { x: speedMs * Math.sin(rad), y: speedMs * Math.cos(rad) };
}

export function boatToSimBoat(boat: Boat, project: Project): SimBoat {
  return {
    id: boat.id,
    position: project(boat.position),
    velocity: velocityFromSpeedCourse(boat.speedMs, boat.courseDeg),
    lengthM: boat.lengthM,
    beamM: boat.beamM,
    draughtM: boat.draughtM,
  };
}

export function boatsToSimBoats(boats: Boat[], project: Project): SimBoat[] {
  return boats.map((boat) => boatToSimBoat(boat, project));
}
