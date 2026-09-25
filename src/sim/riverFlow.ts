// Background current of a river (Vecht, ARK) as potential flow along its own water cells.
//
// The river's cells get a potential psi that is fixed at both ends (south = upstream,
// north = downstream) and satisfies Laplace's equation elsewhere, with no flow through the
// banks or into the Dannegracht. Its gradient follows the river's bends without needing a
// centerline. psi is scaled so the typical |grad psi| is 1, i.e. psi is (roughly) the distance
// along the river in metres, decreasing downstream; the current is then v * -grad(psi).

import type { Grid } from './grid';

/** Rows at each end of the river (southmost / northmost) that hold psi fixed. */
const END_ROWS = 2;
const MAX_ITER = 5000;
const TOLERANCE = 1e-10;

export interface RiverPotential {
  /** Potential per grid cell (m, decreasing downstream); NaN outside the river. */
  psi: Float64Array;
  /** Cells of the two end zones, where the river enters and leaves the model. */
  ends: number[];
}

/**
 * Potential of the river with kind code `kindCode`. Cells not connected to either end get 0
 * (no current).
 */
export function riverPotential(grid: Grid, kindCode: number): RiverPotential {
  const { nx, ny, dx, water, kind, faceU, faceV } = grid;
  const n = nx * ny;
  const psi = new Float64Array(n).fill(NaN);
  const inRiver = (c: number) => water[c] === 1 && kind[c] === kindCode;

  let jMin = Infinity;
  let jMax = -Infinity;
  for (let c = 0; c < n; c++) {
    if (!inRiver(c)) continue;
    const j = (c / nx) | 0;
    if (j < jMin) jMin = j;
    if (j > jMax) jMax = j;
  }
  const ends: number[] = [];
  if (!Number.isFinite(jMin) || jMax - jMin < 2 * END_ROWS + 1) return { psi, ends };

  // Open neighbours (same river, open face) of cell c.
  const neighbours = (c: number): number[] => {
    const i = c % nx;
    const j = (c / nx) | 0;
    const out: number[] = [];
    if (i > 0 && faceU[j * (nx + 1) + i]! > 0 && inRiver(c - 1)) out.push(c - 1);
    if (i < nx - 1 && faceU[j * (nx + 1) + i + 1]! > 0 && inRiver(c + 1)) out.push(c + 1);
    if (j > 0 && faceV[c]! > 0 && inRiver(c - nx)) out.push(c - nx);
    if (j < ny - 1 && faceV[c + nx]! > 0 && inRiver(c + nx)) out.push(c + nx);
    return out;
  };

  // Unknowns: river cells away from both ends. Ends: +1 south (upstream), -1 north.
  const index = new Int32Array(n).fill(-1);
  const unknowns: number[] = [];
  for (let c = 0; c < n; c++) {
    if (!inRiver(c)) continue;
    const j = (c / nx) | 0;
    if (j < jMin + END_ROWS || j > jMax - END_ROWS) {
      psi[c] = j < jMin + END_ROWS ? 1 : -1;
      ends.push(c);
    } else {
      index[c] = unknowns.length;
      unknowns.push(c);
    }
  }
  const m = unknowns.length;
  const nbr = unknowns.map(neighbours);
  const diag = new Float64Array(m);
  const b = new Float64Array(m);
  for (let r = 0; r < m; r++) {
    for (const q of nbr[r]!) {
      diag[r]! += 1;
      if (index[q]! < 0) b[r]! += psi[q]!;
    }
  }
  const apply = (x: Float64Array, out: Float64Array) => {
    for (let r = 0; r < m; r++) {
      let s = diag[r]! * x[r]!;
      for (const q of nbr[r]!) {
        const qi = index[q]!;
        if (qi >= 0) s -= x[qi]!;
      }
      out[r] = s;
    }
  };

  // Jacobi-preconditioned conjugate gradients. Cells without neighbours (diag 0) stay 0.
  const x = new Float64Array(m);
  const res = Float64Array.from(b);
  const z = new Float64Array(m);
  const p = new Float64Array(m);
  const ap = new Float64Array(m);
  const precond = () => {
    for (let r = 0; r < m; r++) z[r] = diag[r]! > 0 ? res[r]! / diag[r]! : 0;
  };
  precond();
  p.set(z);
  let rz = dot(res, z);
  const bNorm = Math.sqrt(dot(b, b)) || 1;
  for (let it = 0; it < MAX_ITER && Math.sqrt(dot(res, res)) > TOLERANCE * bNorm; it++) {
    apply(p, ap);
    const pap = dot(p, ap);
    if (!(pap > 0)) break;
    const alpha = rz / pap;
    for (let r = 0; r < m; r++) {
      x[r]! += alpha * p[r]!;
      res[r]! -= alpha * ap[r]!;
    }
    precond();
    const rzNew = dot(res, z);
    const beta = rzNew / rz;
    rz = rzNew;
    for (let r = 0; r < m; r++) p[r] = z[r]! + beta * p[r]!;
  }
  for (let r = 0; r < m; r++) psi[unknowns[r]!] = x[r]!;

  // Scale so the median |grad psi| over the river (in 1/m) becomes 1.
  const grads: number[] = [];
  for (const c of unknowns) {
    const nb = neighbours(c);
    if (nb.length < 4) continue;
    const gx = (psi[c + 1]! - psi[c - 1]!) / (2 * dx);
    const gy = (psi[c + nx]! - psi[c - nx]!) / (2 * dx);
    grads.push(Math.hypot(gx, gy));
  }
  grads.sort((a, b2) => a - b2);
  const median = grads.length ? grads[grads.length >> 1]! : 0;
  if (median > 0) for (let c = 0; c < n; c++) if (!Number.isNaN(psi[c]!)) psi[c]! /= median;
  return { psi, ends };
}

function dot(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}
