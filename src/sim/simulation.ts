// High-level simulation facade: grid + shallow-water solver + boats.

import type {
  BoundaryLevels,
  FlowField,
  FlowSample,
  MetricScene,
  SimBoat,
  SimConfig,
  Vec2,
} from '../types';
import { buildGrid, type Grid } from './grid';
import { H_DRY, ShallowWaterSolver, type SolverParams } from './solver';

/**
 * Recommended defaults: 3 m cells keep the ~8-15 m wide Dannegracht 3-5 cells wide; n = 0.03
 * is typical for a small earth/sheet-piled canal with some vegetation.
 */
export const DEFAULT_SIM_CONFIG: SimConfig = { cellSizeM: 3, manningN: 0.03, timeScale: 1 };

/** Depth above which a point is reported as wet. */
const WET_DEPTH = 0.02;
/** Real seconds per advance() call beyond which time is dropped (e.g. background tab). */
const MAX_REAL_DT = 0.5;

export class Simulation {
  private scene: MetricScene;
  private config: SimConfig;
  private levels: BoundaryLevels;
  private boats: SimBoat[] = [];
  private readonly solverParams: Partial<SolverParams>;
  grid: Grid;
  solver: ShallowWaterSolver;

  constructor(
    scene: MetricScene,
    config: SimConfig,
    levels: BoundaryLevels,
    solverParams: Partial<SolverParams> = {},
  ) {
    this.scene = scene;
    this.config = { ...config };
    this.levels = { ...levels };
    this.solverParams = solverParams;
    this.grid = buildGrid(scene, { cellSizeM: config.cellSizeM });
    this.solver = this.makeSolver();
  }

  private makeSolver(): ShallowWaterSolver {
    const s = new ShallowWaterSolver(this.grid, this.levels, {
      ...this.solverParams,
      manningN: this.config.manningN,
    });
    s.boats.setBoats(this.boats, s.timeS);
    return s;
  }

  get timeS(): number {
    return this.solver.timeS;
  }

  getConfig(): SimConfig {
    return { ...this.config };
  }

  setLevels(levels: BoundaryLevels): void {
    this.levels = { ...levels };
    this.solver.setLevels(levels);
  }

  /** Update configuration. A new cell size rebuilds the grid and restarts the flow field. */
  setConfig(config: Partial<SimConfig>): void {
    const next = { ...this.config, ...config };
    const rebuild = next.cellSizeM !== this.config.cellSizeM;
    this.config = next;
    if (rebuild) {
      this.grid = buildGrid(this.scene, { cellSizeM: next.cellSizeM });
      this.solver = this.makeSolver();
    } else {
      this.solver.params.manningN = next.manningN;
    }
  }

  /** Replace the scene (e.g. a lock opened/closed) and restart. */
  setScene(scene: MetricScene): void {
    this.scene = scene;
    this.grid = buildGrid(scene, { cellSizeM: this.config.cellSizeM });
    this.solver = this.makeSolver();
  }

  setBoats(boats: SimBoat[]): void {
    this.boats = boats.map((b) => ({
      ...b,
      position: { ...b.position },
      velocity: { ...b.velocity },
    }));
    this.solver.boats.setBoats(this.boats, this.solver.timeS);
  }

  /**
   * Advance by `realDtSeconds` of wall time, i.e. realDt * timeScale simulated seconds.
   * `maxWallMs` bounds the compute time; if exceeded the rest of the interval is dropped.
   * Returns the simulated seconds advanced.
   */
  advance(realDtSeconds: number, maxWallMs = Infinity): number {
    const real = Math.min(Math.max(0, realDtSeconds), MAX_REAL_DT);
    const simS = real * Math.max(0, this.config.timeScale);
    if (simS <= 0) return 0;
    return this.solver.advance(simS, maxWallMs);
  }

  /** Advance by a given amount of simulated time (no wall-clock cap). */
  advanceSim(simSeconds: number): void {
    this.solver.advance(simSeconds);
  }

  /** Sample the flow at arbitrary points (bilinear interpolation over wet cells). */
  sample(points: Vec2[]): FlowSample[] {
    return points.map((p) => this.sampleOne(p));
  }

  private sampleOne(p: Vec2): FlowSample {
    const g = this.grid;
    const { nx, ny, dx, zb } = g;
    const eta = this.solver.eta;
    const dry: FlowSample = {
      u: 0,
      v: 0,
      speedMs: 0,
      directionDeg: 0,
      levelNapM: NaN,
      depthM: 0,
      wet: false,
    };
    const fx = (p.x - g.originX) / dx;
    const fy = (p.y - g.originY) / dx;
    const ci = Math.floor(fx);
    const cj = Math.floor(fy);
    if (!(ci >= 0 && cj >= 0 && ci < nx && cj < ny)) return dry;
    const cc = cj * nx + ci;
    if (!g.water[cc] || eta[cc]! - zb[cc]! < WET_DEPTH) return dry;

    const x = fx - 0.5;
    const y = fy - 0.5;
    const i0 = Math.floor(x);
    const j0 = Math.floor(y);
    const tx = x - i0;
    const ty = y - j0;
    let wsum = 0;
    let su = 0;
    let sv = 0;
    let se = 0;
    let sh = 0;
    for (let dj = 0; dj < 2; dj++) {
      for (let di = 0; di < 2; di++) {
        const i = i0 + di;
        const j = j0 + dj;
        if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
        const c = j * nx + i;
        if (!g.water[c]) continue;
        const h = eta[c]! - zb[c]!;
        if (h < WET_DEPTH) continue;
        const w = (di ? tx : 1 - tx) * (dj ? ty : 1 - ty);
        if (w <= 0) continue;
        const vel = this.solver.cellVelocity(c);
        wsum += w;
        su += w * vel.u;
        sv += w * vel.v;
        se += w * eta[c]!;
        sh += w * h;
      }
    }
    if (wsum <= 0) {
      const vel = this.solver.cellVelocity(cc);
      su = vel.u;
      sv = vel.v;
      se = eta[cc]!;
      sh = eta[cc]! - zb[cc]!;
      wsum = 1;
    }
    const u = su / wsum;
    const v = sv / wsum;
    return {
      u,
      v,
      speedMs: Math.hypot(u, v),
      directionDeg: directionDeg(u, v),
      levelNapM: se / wsum,
      depthM: sh / wsum,
      wet: true,
    };
  }

  /**
   * Snapshot of the cell-centred field (fresh arrays, safe to transfer). Land cells have
   * u = v = 0, wet = 0 and eta = the bed level for dry water cells or NaN for land.
   */
  field(): FlowField {
    const g = this.grid;
    const { nx, ny, zb } = g;
    const n = nx * ny;
    const u = new Float32Array(n);
    const v = new Float32Array(n);
    const eta = new Float32Array(n).fill(NaN);
    const wet = new Uint8Array(n);
    const s = this.solver;
    for (const c of s.cells) {
      const e = s.eta[c]!;
      eta[c] = e;
      if (e - zb[c]! > H_DRY) {
        const vel = s.cellVelocity(c);
        u[c] = vel.u;
        v[c] = vel.v;
        wet[c] = 1;
      }
    }
    return {
      nx,
      ny,
      cellSizeM: g.dx,
      originX: g.originX,
      originY: g.originY,
      u,
      v,
      eta,
      wet,
      timeS: s.timeS,
    };
  }
}

/** Direction the flow goes TO, degrees clockwise from north, in [0, 360). */
export function directionDeg(u: number, v: number): number {
  if (u === 0 && v === 0) return 0;
  const d = (Math.atan2(u, v) * 180) / Math.PI;
  return d < 0 ? d + 360 : d;
}
