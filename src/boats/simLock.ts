// Hands AIS boats over to the simulation once they sail into simulated water.
//
// AIS positions are noisy and arrive seconds to minutes apart, so a boat that keeps following
// them jumps back and forth, and in the sim each jump of the pressure patch radiates a spurious
// wave. So as soon as an AIS boat is on a simulated water cell, its position, course and speed
// are frozen ("locked") and from then on it is moved by the simulation clock only, like a virtual
// boat, ignoring further AIS positions. Its dimensions and name still follow AIS, since the
// static data often arrives later. When the locked boat leaves the simulated water it is
// released: it goes back to its AIS position on the map and is no longer sent to the sim, until
// its AIS position has left the simulated water too. Boats outside the simulated water are not
// sent to the sim at all, so a boat's forcing ramps in when it enters rather than while it is
// still over land.
import type { Boat, LatLon } from '../types';
import { moveAlong } from './aisMessages';

export type InSimWater = (p: LatLon) => boolean;

interface Locked {
  position: LatLon;
  courseDeg: number;
  speedMs: number;
}

export class SimWaterLock {
  private locked = new Map<string, Locked>();
  private released = new Set<string>();

  /** Move every locked boat on by `dtS` seconds of simulated time. */
  advance(dtS: number): void {
    if (dtS <= 0) return;
    for (const l of this.locked.values()) {
      if (l.speedMs > 0) l.position = moveAlong(l.position, l.courseDeg, l.speedMs * dtS);
    }
  }

  /**
   * Split AIS boats (already dead-reckoned to now) into what to draw and what the sim gets.
   * `shown` has every boat, locked ones at their simulated position; `sim` only the locked ones.
   */
  apply(boats: Boat[], inSimWater: InSimWater): { shown: Boat[]; sim: Boat[] } {
    const shown: Boat[] = [];
    const sim: Boat[] = [];
    const present = new Set<string>();
    for (const b of boats) {
      present.add(b.id);
      let l = this.locked.get(b.id);
      if (l && !inSimWater(l.position)) {
        this.locked.delete(b.id);
        this.released.add(b.id);
        l = undefined;
      }
      if (!l && this.released.has(b.id)) {
        if (inSimWater(b.position)) {
          shown.push(b);
          continue;
        }
        this.released.delete(b.id);
      }
      if (!l && inSimWater(b.position)) {
        l = { position: b.position, courseDeg: b.courseDeg, speedMs: b.speedMs };
        this.locked.set(b.id, l);
      }
      if (!l) {
        shown.push(b);
        continue;
      }
      const boat: Boat = { ...b, position: l.position, courseDeg: l.courseDeg, speedMs: l.speedMs };
      shown.push(boat);
      sim.push(boat);
    }
    for (const id of this.locked.keys()) if (!present.has(id)) this.locked.delete(id);
    for (const id of this.released) if (!present.has(id)) this.released.delete(id);
    return { shown, sim };
  }

  /** Whether the boat with this id is currently moved by the simulation. */
  isLocked(id: string): boolean {
    return this.locked.has(id);
  }
}
