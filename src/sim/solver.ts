// 2D depth-averaged shallow-water solver on a staggered (Arakawa C) grid.
//
// Unknowns: water level eta (m NAP) at cell centres, velocity u on x-faces and v on y-faces.
// Per time step (explicit forward-backward, in the spirit of Stelling & Duinmeijer 2003):
//   1. momentum: du/dt = -g d(eta + P)/dx - (u.grad)u + nu lap(u) - g n^2 |u| u / h^(4/3)
//      * P = pressure head of the boats (see boatForcing.ts);
//      * advection: first-order upwind (non-conservative), skipped for very shallow faces;
//      * horizontal eddy viscosity with a constant nu, free-slip at walls. Kept small: in a
//        ~10 m wide, ~2 m deep gracht turbulent mixing gives ~0.01 m^2/s, and on the grid's
//        staircase banks a larger nu acts as extra wall friction (0.3 m^2/s used to cost a
//        quarter of the flow; Manning bed friction far less);
//      * Manning friction treated semi-implicitly (unconditionally stable);
//   2. continuity in flux form with upwind face depth: eta += -dt/dx * (sum of face fluxes).
//      A positivity limiter scales the outgoing fluxes of a cell that would otherwise empty,
//      so depths never become negative (wetting/drying) and mass is conserved to round-off.
//   3. boundary treatment: the Vecht and the ARK are large reservoirs. Their cells beyond a
//      distance SPONGE_START_M from the Dannegracht (or other interior water) are nudged
//      towards the prescribed level with a rate ramping up to 1/SPONGE_TIMESCALE_S at
//      SPONGE_FULL_M. The volume added/removed by nudging is accounted in `spongeVolumeM3`.
//      River currents: each river gets a potential-flow direction field along its own cells
//      (riverFlow.ts). It starts at the requested speed, the sponge also nudges the face
//      velocities towards it, and the level target falls downstream with the Manning slope
//      S = n^2 v^2 / h^(4/3), with the prescribed level at the Dannegracht mouth. The
//      river's end rows are open boundaries held at that level, where the discharge enters
//      and leaves the model.
//
// Time step: CFL-adaptive, dt = cfl * dx / (sqrt(g h_max) + |u|_max), also bounded by the
// viscous limit, boat speed and MAX_DT. The C-grid forward-backward scheme is stable for
// c dt/dx < 1/sqrt(2); cfl = 0.45 keeps a margin for advection.
//
// Only water cells/faces are visited: active cell and face index lists are precomputed, so
// land (most of the real 1.5 x 1.5 km domain) costs nothing.

import type { BoundaryLevels, RiverCurrents } from '../types';
import { BoatForcing } from './boatForcing';
import { KIND_ARK, KIND_DANNEGRACHT, KIND_OTHER, KIND_VECHT, type Grid } from './grid';
import { riverPotential } from './riverFlow';

export const G = 9.81;
/** Depth below which a cell/face counts as dry. */
export const H_DRY = 0.005;
/** Depth below which momentum advection is switched off. */
const H_ADV = 0.1;
const MAX_DT = 1.0;
const MAX_SPEED = 8;

export interface SolverParams {
  manningN: number;
  /** Horizontal eddy viscosity (m^2/s). */
  eddyViscosity: number;
  cfl: number;
  advection: boolean;
  /** Distance (m) from interior water where reservoir nudging starts. */
  spongeStartM: number;
  /** Distance (m) where nudging reaches full strength. */
  spongeFullM: number;
  /** Nudging timescale (s) at full strength. */
  spongeTimescaleS: number;
}

export const DEFAULT_SOLVER_PARAMS: SolverParams = {
  manningN: 0.03,
  eddyViscosity: 0.05,
  cfl: 0.45,
  advection: true,
  spongeStartM: 40,
  spongeFullM: 150,
  spongeTimescaleS: 60,
};

export class ShallowWaterSolver {
  readonly grid: Grid;
  params: SolverParams;
  levels: BoundaryLevels;
  currents: RiverCurrents = { vechtMs: 0, arkMs: 0 };
  readonly boats = new BoatForcing();

  /** Water level at cell centres (m NAP). */
  readonly eta: Float64Array;
  /** x-velocity on x-faces, size (nx+1)*ny. */
  u: Float64Array;
  /** y-velocity on y-faces, size nx*(ny+1). */
  v: Float64Array;
  /** Boat pressure head (m) at cell centres. */
  readonly p: Float64Array;

  timeS = 0;
  /** Net volume (m^3) added by reservoir nudging since the start. */
  spongeVolumeM3 = 0;
  steps = 0;
  /** Number of times non-finite values were detected and repaired. */
  repairs = 0;

  private uNew: Float64Array;
  private vNew: Float64Array;
  private qx: Float64Array;
  private qy: Float64Array;
  private outflow: Float64Array;

  /** Water cells. */
  readonly cells: Int32Array;
  /** Active x-faces and the index of the cell west of each. */
  private readonly fu: Int32Array;
  private readonly fuWest: Int32Array;
  private readonly maskU: Uint8Array;
  /** Active y-faces (south cell = k - nx, north cell = k) and the u-face west of each. */
  private readonly fv: Int32Array;
  private readonly fvUS: Int32Array;
  private readonly fvUN: Int32Array;
  private readonly maskV: Uint8Array;
  /** Sponge cells, their nudging rate (1/s) and whether they belong to the ARK. */
  private spongeCells: Int32Array = new Int32Array(0);
  private spongeRate: Float64Array = new Float64Array(0);
  private spongeIsArk: Uint8Array = new Uint8Array(0);
  /**
   * Per cell of the Vecht/ARK: distance along the river below the Dannegracht mouth (m,
   * negative upstream) divided by h^(4/3). Times n^2 v|v| this gives how far the level there
   * lies below the level at the mouth for a current v.
   */
  private riverSlopeFactor: Float64Array = new Float64Array(0);
  /**
   * River end zones: open boundaries held exactly at the target level, so the river's
   * discharge can enter and leave the model there.
   */
  private openCells: Int32Array = new Int32Array(0);
  private openIsArk: Uint8Array = new Uint8Array(0);
  /** Level at the open ends, lagging the prescribed levels by the sponge timescale. */
  private openLevels: BoundaryLevels;
  /** Unit river current per face (x- and y-faces; 0 outside the rivers) and its river. */
  private riverUnitU: Float64Array = new Float64Array(0);
  private riverUnitV: Float64Array = new Float64Array(0);
  private riverIsArkU: Uint8Array = new Uint8Array(0);
  private riverIsArkV: Uint8Array = new Uint8Array(0);
  /** Sponge faces (x then y) with their nudging rate (1/s). */
  private spongeFacesU: Int32Array = new Int32Array(0);
  private spongeRateU: Float64Array = new Float64Array(0);
  private spongeFacesV: Int32Array = new Int32Array(0);
  private spongeRateV: Float64Array = new Float64Array(0);

  private lastUmax = 0;
  private lastHmax = 0;
  private boatVmax = 0;

  constructor(
    grid: Grid,
    levels: BoundaryLevels,
    params: Partial<SolverParams> = {},
    currents: RiverCurrents = { vechtMs: 0, arkMs: 0 },
  ) {
    this.grid = grid;
    this.params = { ...DEFAULT_SOLVER_PARAMS, ...params };
    this.levels = { ...levels };
    this.openLevels = { ...levels };
    this.currents = { ...currents };
    const { nx, ny, water, faceU, faceV } = grid;
    const n = nx * ny;
    const nu = (nx + 1) * ny;
    const nv = nx * (ny + 1);
    this.eta = new Float64Array(n);
    this.u = new Float64Array(nu);
    this.v = new Float64Array(nv);
    this.uNew = new Float64Array(nu);
    this.vNew = new Float64Array(nv);
    this.qx = new Float64Array(nu);
    this.qy = new Float64Array(nv);
    this.p = new Float64Array(n);
    this.outflow = new Float64Array(n);

    const cells: number[] = [];
    for (let c = 0; c < n; c++) if (water[c]) cells.push(c);
    this.cells = Int32Array.from(cells);

    const fu: number[] = [];
    const fuWest: number[] = [];
    this.maskU = new Uint8Array(nu);
    for (let j = 0; j < ny; j++) {
      for (let i = 1; i < nx; i++) {
        const k = j * (nx + 1) + i;
        if (faceU[k]! > 0) {
          fu.push(k);
          fuWest.push(j * nx + i - 1);
          this.maskU[k] = 1;
        }
      }
    }
    this.fu = Int32Array.from(fu);
    this.fuWest = Int32Array.from(fuWest);

    const fv: number[] = [];
    const fvUS: number[] = [];
    const fvUN: number[] = [];
    this.maskV = new Uint8Array(nv);
    for (let j = 1; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        if (faceV[k]! > 0) {
          fv.push(k);
          fvUS.push((j - 1) * (nx + 1) + i);
          fvUN.push(j * (nx + 1) + i);
          this.maskV[k] = 1;
        }
      }
    }
    this.fv = Int32Array.from(fv);
    this.fvUS = Int32Array.from(fvUS);
    this.fvUN = Int32Array.from(fvUN);

    this.setupSponge();
    this.initialiseLevels();
    // The first time step needs the real depth too (otherwise it is taken for 0.1 m).
    for (const c of this.cells) this.lastHmax = Math.max(this.lastHmax, this.eta[c]! - grid.zb[c]!);
  }

  /** Change prescribed reservoir levels (takes effect through the sponge). */
  setLevels(levels: BoundaryLevels): void {
    this.levels = { ...levels };
  }

  /** Change the river currents (takes effect through the sponge). */
  setCurrents(currents: RiverCurrents): void {
    this.currents = { ...currents };
  }

  /** Nudging target (m NAP) of river cell c: the prescribed level minus the current's slope. */
  private riverTarget(c: number, isArk: boolean, levels = this.levels): number {
    const { vechtNapM, arkNapM } = levels;
    const v = isArk ? this.currents.arkMs : this.currents.vechtMs;
    const n = this.params.manningN;
    return (isArk ? arkNapM : vechtNapM) - this.riverSlopeFactor[c]! * n * n * v * Math.abs(v);
  }

  /** Mean of the two boundary levels; used as still-water reference for boats. */
  get meanLevel(): number {
    return 0.5 * (this.levels.vechtNapM + this.levels.arkNapM);
  }

  /** Current water volume (m^3). */
  volume(): number {
    const { zb, dx } = this.grid;
    let v = 0;
    for (const c of this.cells) v += this.eta[c]! - zb[c]!;
    return v * dx * dx;
  }

  /** Current stable time step (s). */
  stableDt(): number {
    const { dx } = this.grid;
    const c = Math.sqrt(G * Math.max(this.lastHmax, 0.1));
    let dt = (this.params.cfl * dx) / (c + this.lastUmax);
    if (this.params.eddyViscosity > 0)
      dt = Math.min(dt, (0.2 * dx * dx) / this.params.eddyViscosity);
    if (this.boatVmax > 0) dt = Math.min(dt, (0.5 * dx) / this.boatVmax);
    return Math.min(dt, MAX_DT);
  }

  /**
   * Advance the model by `simSeconds`. Stops early when `maxWallMs` of wall-clock time is used
   * (the remaining time is dropped). Returns the simulated seconds actually advanced.
   */
  advance(simSeconds: number, maxWallMs = Infinity): number {
    const t0 = maxWallMs < Infinity ? now() : 0;
    // Equal steps: full steps followed by a short remainder give a periodic dt sequence, for
    // which the forward-backward scheme is unstable (2-cell waves grow parametrically) even
    // though every single step is within the CFL limit. Splitting what is left into equal
    // parts on every step keeps dt constant, yet follows the limit when the flow speeds up.
    let done = 0;
    let guard = 0;
    while (done < simSeconds - 1e-9) {
      const rest = simSeconds - done;
      const dt = rest / Math.max(1, Math.ceil(rest / this.stableDt() - 1e-9));
      this.boatVmax = this.boats.update(this.timeS, dt, this.grid, this.meanLevel, this.p);
      this.step(dt);
      done += dt;
      if (maxWallMs < Infinity && (++guard & 7) === 0 && now() - t0 > maxWallMs) break;
    }
    return done;
  }

  /** One explicit time step of length dt. */
  step(dt: number): void {
    const { nx, dx, zb, faceU, faceV } = this.grid;
    const { eta, u, v, p, uNew, vNew, qx, qy, outflow, maskU, maskV } = this;
    const { manningN, eddyViscosity: nu, advection } = this.params;
    const n2g = G * manningN * manningN;
    const invDx = 1 / dx;
    const visc = nu * invDx * invDx;
    const nxu = nx + 1;
    let umax = 0;

    // --- 1a. x-momentum -------------------------------------------------------------------
    const fu = this.fu;
    const fuWest = this.fuWest;
    for (let n = 0; n < fu.length; n++) {
      const k = fu[n]!;
      const cL = fuWest[n]!;
      const cR = cL + 1;
      const eL = eta[cL]!;
      const eR = eta[cR]!;
      const zf = Math.max(zb[cL]!, zb[cR]!);
      const uk = u[k]!;
      const hMax = Math.max(eL, eR) - zf;
      if (hMax <= H_DRY) {
        uNew[k] = 0;
        continue;
      }
      let hUp = (uk > 0 ? eL : uk < 0 ? eR : Math.max(eL, eR)) - zf;
      if (hUp < H_DRY) hUp = H_DRY;
      const grad = G * (eR + p[cR]! - eL - p[cL]!) * invDx;
      const uE = maskU[k + 1] ? u[k + 1]! : uk;
      const uW = maskU[k - 1] ? u[k - 1]! : uk;
      const uN = maskU[k + nxu] ? u[k + nxu]! : uk;
      const uS = maskU[k - nxu] ? u[k - nxu]! : uk;
      let acc = -grad + visc * (uE + uW + uN + uS - 4 * uk);
      if (advection && hUp > H_ADV) {
        const va = 0.25 * (v[cL]! + v[cL + nx]! + v[cR]! + v[cR + nx]!);
        const dudx = uk > 0 ? uk - uW : uE - uk;
        const dudy = va > 0 ? uk - uS : uN - uk;
        acc -= (uk * dudx + va * dudy) * invDx;
      }
      const cf = (n2g * Math.abs(uk)) / h43(hUp);
      let un = (uk + dt * acc) / (1 + dt * cf);
      if (un > MAX_SPEED) un = MAX_SPEED;
      else if (un < -MAX_SPEED) un = -MAX_SPEED;
      uNew[k] = un;
    }

    // --- 1b. y-momentum -------------------------------------------------------------------
    const fv = this.fv;
    const fvUS = this.fvUS;
    const fvUN = this.fvUN;
    for (let n = 0; n < fv.length; n++) {
      const k = fv[n]!;
      const cS = k - nx;
      const cN = k;
      const eS = eta[cS]!;
      const eN = eta[cN]!;
      const zf = Math.max(zb[cS]!, zb[cN]!);
      const vk = v[k]!;
      const hMax = Math.max(eS, eN) - zf;
      if (hMax <= H_DRY) {
        vNew[k] = 0;
        continue;
      }
      let hUp = (vk > 0 ? eS : vk < 0 ? eN : Math.max(eS, eN)) - zf;
      if (hUp < H_DRY) hUp = H_DRY;
      const grad = G * (eN + p[cN]! - eS - p[cS]!) * invDx;
      const vE = maskV[k + 1] ? v[k + 1]! : vk;
      const vW = maskV[k - 1] ? v[k - 1]! : vk;
      const vN = maskV[k + nx] ? v[k + nx]! : vk;
      const vS = maskV[k - nx] ? v[k - nx]! : vk;
      let acc = -grad + visc * (vE + vW + vN + vS - 4 * vk);
      if (advection && hUp > H_ADV) {
        const us = fvUS[n]!;
        const un_ = fvUN[n]!;
        const ua = 0.25 * (u[us]! + u[us + 1]! + u[un_]! + u[un_ + 1]!);
        const dvdx = ua > 0 ? vk - vW : vE - vk;
        const dvdy = vk > 0 ? vk - vS : vN - vk;
        acc -= (ua * dvdx + vk * dvdy) * invDx;
      }
      const cf = (n2g * Math.abs(vk)) / h43(hUp);
      let vn = (vk + dt * acc) / (1 + dt * cf);
      if (vn > MAX_SPEED) vn = MAX_SPEED;
      else if (vn < -MAX_SPEED) vn = -MAX_SPEED;
      vNew[k] = vn;
    }

    // --- 1c. river current nudging in the sponge ---------------------------------------------
    const { vechtMs, arkMs } = this.currents;
    const sfu = this.spongeFacesU;
    for (let n = 0; n < sfu.length; n++) {
      const k = sfu[n]!;
      const target = (this.riverIsArkU[k] ? arkMs : vechtMs) * this.riverUnitU[k]!;
      const rdt = this.spongeRateU[n]! * dt;
      uNew[k] = (uNew[k]! + target * rdt) / (1 + rdt);
    }
    const sfv = this.spongeFacesV;
    for (let n = 0; n < sfv.length; n++) {
      const k = sfv[n]!;
      const target = (this.riverIsArkV[k] ? arkMs : vechtMs) * this.riverUnitV[k]!;
      const rdt = this.spongeRateV[n]! * dt;
      vNew[k] = (vNew[k]! + target * rdt) / (1 + rdt);
    }

    // --- 2. continuity with positivity limiter ---------------------------------------------
    const cells = this.cells;
    for (let n = 0; n < cells.length; n++) outflow[cells[n]!] = 0;
    for (let n = 0; n < fu.length; n++) {
      const k = fu[n]!;
      const cL = fuWest[n]!;
      const un = uNew[k]!;
      if (un === 0) {
        qx[k] = 0;
        continue;
      }
      const zf = Math.max(zb[cL]!, zb[cL + 1]!);
      const donor = un > 0 ? cL : cL + 1;
      const h = eta[donor]! - zf;
      const q = h > 0 ? un * h * faceU[k]! : 0;
      qx[k] = q;
      outflow[donor] = outflow[donor]! + Math.abs(q);
    }
    for (let n = 0; n < fv.length; n++) {
      const k = fv[n]!;
      const vn = vNew[k]!;
      if (vn === 0) {
        qy[k] = 0;
        continue;
      }
      const zf = Math.max(zb[k - nx]!, zb[k]!);
      const donor = vn > 0 ? k - nx : k;
      const h = eta[donor]! - zf;
      const q = h > 0 ? vn * h * faceV[k]! : 0;
      qy[k] = q;
      outflow[donor] = outflow[donor]! + Math.abs(q);
    }
    // outflow -> limiter factor (1 = no limiting)
    const dtInvDx = dt * invDx;
    for (let n = 0; n < cells.length; n++) {
      const c = cells[n]!;
      const out = outflow[c]! * dtInvDx;
      const avail = eta[c]! - zb[c]!;
      outflow[c] = out > avail ? Math.max(0, avail) / out : 1;
    }
    for (let n = 0; n < fu.length; n++) {
      const k = fu[n]!;
      let q = qx[k]!;
      if (q === 0) continue;
      const cL = fuWest[n]!;
      const f = outflow[q > 0 ? cL : cL + 1]!;
      if (f < 1) {
        q *= f;
        uNew[k] = uNew[k]! * f;
      }
      const a = Math.abs(uNew[k]!);
      if (a > umax) umax = a;
      const dEta = q * dtInvDx;
      eta[cL] = eta[cL]! - dEta;
      eta[cL + 1] = eta[cL + 1]! + dEta;
    }
    for (let n = 0; n < fv.length; n++) {
      const k = fv[n]!;
      let q = qy[k]!;
      if (q === 0) continue;
      const f = outflow[q > 0 ? k - nx : k]!;
      if (f < 1) {
        q *= f;
        vNew[k] = vNew[k]! * f;
      }
      const a = Math.abs(vNew[k]!);
      if (a > umax) umax = a;
      const dEta = q * dtInvDx;
      eta[k - nx] = eta[k - nx]! - dEta;
      eta[k] = eta[k]! + dEta;
    }

    // --- 3. reservoir nudging + depth bookkeeping -----------------------------------------
    const sc = this.spongeCells;
    const sr = this.spongeRate;
    const sa = this.spongeIsArk;
    let dVol = 0;
    for (let n = 0; n < sc.length; n++) {
      const c = sc[n]!;
      // Under a boat the surface lies lower by its pressure head; nudging it up to the river
      // level instead would keep feeding water under the hull, a source that never stops.
      const target = this.riverTarget(c, sa[n] === 1) - p[c]!;
      const e = eta[c]!;
      const rdt = sr[n]! * dt;
      // implicit (unconditionally stable) relaxation
      let ne = e + ((target - e) * rdt) / (1 + rdt);
      if (ne < zb[c]!) ne = zb[c]!;
      dVol += ne - e;
      eta[c] = ne;
    }
    // The open ends follow a level change as smoothly as the sponge does; a sudden jump
    // there would start a seiche in the gracht.
    const ol = this.openLevels;
    const rOpen = dt / (this.params.spongeTimescaleS + dt);
    ol.vechtNapM += (this.levels.vechtNapM - ol.vechtNapM) * rOpen;
    ol.arkNapM += (this.levels.arkNapM - ol.arkNapM) * rOpen;
    const oc = this.openCells;
    for (let n = 0; n < oc.length; n++) {
      const isArk = this.openIsArk[n] === 1;
      // Without a current there is no discharge to pass; the sponge alone absorbs better.
      if ((isArk ? this.currents.arkMs : this.currents.vechtMs) === 0) continue;
      const c = oc[n]!;
      const ne = Math.max(this.riverTarget(c, isArk, ol) - p[c]!, zb[c]!);
      dVol += ne - eta[c]!;
      eta[c] = ne;
    }
    this.spongeVolumeM3 += dVol * dx * dx;

    let hmax = 0;
    let bad = false;
    for (let n = 0; n < cells.length; n++) {
      const c = cells[n]!;
      const h = eta[c]! - zb[c]!;
      if (h > hmax) hmax = h;
      else if (!(h >= 0)) {
        if (h !== h) bad = true;
        // Round-off below the bed: clamp (negligible mass change).
        eta[c] = zb[c]!;
      }
    }

    // swap velocity buffers
    this.uNew = u;
    this.u = uNew;
    this.vNew = v;
    this.v = vNew;
    this.lastUmax = umax;
    this.lastHmax = hmax;
    this.timeS += dt;
    this.steps++;
    if (bad || !Number.isFinite(umax)) this.repair();
  }

  /** Emergency reset of non-finite state (should not happen; kept as a safety net). */
  private repair(): void {
    this.repairs++;
    const { zb } = this.grid;
    for (const c of this.cells) {
      if (!Number.isFinite(this.eta[c]!)) this.eta[c] = Math.max(zb[c]!, this.meanLevel);
    }
    this.u.fill(0);
    this.v.fill(0);
  }

  /** Cell-centred velocity (m/s). */
  cellVelocity(c: number): { u: number; v: number } {
    const nx = this.grid.nx;
    const j = (c / nx) | 0;
    const ku = c + j;
    return {
      u: 0.5 * (this.u[ku]! + this.u[ku + 1]!),
      v: 0.5 * (this.v[c]! + this.v[c + nx]!),
    };
  }

  /**
   * Distance (m) of every reservoir cell to interior (Dannegracht/other) water through the
   * water network (4-neighbour BFS), used to build the nudging zone.
   */
  private setupSponge(): void {
    const { kind, nx, zb, referenceLevelNapM } = this.grid;
    const { spongeStartM, spongeFullM, spongeTimescaleS } = this.params;
    const dist = this.bfs((c) => kind[c] === KIND_DANNEGRACHT || kind[c] === KIND_OTHER);
    const dx = this.grid.dx;

    // Potential along each river (m, decreasing downstream) and its value at the mouth,
    // i.e. the mean over the river's cells next to the gracht.
    const psi = new Float64Array(nx * this.grid.ny).fill(NaN);
    const openCells: number[] = [];
    const psiMouth = [0, 0];
    [KIND_VECHT, KIND_ARK].forEach((code, r) => {
      const { psi: p, ends } = riverPotential(this.grid, code);
      // Only where the sponge is at full strength, so waves are damped before they reach
      // the (reflecting) fixed-level ends.
      for (const c of ends) if (dist[c]! * dx >= spongeFullM) openCells.push(c);
      let sum = 0;
      let count = 0;
      for (const c of this.cells) {
        if (kind[c] !== code || Number.isNaN(p[c]!)) continue;
        psi[c] = p[c]!;
        if (dist[c] === 1) {
          sum += p[c]!;
          count++;
        }
      }
      psiMouth[r] = count ? sum / count : 0;
    });
    const slope = new Float64Array(nx * this.grid.ny);
    for (const c of this.cells) {
      if (Number.isNaN(psi[c]!)) continue;
      const h = Math.max(referenceLevelNapM - zb[c]!, 0.1);
      slope[c] = (psiMouth[kind[c] === KIND_ARK ? 1 : 0]! - psi[c]!) / h43(h);
    }
    this.riverSlopeFactor = slope;
    this.openCells = Int32Array.from(openCells);
    this.openIsArk = Uint8Array.from(openCells, (c) => (kind[c] === KIND_ARK ? 1 : 0));

    // Unit current on faces between two cells of the same river: -grad(psi).
    this.riverUnitU = new Float64Array(this.u.length);
    this.riverIsArkU = new Uint8Array(this.u.length);
    this.riverUnitV = new Float64Array(this.v.length);
    this.riverIsArkV = new Uint8Array(this.v.length);
    for (let n = 0; n < this.fu.length; n++) {
      const k = this.fu[n]!;
      const cL = this.fuWest[n]!;
      if (kind[cL] !== kind[cL + 1] || Number.isNaN(psi[cL]!) || Number.isNaN(psi[cL + 1]!))
        continue;
      this.riverUnitU[k] = -(psi[cL + 1]! - psi[cL]!) / dx;
      this.riverIsArkU[k] = kind[cL] === KIND_ARK ? 1 : 0;
    }
    for (const k of this.fv) {
      const cS = k - nx;
      if (kind[cS] !== kind[k] || Number.isNaN(psi[cS]!) || Number.isNaN(psi[k]!)) continue;
      this.riverUnitV[k] = -(psi[k]! - psi[cS]!) / dx;
      this.riverIsArkV[k] = kind[k] === KIND_ARK ? 1 : 0;
    }

    const sc: number[] = [];
    const sr: number[] = [];
    const sa: number[] = [];
    const rateMax = 1 / spongeTimescaleS;
    for (const c of this.cells) {
      const k = kind[c];
      if (k !== KIND_VECHT && k !== KIND_ARK) continue;
      const d = dist[c]! * dx;
      let s: number;
      if (!Number.isFinite(d) || d >= spongeFullM) s = 1;
      else if (d <= spongeStartM) s = 0;
      else {
        const x = (d - spongeStartM) / (spongeFullM - spongeStartM);
        s = x * x * (3 - 2 * x);
      }
      if (s <= 0) continue;
      sc.push(c);
      sr.push(rateMax * s);
      sa.push(k === KIND_ARK ? 1 : 0);
    }
    this.spongeCells = Int32Array.from(sc);
    this.spongeRate = Float64Array.from(sr);
    this.spongeIsArk = Uint8Array.from(sa);

    // Faces between two sponge cells of a river are nudged at the lower of the two rates.
    const cellRate = new Float64Array(nx * this.grid.ny);
    sc.forEach((c, n) => (cellRate[c] = sr[n]!));
    const fu: number[] = [];
    const ru: number[] = [];
    for (let n = 0; n < this.fu.length; n++) {
      const k = this.fu[n]!;
      const cL = this.fuWest[n]!;
      const rate = Math.min(cellRate[cL]!, cellRate[cL + 1]!);
      if (rate > 0 && this.riverUnitU[k] !== 0) {
        fu.push(k);
        ru.push(rate);
      }
    }
    const fv: number[] = [];
    const rv: number[] = [];
    for (const k of this.fv) {
      const rate = Math.min(cellRate[k - nx]!, cellRate[k]!);
      if (rate > 0 && this.riverUnitV[k] !== 0) {
        fv.push(k);
        rv.push(rate);
      }
    }
    this.spongeFacesU = Int32Array.from(fu);
    this.spongeRateU = Float64Array.from(ru);
    this.spongeFacesV = Int32Array.from(fv);
    this.spongeRateV = Float64Array.from(rv);
  }

  /** Initial state: reservoirs at their level, interior water interpolated by path distance. */
  private initialiseLevels(): void {
    const { kind, zb } = this.grid;
    const { vechtNapM, arkNapM } = this.levels;
    const dV = this.bfs((c) => kind[c] === KIND_VECHT);
    const dA = this.bfs((c) => kind[c] === KIND_ARK);
    for (const c of this.cells) {
      const k = kind[c];
      let e: number;
      if (k === KIND_VECHT) e = this.riverTarget(c, false);
      else if (k === KIND_ARK) e = this.riverTarget(c, true);
      else {
        const a = dV[c]!;
        const b = dA[c]!;
        if (Number.isFinite(a) && Number.isFinite(b)) e = (b * vechtNapM + a * arkNapM) / (a + b);
        else if (Number.isFinite(a)) e = vechtNapM;
        else if (Number.isFinite(b)) e = arkNapM;
        else e = 0.5 * (vechtNapM + arkNapM);
      }
      this.eta[c] = Math.max(e, zb[c]!);
    }
    // Rivers start with their current; everything else at rest.
    const { vechtMs, arkMs } = this.currents;
    for (let k = 0; k < this.u.length; k++)
      this.u[k] = (this.riverIsArkU[k] ? arkMs : vechtMs) * this.riverUnitU[k]!;
    for (let k = 0; k < this.v.length; k++)
      this.v[k] = (this.riverIsArkV[k] ? arkMs : vechtMs) * this.riverUnitV[k]!;
    this.timeS = 0;
    this.spongeVolumeM3 = 0;
  }

  /** 4-neighbour BFS distance in cells from all water cells matching `isSource`. */
  private bfs(isSource: (c: number) => boolean): Float64Array {
    const { nx, ny, water } = this.grid;
    const n = nx * ny;
    const dist = new Float64Array(n).fill(Infinity);
    const queue = new Int32Array(this.cells.length);
    let head = 0;
    let tail = 0;
    for (const c of this.cells) {
      if (isSource(c)) {
        dist[c] = 0;
        queue[tail++] = c;
      }
    }
    while (head < tail) {
      const c = queue[head++]!;
      const d = dist[c]! + 1;
      const i = c % nx;
      const nb = [i > 0 ? c - 1 : -1, i < nx - 1 ? c + 1 : -1, c - nx, c + nx];
      for (const m of nb) {
        if (m < 0 || m >= n || !water[m] || dist[m]! <= d) continue;
        dist[m] = d;
        queue[tail++] = m;
      }
    }
    return dist;
  }
}

// h^(4/3) via a lookup table with linear interpolation (Math.pow/Math.cbrt dominate the cost
// of the momentum loops otherwise). Relative error < 1e-5 for h >= H_DRY.
const H43_STEP = 0.002;
const H43_MAX = 40;
const H43_TABLE = (() => {
  const n = Math.ceil(H43_MAX / H43_STEP) + 2;
  const t = new Float64Array(n);
  for (let i = 0; i < n; i++) t[i] = Math.pow(i * H43_STEP, 4 / 3);
  return t;
})();

function h43(h: number): number {
  const x = h / H43_STEP;
  if (x >= H43_MAX / H43_STEP) return h * Math.cbrt(h);
  const i = x | 0;
  const f = x - i;
  const a = H43_TABLE[i]!;
  return a + (H43_TABLE[i + 1]! - a) * f;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
