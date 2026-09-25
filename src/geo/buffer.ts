// Turns a centerline (polyline) into a ribbon polygon of a given width — used to build the
// schematic fallback water body polygons from researched centerlines.

import type { LatLon } from '../types';
import { toLatLon, toMetric } from './project';

interface Vec2Local {
  x: number;
  y: number;
}

function sub(a: Vec2Local, b: Vec2Local): Vec2Local {
  return { x: a.x - b.x, y: a.y - b.y };
}

function norm(v: Vec2Local): Vec2Local {
  const len = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / len, y: v.y / len };
}

/** Left-hand perpendicular of a direction vector (rotate +90 degrees). */
function perp(v: Vec2Local): Vec2Local {
  return { x: -v.y, y: v.x };
}

/**
 * Buffers a centerline into a closed polygon ring of the given total width
 * (`halfWidthM` on each side). At each interior vertex the offset direction is the
 * (normalized) average of the two adjacent segment normals, which gives a reasonable
 * miter join for the gentle bends used in this schematic geometry. Not intended for
 * sharp corners or self-intersecting input.
 *
 * Returns an unclosed ring (first point != last point), matching `WaterBody.rings`.
 */
export function bufferCenterline(
  centerline: LatLon[],
  halfWidthM: number,
  origin: LatLon,
): LatLon[] {
  if (centerline.length < 2) {
    throw new Error('bufferCenterline needs at least 2 points');
  }
  const pts = centerline.map((p) => toMetric(p, origin));

  const segDirs: Vec2Local[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    segDirs.push(norm(sub(b, a)));
  }

  const offsets: Vec2Local[] = pts.map((_, i) => {
    const before = segDirs[i - 1];
    const after = segDirs[i];
    const dir =
      before && after ? norm({ x: before.x + after.x, y: before.y + after.y }) : (after ?? before)!;
    return perp(dir);
  });

  const left: Vec2Local[] = pts.map((p, i) => {
    const o = offsets[i]!;
    return { x: p.x + o.x * halfWidthM, y: p.y + o.y * halfWidthM };
  });
  const right: Vec2Local[] = pts.map((p, i) => {
    const o = offsets[i]!;
    return { x: p.x - o.x * halfWidthM, y: p.y - o.y * halfWidthM };
  });

  const ringMetric = [...left, ...right.reverse()];
  return ringMetric.map((v) => toLatLon(v, origin));
}
