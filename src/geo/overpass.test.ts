import { describe, expect, it } from 'vitest';
import {
  buildOverpassQuery,
  clipRingToBBox,
  joinWaysIntoRings,
  parseOverpassResponse,
  type BBox,
  type OverpassResponse,
} from './overpass';

const BBOX: BBox = { south: -10, west: -10, north: 10, east: 10 };

describe('buildOverpassQuery', () => {
  it('embeds the bbox and requests geometry output', () => {
    const q = buildOverpassQuery({ south: 1, west: 2, north: 3, east: 4 });
    expect(q).toContain('1,2,3,4');
    expect(q).toContain('out geom');
    expect(q).toContain('lock_gate');
    expect(q).toContain('weir');
    expect(q).toContain('culvert');
  });
});

describe('joinWaysIntoRings', () => {
  it('joins two ways sharing endpoints into one closed ring', () => {
    const wayA = [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 1 },
      { lat: 1, lon: 1 },
    ];
    const wayB = [
      { lat: 1, lon: 1 },
      { lat: 1, lon: 0 },
      { lat: 0, lon: 0 },
    ];
    const rings = joinWaysIntoRings([wayA, wayB]);
    expect(rings).toHaveLength(1);
    expect(rings[0]).toHaveLength(4); // closing point dropped
  });

  it('joins ways regardless of direction (reversed segment)', () => {
    const wayA = [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 1 },
    ];
    const wayBReversed = [
      { lat: 1, lon: 0 },
      { lat: 1, lon: 1 },
      { lat: 0, lon: 1 }, // shares endpoint with wayA's end, but same-order end
    ];
    const wayC = [
      { lat: 1, lon: 0 },
      { lat: 0, lon: 0 },
    ];
    const rings = joinWaysIntoRings([wayA, wayBReversed, wayC]);
    expect(rings).toHaveLength(1);
    expect(rings[0]!.length).toBeGreaterThanOrEqual(3);
  });

  it('leaves an unclosed chain as its own (open) ring rather than dropping it', () => {
    const dangling = [
      { lat: 0, lon: 0 },
      { lat: 5, lon: 5 },
    ];
    const rings = joinWaysIntoRings([dangling]);
    expect(rings).toHaveLength(1);
    expect(rings[0]).toEqual(dangling);
  });
});

describe('clipRingToBBox', () => {
  it('leaves a ring fully inside the bbox untouched', () => {
    const ring = [
      { lat: -1, lon: -1 },
      { lat: -1, lon: 1 },
      { lat: 1, lon: 1 },
      { lat: 1, lon: -1 },
    ];
    expect(clipRingToBBox(ring, BBOX)).toHaveLength(4);
  });

  it('clips a ring that extends beyond the bbox', () => {
    const ring = [
      { lat: -100, lon: -100 },
      { lat: -100, lon: 100 },
      { lat: 100, lon: 100 },
      { lat: 100, lon: -100 },
    ];
    const clipped = clipRingToBBox(ring, BBOX);
    for (const p of clipped) {
      expect(p.lat).toBeGreaterThanOrEqual(BBOX.south - 1e-9);
      expect(p.lat).toBeLessThanOrEqual(BBOX.north + 1e-9);
      expect(p.lon).toBeGreaterThanOrEqual(BBOX.west - 1e-9);
      expect(p.lon).toBeLessThanOrEqual(BBOX.east + 1e-9);
    }
    expect(clipped.length).toBeGreaterThanOrEqual(4);
  });
});

describe('parseOverpassResponse', () => {
  const bbox: BBox = { south: 52.16, west: 4.98, north: 52.19, east: 5.02 };

  it('parses a simple named water way into a classified WaterBody', () => {
    const response: OverpassResponse = {
      elements: [
        {
          type: 'way',
          id: 1,
          tags: { natural: 'water', name: 'Vecht' },
          geometry: [
            { lat: 52.171, lon: 5.001 },
            { lat: 52.171, lon: 5.002 },
            { lat: 52.172, lon: 5.002 },
            { lat: 52.172, lon: 5.001 },
            { lat: 52.171, lon: 5.001 },
          ],
        },
      ],
    };
    const scene = parseOverpassResponse(response, bbox);
    expect(scene.source).toBe('osm');
    expect(scene.waterBodies).toHaveLength(1);
    expect(scene.waterBodies[0]!.kind).toBe('vecht');
    expect(scene.waterBodies[0]!.rings[0]).toHaveLength(4); // closing point dropped
  });

  it('assembles a multipolygon relation whose outer ring is split across two ways', () => {
    const response: OverpassResponse = {
      elements: [
        {
          type: 'relation',
          id: 10,
          tags: { type: 'multipolygon', waterway: 'riverbank', name: 'Dannegracht' },
          members: [
            {
              type: 'way',
              ref: 101,
              role: 'outer',
              geometry: [
                { lat: 52.1733, lon: 4.997 },
                { lat: 52.1733, lon: 4.999 },
                { lat: 52.1735, lon: 4.999 },
              ],
            },
            {
              type: 'way',
              ref: 102,
              role: 'outer',
              geometry: [
                { lat: 52.1735, lon: 4.999 },
                { lat: 52.1735, lon: 4.997 },
                { lat: 52.1733, lon: 4.997 },
              ],
            },
          ],
        },
      ],
    };
    const scene = parseOverpassResponse(response, bbox);
    expect(scene.waterBodies).toHaveLength(1);
    const body = scene.waterBodies[0]!;
    expect(body.kind).toBe('dannegracht');
    expect(body.rings).toHaveLength(1);
    expect(body.rings[0]).toHaveLength(4);
  });

  it('classifies an unnamed water polygon by proximity to a named waterway line', () => {
    const response: OverpassResponse = {
      elements: [
        {
          type: 'way',
          id: 5,
          tags: { waterway: 'river', name: 'Amsterdam-Rijnkanaal' },
          geometry: [
            { lat: 52.173, lon: 4.9935 },
            { lat: 52.178, lon: 4.9932 },
          ],
        },
        {
          type: 'way',
          id: 6,
          tags: { natural: 'water' }, // unnamed polygon right next to the ARK line
          geometry: [
            { lat: 52.1729, lon: 4.9934 },
            { lat: 52.1729, lon: 4.9936 },
            { lat: 52.1731, lon: 4.9936 },
            { lat: 52.1731, lon: 4.9934 },
            { lat: 52.1729, lon: 4.9934 },
          ],
        },
      ],
    };
    const scene = parseOverpassResponse(response, bbox);
    const unnamed = scene.waterBodies.find((w) => w.id === 'way-6');
    expect(unnamed?.kind).toBe('ark');
  });

  it('extracts a lock node, a weir way, and a bridge way as structures', () => {
    const response: OverpassResponse = {
      elements: [
        {
          type: 'node',
          id: 20,
          lat: 52.1734,
          lon: 5.0003,
          tags: { waterway: 'lock_gate' },
        },
        {
          type: 'way',
          id: 21,
          tags: { waterway: 'weir', name: 'Test weir' },
          geometry: [
            { lat: 52.1732, lon: 4.999 },
            { lat: 52.1732, lon: 4.9992 },
          ],
        },
        {
          type: 'way',
          id: 22,
          tags: { man_made: 'bridge', name: 'Test bridge' },
          geometry: [
            { lat: 52.1731, lon: 4.998 },
            { lat: 52.1731, lon: 4.9982 },
          ],
        },
      ],
    };
    const scene = parseOverpassResponse(response, bbox);
    const kinds = scene.structures.map((s) => s.kind).sort();
    expect(kinds).toEqual(['bridge', 'lock', 'weir']);
    const lock = scene.structures.find((s) => s.kind === 'lock')!;
    expect(lock.blocksFlow).toBe(true);
    const bridge = scene.structures.find((s) => s.kind === 'bridge')!;
    expect(bridge.openFraction).toBe(0.85);
  });

  it('includes the shared fallback probe set (pinned Brugstraat 10e included)', () => {
    const scene = parseOverpassResponse({ elements: [] }, bbox);
    expect(scene.probes.find((p) => p.id === 'brugstraat-10e')?.pinned).toBe(true);
  });
});
