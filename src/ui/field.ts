import type { FlowField, Vec2 } from '../types';

/** Bilinear velocity lookup in a FlowField (cell-centred values). Returns null on land. */
export function velocityAt(field: FlowField, p: Vec2): Vec2 | null {
  const fx = (p.x - field.originX) / field.cellSizeM - 0.5;
  const fy = (p.y - field.originY) / field.cellSizeM - 0.5;
  const i0 = Math.floor(fx);
  const j0 = Math.floor(fy);
  const tx = fx - i0;
  const ty = fy - j0;
  let u = 0;
  let v = 0;
  let w = 0;
  for (let dj = 0; dj <= 1; dj++) {
    for (let di = 0; di <= 1; di++) {
      const i = i0 + di;
      const j = j0 + dj;
      if (i < 0 || j < 0 || i >= field.nx || j >= field.ny) continue;
      const k = j * field.nx + i;
      if (!field.wet[k]) continue;
      const wk = (di ? tx : 1 - tx) * (dj ? ty : 1 - ty);
      u += (field.u[k] ?? 0) * wk;
      v += (field.v[k] ?? 0) * wk;
      w += wk;
    }
  }
  if (w < 1e-6) return null;
  return { x: u / w, y: v / w };
}

/** Metric centre of cell (i, j). */
export function cellCentre(field: FlowField, i: number, j: number): Vec2 {
  return {
    x: field.originX + (i + 0.5) * field.cellSizeM,
    y: field.originY + (j + 0.5) * field.cellSizeM,
  };
}

/** Direction the water flows TO, degrees clockwise from north. */
export function directionDeg(u: number, v: number): number {
  return ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360;
}

const COMPASS = ['N', 'NO', 'O', 'ZO', 'Z', 'ZW', 'W', 'NW'];

/** Dutch 8-point compass label for a bearing. */
export function compassLabel(deg: number): string {
  return COMPASS[Math.round(deg / 45) % 8] ?? 'N';
}

/** Colour ramp for speed (m/s): calm blue -> teal -> yellow -> red. */
export function speedColour(speed: number, maxSpeed: number): string {
  const t = Math.max(0, Math.min(1, speed / maxSpeed));
  const hue = 210 - 210 * t;
  return `hsl(${hue.toFixed(0)} 85% ${(45 + 10 * t).toFixed(0)}%)`;
}

export function formatDuration(s: number): string {
  const m = Math.floor(s / 60);
  return m > 0 ? `${m} min ${Math.floor(s % 60)} s` : `${s.toFixed(0)} s`;
}
