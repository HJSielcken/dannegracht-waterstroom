import { describe, expect, it } from 'vitest';
import type { LatLon, Scene } from '../types';
import { projectScene, toLatLon, toMetric } from './project';

const ORIGIN: LatLon = { lat: 52.1732, lon: 4.9985 };

describe('toMetric / toLatLon round trip', () => {
  it('returns (0,0) for the origin itself', () => {
    const v = toMetric(ORIGIN, ORIGIN);
    expect(v.x).toBeCloseTo(0, 9);
    expect(v.y).toBeCloseTo(0, 9);
  });

  it('round-trips a set of nearby points to within millimetres', () => {
    const points: LatLon[] = [
      { lat: 52.1735, lon: 5.0035 },
      { lat: 52.173, lon: 4.9935 },
      { lat: 52.178, lon: 4.9932 },
      { lat: 52.1695, lon: 5.0015 },
    ];
    for (const p of points) {
      const v = toMetric(p, ORIGIN);
      const back = toLatLon(v, ORIGIN);
      expect(back.lat).toBeCloseTo(p.lat, 9);
      expect(back.lon).toBeCloseTo(p.lon, 9);
    }
  });

  it('places east/north offsets in the expected direction', () => {
    const east = toMetric({ lat: ORIGIN.lat, lon: ORIGIN.lon + 0.001 }, ORIGIN);
    expect(east.x).toBeGreaterThan(0);
    expect(east.y).toBeCloseTo(0, 6);

    const north = toMetric({ lat: ORIGIN.lat + 0.001, lon: ORIGIN.lon }, ORIGIN);
    expect(north.y).toBeGreaterThan(0);
    expect(north.x).toBeCloseTo(0, 6);
  });

  it('produces roughly correct metric distances (111.32 km/deg lat)', () => {
    const v = toMetric({ lat: ORIGIN.lat + 1, lon: ORIGIN.lon }, ORIGIN);
    expect(v.y).toBeCloseTo(111_320, -2);
  });
});

describe('projectScene', () => {
  it('projects water bodies, structures, and drops probes (not part of MetricScene)', () => {
    const scene: Scene = {
      origin: ORIGIN,
      waterBodies: [
        {
          id: 'wb1',
          kind: 'dannegracht',
          name: 'Test',
          rings: [
            [
              { lat: 52.1732, lon: 4.998 },
              { lat: 52.1732, lon: 4.999 },
              { lat: 52.1733, lon: 4.999 },
            ],
          ],
          depthM: 1.8,
        },
      ],
      structures: [
        {
          id: 's1',
          kind: 'bridge',
          name: 'Test bridge',
          position: { lat: 52.1732, lon: 4.9985 },
          blocksFlow: false,
          openFraction: 0.8,
        },
      ],
      probes: [{ id: 'p1', name: 'Test probe', position: ORIGIN }],
      source: 'fallback',
    };

    const metric = projectScene(scene);
    expect(metric.waterBodies).toHaveLength(1);
    expect(metric.waterBodies[0]!.rings[0]).toHaveLength(3);
    expect(metric.structures).toHaveLength(1);
    expect(metric.structures[0]!.openFraction).toBe(0.8);
    expect(metric.structures[0]!.position.x).toBeCloseTo(0, 6);
  });
});
