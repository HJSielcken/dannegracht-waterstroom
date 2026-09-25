// Boats as moving pressure disturbances ("pressure patch" ship model).
//
// Each boat is represented by a smooth surface pressure field p/(rho g) = P(x - x_boat(t)),
// expressed as a pressure head in metres, that enters the momentum equations exactly like the
// free-surface gradient:  du/dt = -g d(eta + P)/dx ...  In (quasi-)equilibrium the water surface
// under the hull is pushed down by ~P, i.e. the hull displaces water and the water column under
// the keel is reduced (blockage). Because the patch moves, water has to flow from the bow region
// to the stern region past and under the hull, which produces the well-known effects:
//   - return current along the hull, opposite to the sailing direction,
//   - drawdown (water level depression) next to the hull, stronger in narrow/shallow channels
//     and growing with speed (~1/(1 - Fr^2) in the linear 1D limit),
//   - a bow rise ahead of the boat and a stern (transversal) wave where the depression refills,
//     both growing with size and speed.
//
// Shape: along the hull a plateau with cos^2 tapers at bow and stern, likewise across the beam.
// The tapers are at least 2 cells wide so the forcing stays smooth on the grid. The peak head
// is chosen so that the integral of P over the footprint equals the displaced volume
// L * B * T * Cb, capped by the draught and by half the local still-water depth (so the keel
// never "touches" the bed numerically).
//
// Limits: shallow-water (non-dispersive) physics, so the short divergent Kelvin waves of a real
// ship are not resolved; the model reproduces the long-wave primary field (drawdown, return
// current, bow/stern waves) that dominates in narrow canals. Propeller jets, squat and
// supercritical (Fr > 1) behaviour are not modelled. Positions reported by AIS are smoothed:
// boats are dead-reckoned between updates and nudged towards reported positions, and every boat
// ramps its forcing in/out over RAMP_S seconds to avoid artificial shocks.

import type { SimBoat, Vec2 } from '../types';
import type { Grid } from './grid';

/** Block coefficient used to estimate displaced volume. */
export const BLOCK_COEFFICIENT = 0.8;
/** Seconds over which a new / removed boat's forcing ramps in / out. */
export const RAMP_S = 15;
/** Relaxation time (s) towards a newly reported position. */
const CORRECTION_S = 8;
/** Beyond this mismatch (m) a boat is re-spawned at the reported position. */
const TELEPORT_M = 150;

interface BoatState {
  id: string;
  pos: Vec2;
  vel: Vec2;
  heading: Vec2;
  lengthM: number;
  beamM: number;
  draughtM: number;
  amp: number;
  removing: boolean;
  /** Reported state and the sim time it refers to. */
  target: { pos: Vec2; vel: Vec2; t: number };
}

export class BoatForcing {
  private boats = new Map<string, BoatState>();
  private touched: number[] = [];

  /** Replace the set of boats (sim time `t`). Unknown ids spawn, missing ids ramp out. */
  setBoats(list: SimBoat[], t: number): void {
    const seen = new Set<string>();
    for (const b of list) {
      if (!isFiniteVec(b.position) || !isFiniteVec(b.velocity)) continue;
      seen.add(b.id);
      const target = { pos: { ...b.position }, vel: { ...b.velocity }, t };
      const existing = this.boats.get(b.id);
      const sp = Math.hypot(b.velocity.x, b.velocity.y);
      if (existing) {
        existing.target = target;
        existing.lengthM = sane(b.lengthM, 10);
        existing.beamM = sane(b.beamM, 3);
        existing.draughtM = sane(b.draughtM, 1);
        existing.removing = false;
        const mis = Math.hypot(existing.pos.x - b.position.x, existing.pos.y - b.position.y);
        if (mis > TELEPORT_M) {
          existing.pos = { ...b.position };
          existing.amp = 0;
        }
      } else {
        this.boats.set(b.id, {
          id: b.id,
          pos: { ...b.position },
          vel: { ...b.velocity },
          heading: sp > 0.05 ? { x: b.velocity.x / sp, y: b.velocity.y / sp } : { x: 1, y: 0 },
          lengthM: sane(b.lengthM, 10),
          beamM: sane(b.beamM, 3),
          draughtM: sane(b.draughtM, 1),
          amp: 0,
          removing: false,
          target,
        });
      }
    }
    for (const s of this.boats.values()) if (!seen.has(s.id)) s.removing = true;
  }

  get count(): number {
    return this.boats.size;
  }

  /** Current (smoothed) boat positions, for diagnostics/tests. */
  positions(): { id: string; pos: Vec2; amp: number }[] {
    return [...this.boats.values()].map((b) => ({ id: b.id, pos: { ...b.pos }, amp: b.amp }));
  }

  /**
   * Advance boat kinematics to time t + dt and write the pressure head field into `p`
   * (cleared where previously written). Returns the maximum boat speed (m/s).
   */
  update(t: number, dt: number, grid: Grid, refLevel: number, p: Float64Array): number {
    for (const c of this.touched) p[c] = 0;
    this.touched.length = 0;
    let vmax = 0;
    const tn = t + dt;
    for (const b of this.boats.values()) {
      // Kinematics: dead reckoning plus relaxation towards the extrapolated reported position.
      const tg = b.target;
      const ex = tg.pos.x + tg.vel.x * (tn - tg.t);
      const ey = tg.pos.y + tg.vel.y * (tn - tg.t);
      b.vel = { ...tg.vel };
      b.pos.x += b.vel.x * dt;
      b.pos.y += b.vel.y * dt;
      const w = Math.min(1, dt / CORRECTION_S);
      b.pos.x += (ex - b.pos.x) * w;
      b.pos.y += (ey - b.pos.y) * w;
      const sp = Math.hypot(b.vel.x, b.vel.y);
      if (sp > 0.05) b.heading = { x: b.vel.x / sp, y: b.vel.y / sp };
      vmax = Math.max(vmax, sp);
      b.amp = b.removing ? b.amp - dt / RAMP_S : Math.min(1, b.amp + dt / RAMP_S);
      if (b.amp <= 0 && b.removing) {
        this.boats.delete(b.id);
        continue;
      }
      if (b.amp > 0) this.stamp(b, grid, refLevel, p);
    }
    return vmax;
  }

  private stamp(b: BoatState, g: Grid, refLevel: number, p: Float64Array): void {
    const { nx, ny, dx, water, zb } = g;
    const L = b.lengthM;
    const B = b.beamM;
    const T = b.draughtM;
    const taperL = Math.max(0.25 * L, 2 * dx);
    const taperB = Math.max(0.4 * B, 2 * dx);
    const coreL = Math.max(0, (L - taperL) / 2);
    const coreB = Math.max(0, (B - taperB) / 2);
    // Integral of the 1D profile = 2*core + taper.
    const Ix = 2 * coreL + taperL;
    const Iy = 2 * coreB + taperB;
    const vol = L * B * T * BLOCK_COEFFICIENT;
    const P0 = b.amp * Math.min(T, vol / (Ix * Iy));
    const extL = coreL + taperL;
    const extB = coreB + taperB;
    const R = Math.hypot(extL, extB);
    const i0 = Math.max(0, Math.floor((b.pos.x - R - g.originX) / dx));
    const i1 = Math.min(nx - 1, Math.floor((b.pos.x + R - g.originX) / dx));
    const j0 = Math.max(0, Math.floor((b.pos.y - R - g.originY) / dx));
    const j1 = Math.min(ny - 1, Math.floor((b.pos.y + R - g.originY) / dx));
    const hx = b.heading.x;
    const hy = b.heading.y;
    for (let j = j0; j <= j1; j++) {
      const ry = g.originY + (j + 0.5) * dx - b.pos.y;
      for (let i = i0; i <= i1; i++) {
        const c = j * nx + i;
        if (!water[c]) continue;
        const rx = g.originX + (i + 0.5) * dx - b.pos.x;
        const along = Math.abs(rx * hx + ry * hy);
        const across = Math.abs(-rx * hy + ry * hx);
        const f = profile(along, coreL, taperL) * profile(across, coreB, taperB);
        if (f <= 0) continue;
        const cap = 0.5 * Math.max(0, refLevel - zb[c]!);
        const prev = p[c]!;
        if (prev === 0) this.touched.push(c);
        p[c] = Math.min(cap, prev + P0 * f);
      }
    }
  }
}

function profile(s: number, core: number, taper: number): number {
  if (s <= core) return 1;
  const d = s - core;
  if (d >= taper) return 0;
  const c = Math.cos((Math.PI * d) / (2 * taper));
  return c * c;
}

function sane(v: number, dflt: number): number {
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

function isFiniteVec(v: Vec2): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y);
}
