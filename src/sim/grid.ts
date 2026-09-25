// Rasterisation of a MetricScene onto a regular Cartesian grid.
//
// Every cell gets:
//   - a water mask (1 = cell may carry water, 0 = land or blocked by a structure),
//   - the kind of water body it belongs to,
//   - a bed level in m NAP (reference water level minus the body's assumed depth),
// and every cell face gets a conveyance factor (1 = fully open, 0 = closed) used by the
// solver to model bridges/culverts (openFraction) and walls.
//
// Cell membership uses area coverage (4 x 4 sub-samples per cell with an even-odd scanline
// fill, so polygon holes are handled) instead of a single centre test. Narrow canals are
// kept 4-connected: wherever two water cells only touch diagonally, the better-covered of the
// two orthogonal "bridge" cells is added. This matters for the Dannegracht (~8-15 m wide).
//
// Recommended cell size: at most one third of the narrowest channel you care about, i.e.
// 2.5-4 m for the Dannegracht (3 m is the default used by the app). The solver is a C-grid
// scheme, so a channel needs at least 2 cells across to carry any flow and ~3-4 cells to
// resolve a return current next to a boat.

import type { MetricScene, MetricStructure, Vec2, WaterBodyKind } from '../types';

/** Reference water level (m NAP) used to turn body depths into bed levels. */
export const REFERENCE_LEVEL_NAP = -0.4;

/** Kind codes stored in Grid.kind (index into this array); LAND = -1. */
export const KIND_CODES: readonly WaterBodyKind[] = ['vecht', 'ark', 'dannegracht', 'other'];
export const KIND_VECHT = 0;
export const KIND_ARK = 1;
export const KIND_DANNEGRACHT = 2;
export const KIND_OTHER = 3;
export const LAND = -1;

/** Bed level used for land cells (only informative; land is never wetted). */
const LAND_BED = 10;
/** Sub-samples per cell per axis for coverage estimation. */
const SUB = 4;

export interface GridOptions {
  cellSizeM: number;
  /** Reference water level for depth -> bed conversion (default REFERENCE_LEVEL_NAP). */
  referenceLevelNapM?: number;
  /** Extra padding around the water bodies' bounding box (default max(3 cells, 10 m)). */
  padM?: number;
}

export interface Grid {
  nx: number;
  ny: number;
  /** Cell size in metres. */
  dx: number;
  /** Metric coordinate of the south-west corner of cell (0,0). */
  originX: number;
  originY: number;
  referenceLevelNapM: number;
  /** 1 = water cell (can still dry out), 0 = land or blocked. Row-major, row 0 = south. */
  water: Uint8Array;
  /** Water body kind code per cell (see KIND_CODES), LAND (-1) for land/blocked. */
  kind: Int8Array;
  /** Index into scene.waterBodies, -1 for land. */
  body: Int32Array;
  /** Bed level in m NAP. */
  zb: Float64Array;
  /** 1 where a blocking structure removed water cells. */
  blocked: Uint8Array;
  /** Conveyance factor on x-faces, size (nx+1)*ny; face (i,j) lies west of cell (i,j). */
  faceU: Float32Array;
  /** Conveyance factor on y-faces, size nx*(ny+1); face (i,j) lies south of cell (i,j). */
  faceV: Float32Array;
  /** Number of water cells. */
  waterCount: number;
}

/**
 * Priority bonus when several bodies cover the same cell. Where the Dannegracht runs into a
 * river the river is physically there, so the rivers win: otherwise the overlap would become
 * a shallow Dannegracht strip inside the much deeper ARK or Vecht.
 */
const KIND_BONUS: Record<WaterBodyKind, number> = {
  ark: 0.3,
  vecht: 0.2,
  dannegracht: 0.1,
  other: 0,
};

/** Minimum coverage to count a cell as water, per kind (narrow canals get a lower threshold). */
const KIND_THRESHOLD: Record<WaterBodyKind, number> = {
  dannegracht: 0.3,
  other: 0.35,
  vecht: 0.45,
  ark: 0.45,
};

export function buildGrid(scene: MetricScene, opts: GridOptions): Grid {
  const dx = opts.cellSizeM;
  if (!(dx > 0)) throw new Error(`Invalid cell size ${dx}`);
  const ref = opts.referenceLevelNapM ?? REFERENCE_LEVEL_NAP;

  // Bounding box of all water.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of scene.waterBodies) {
    for (const ring of b.rings) {
      for (const p of ring) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
    }
  }
  if (!Number.isFinite(minX)) {
    minX = -50;
    minY = -50;
    maxX = 50;
    maxY = 50;
  }
  const pad = opts.padM ?? Math.max(3 * dx, 10);
  const originX = Math.floor((minX - pad) / dx) * dx;
  const originY = Math.floor((minY - pad) / dx) * dx;
  const nx = Math.max(3, Math.ceil((maxX + pad - originX) / dx));
  const ny = Math.max(3, Math.ceil((maxY + pad - originY) / dx));
  const n = nx * ny;
  if (n > 4_000_000) throw new Error(`Grid too large (${nx} x ${ny}); increase cellSizeM`);

  const water = new Uint8Array(n);
  const kind = new Int8Array(n).fill(LAND);
  const body = new Int32Array(n).fill(-1);
  const zb = new Float64Array(n).fill(LAND_BED);
  const blocked = new Uint8Array(n);
  const totalCov = new Float32Array(n);
  const bestScore = new Float32Array(n);
  const cov = new Float32Array(n);

  scene.waterBodies.forEach((wb, bi) => {
    const box = rasteriseCoverage(wb.rings, cov, nx, ny, dx, originX, originY);
    if (!box) return;
    const bonus = KIND_BONUS[wb.kind] ?? 0;
    const kcode = Math.max(0, KIND_CODES.indexOf(wb.kind));
    const depth = Number.isFinite(wb.depthM) && wb.depthM > 0 ? wb.depthM : 2;
    for (let j = box.j0; j <= box.j1; j++) {
      for (let i = box.i0; i <= box.i1; i++) {
        const c = j * nx + i;
        const cv = cov[c]!;
        if (cv <= 0) continue;
        cov[c] = 0;
        totalCov[c] = Math.min(1, totalCov[c]! + cv);
        const score = cv + bonus;
        if (score > bestScore[c]!) {
          bestScore[c] = score;
          body[c] = bi;
          kind[c] = kcode;
          zb[c] = ref - depth;
        }
      }
    }
  });

  for (let c = 0; c < n; c++) {
    const b = body[c]!;
    if (b < 0) continue;
    const k = KIND_CODES[kind[c]!]!;
    if (totalCov[c]! >= KIND_THRESHOLD[k]) water[c] = 1;
  }

  enforceFourConnectivity(water, totalCov, nx, ny);
  // Cells that were added by the connectivity pass or lost below threshold: fix attributes.
  for (let c = 0; c < n; c++) {
    if (!water[c]) {
      kind[c] = LAND;
      body[c] = -1;
      zb[c] = LAND_BED;
    }
  }
  // Keep the outermost ring of cells dry so the domain edge is always a closed wall.
  for (let i = 0; i < nx; i++) {
    clearCell(i, 0);
    clearCell(i, ny - 1);
  }
  for (let j = 0; j < ny; j++) {
    clearCell(0, j);
    clearCell(nx - 1, j);
  }
  function clearCell(i: number, j: number): void {
    const c = j * nx + i;
    water[c] = 0;
    kind[c] = LAND;
    body[c] = -1;
    zb[c] = LAND_BED;
  }

  const grid: Grid = {
    nx,
    ny,
    dx,
    originX,
    originY,
    referenceLevelNapM: ref,
    water,
    kind,
    body,
    zb,
    blocked,
    faceU: new Float32Array((nx + 1) * ny),
    faceV: new Float32Array(nx * (ny + 1)),
    waterCount: 0,
  };

  // Structures first remove cells (blocking) and then scale face conveyance.
  const partial: { s: MetricStructure; cells: Set<number> }[] = [];
  for (const s of scene.structures) {
    const cells = structureCells(grid, s.position);
    if (!cells) continue;
    if (s.blocksFlow) {
      for (const c of cells) {
        water[c] = 0;
        blocked[c] = 1;
        kind[c] = LAND;
        body[c] = -1;
        zb[c] = LAND_BED;
      }
    } else if (s.openFraction !== undefined && s.openFraction < 1) {
      partial.push({ s, cells: new Set(cells) });
    }
  }

  computeFaces(grid);

  for (const { s, cells } of partial) {
    const f = Math.min(1, Math.max(0.02, s.openFraction ?? 1));
    for (const c of cells) {
      const i = c % nx;
      const j = (c - i) / nx;
      // East face of c (west face of c+1) and north face of c.
      if (i + 1 < nx && cells.has(c + 1)) {
        const k = j * (nx + 1) + i + 1;
        grid.faceU[k] = Math.min(grid.faceU[k]!, f);
      }
      if (j + 1 < ny && cells.has(c + nx)) {
        const k = c + nx;
        grid.faceV[k] = Math.min(grid.faceV[k]!, f);
      }
    }
  }

  let count = 0;
  for (let c = 0; c < n; c++) count += water[c]!;
  grid.waterCount = count;
  return grid;
}

function computeFaces(g: Grid): void {
  const { nx, ny, water, faceU, faceV } = g;
  for (let j = 0; j < ny; j++) {
    for (let i = 1; i < nx; i++) {
      const c = j * nx + i;
      faceU[j * (nx + 1) + i] = water[c - 1]! && water[c]! ? 1 : 0;
    }
  }
  for (let j = 1; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      faceV[c] = water[c - nx]! && water[c]! ? 1 : 0;
    }
  }
}

/**
 * Accumulate the area coverage of a polygon (outer ring + holes, even-odd rule) into `cov`.
 * Returns the touched cell range, or null when the polygon misses the grid.
 */
function rasteriseCoverage(
  rings: Vec2[][],
  cov: Float32Array,
  nx: number,
  ny: number,
  dx: number,
  originX: number,
  originY: number,
): { i0: number; i1: number; j0: number; j1: number } | null {
  const h = dx / SUB;
  const nsy = ny * SUB;
  const nsx = nx * SUB;
  const rows = new Map<number, number[]>();
  let syMin = Infinity;
  let syMax = -Infinity;
  for (const ring of rings) {
    const m = ring.length;
    if (m < 3) continue;
    for (let e = 0; e < m; e++) {
      const a = ring[e]!;
      const b = ring[(e + 1) % m]!;
      if (a.y === b.y) continue;
      const ylo = Math.min(a.y, b.y);
      const yhi = Math.max(a.y, b.y);
      // Sub-row centres y_s = originY + (s + 0.5) h with ylo <= y_s < yhi.
      const s0 = Math.max(0, Math.ceil((ylo - originY) / h - 0.5));
      const s1 = Math.min(nsy - 1, Math.ceil((yhi - originY) / h - 0.5) - 1);
      const inv = (b.x - a.x) / (b.y - a.y);
      for (let s = s0; s <= s1; s++) {
        const y = originY + (s + 0.5) * h;
        const x = a.x + (y - a.y) * inv;
        let list = rows.get(s);
        if (!list) {
          list = [];
          rows.set(s, list);
        }
        list.push(x);
      }
      if (s0 <= s1) {
        if (s0 < syMin) syMin = s0;
        if (s1 > syMax) syMax = s1;
      }
    }
  }
  if (!Number.isFinite(syMin)) return null;
  const w = 1 / (SUB * SUB);
  let i0 = Infinity;
  let i1 = -Infinity;
  for (const [s, xs] of rows) {
    xs.sort((p, q) => p - q);
    const j = Math.floor(s / SUB);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = xs[k]!;
      const xb = xs[k + 1]!;
      const t0 = Math.max(0, Math.ceil((xa - originX) / h - 0.5));
      const t1 = Math.min(nsx - 1, Math.ceil((xb - originX) / h - 0.5) - 1);
      for (let t = t0; t <= t1; t++) {
        const i = Math.floor(t / SUB);
        cov[j * nx + i] = cov[j * nx + i]! + w;
        if (i < i0) i0 = i;
        if (i > i1) i1 = i;
      }
    }
  }
  if (!Number.isFinite(i0)) return null;
  return { i0, i1, j0: Math.floor(syMin / SUB), j1: Math.floor(syMax / SUB) };
}

/** Add orthogonal bridge cells wherever water cells only connect diagonally. */
function enforceFourConnectivity(
  water: Uint8Array,
  cov: Float32Array,
  nx: number,
  ny: number,
): void {
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j + 1 < ny; j++) {
      for (let i = 0; i + 1 < nx; i++) {
        const a = j * nx + i; // SW
        const b = a + 1; // SE
        const c = a + nx; // NW
        const d = c + 1; // NE
        // SW-NE diagonal
        if (water[a] && water[d] && !water[b] && !water[c]) {
          const pick = cov[b]! >= cov[c]! ? b : c;
          if (cov[pick]! > 0) water[pick] = 1;
        }
        // SE-NW diagonal
        if (water[b] && water[c] && !water[a] && !water[d]) {
          const pick = cov[a]! >= cov[d]! ? a : d;
          if (cov[pick]! > 0) water[pick] = 1;
        }
      }
    }
  }
}

/**
 * Cells affected by a structure: the water cells (of the same body kind as the nearest water
 * cell) within a disc whose radius spans the local channel width, so that a closed lock
 * really cuts the channel cross-section. Returns null when no water is near.
 */
export function structureCells(g: Grid, pos: Vec2): number[] | null {
  const { nx, ny, dx, water, kind } = g;
  const ci = Math.floor((pos.x - g.originX) / dx);
  const cj = Math.floor((pos.y - g.originY) / dx);
  // Nearest water cell within 25 m.
  const searchR = Math.ceil(25 / dx);
  let best = -1;
  let bestD = Infinity;
  for (let j = cj - searchR; j <= cj + searchR; j++) {
    if (j < 0 || j >= ny) continue;
    for (let i = ci - searchR; i <= ci + searchR; i++) {
      if (i < 0 || i >= nx) continue;
      const c = j * nx + i;
      if (!water[c]) continue;
      const d = (i - ci) ** 2 + (j - cj) ** 2;
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
  }
  if (best < 0) return null;
  const k0 = kind[best]!;
  const bi = best % nx;
  const bj = (best - bi) / nx;

  // Local half width: largest distance-to-land among nearby same-kind water cells.
  const near = Math.max(1, Math.ceil(12 / dx));
  const landR = Math.ceil(40 / dx);
  let halfW = 0;
  for (let j = bj - near; j <= bj + near; j++) {
    for (let i = bi - near; i <= bi + near; i++) {
      if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
      const c = j * nx + i;
      if (!water[c] || kind[c] !== k0) continue;
      halfW = Math.max(halfW, distanceToLand(g, i, j, landR));
    }
  }
  const radius = Math.min(40, Math.max(1.5 * dx, 2 * halfW + dx));
  const r = Math.ceil(radius / dx);
  const px = g.originX + (bi + 0.5) * dx;
  const py = g.originY + (bj + 0.5) * dx;
  const out: number[] = [];
  for (let j = bj - r; j <= bj + r; j++) {
    for (let i = bi - r; i <= bi + r; i++) {
      if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
      const c = j * nx + i;
      if (!water[c] || kind[c] !== k0) continue;
      const x = g.originX + (i + 0.5) * dx;
      const y = g.originY + (j + 0.5) * dx;
      if ((x - px) ** 2 + (y - py) ** 2 <= radius * radius) out.push(c);
    }
  }
  return out;
}

function distanceToLand(g: Grid, i0: number, j0: number, maxR: number): number {
  const { nx, ny, dx, water } = g;
  let best = maxR * maxR;
  for (let j = j0 - maxR; j <= j0 + maxR; j++) {
    for (let i = i0 - maxR; i <= i0 + maxR; i++) {
      const outside = i < 0 || j < 0 || i >= nx || j >= ny;
      if (!outside && water[j * nx + i]) continue;
      const d = (i - i0) ** 2 + (j - j0) ** 2;
      if (d < best) best = d;
    }
  }
  // Distance from the cell centre to the edge of the nearest land cell.
  return Math.max(0, Math.sqrt(best) - 0.5) * dx;
}

/** Fractional cell coordinates of a metric point (cell centres at integer + 0.5). */
export function cellOf(g: Grid, p: Vec2): { i: number; j: number } {
  return {
    i: Math.floor((p.x - g.originX) / g.dx),
    j: Math.floor((p.y - g.originY) / g.dx),
  };
}
