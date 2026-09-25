import { describe, expect, it } from 'vitest';
import type { LatLon } from '../types';
import { bufferCenterline } from './buffer';
import { toMetric } from './project';

const ORIGIN: LatLon = { lat: 52.1732, lon: 4.9985 };

describe('bufferCenterline', () => {
  it('produces a closed ring (2N points) with the requested width for a straight segment', () => {
    const centerline: LatLon[] = [
      { lat: 52.1732, lon: 4.99 },
      { lat: 52.1732, lon: 5.0 },
    ];
    const ring = bufferCenterline(centerline, 10, ORIGIN);
    expect(ring).toHaveLength(4); // 2 left + 2 right

    const metricRing = ring.map((p) => toMetric(p, ORIGIN));
    // Straight east-west line -> the perpendicular offset is purely north/south.
    for (const p of metricRing) {
      expect(Math.abs(Math.abs(p.y) - 10)).toBeLessThan(1e-6);
    }
  });

  it('keeps every buffered point within a couple metres of the requested half-width from the nearest centerline vertex', () => {
    const centerline: LatLon[] = [
      { lat: 52.1735, lon: 5.0035 },
      { lat: 52.1733, lon: 4.9985 },
      { lat: 52.173, lon: 4.9935 },
    ];
    const halfWidth = 5;
    const ring = bufferCenterline(centerline, halfWidth, ORIGIN);
    const centerMetric = centerline.map((p) => toMetric(p, ORIGIN));

    for (const ringPoint of ring.map((p) => toMetric(p, ORIGIN))) {
      const minDist = Math.min(
        ...centerMetric.map((c) => Math.hypot(c.x - ringPoint.x, c.y - ringPoint.y)),
      );
      // Miter joins on a bend can push the offset out a bit further than halfWidth.
      expect(minDist).toBeLessThan(halfWidth * 1.5);
    }
  });

  it('throws on fewer than 2 points', () => {
    expect(() => bufferCenterline([{ lat: 52, lon: 5 }], 5, ORIGIN)).toThrow();
  });
});
