import { describe, expect, it } from 'vitest';
import type { MetricScene, Vec2 } from '../types';
import { KIND_ARK, KIND_DANNEGRACHT, KIND_VECHT, buildGrid, type Grid } from './grid';
import { CHANNEL_LENGTH, channelScene } from './testScene';

function cellAt(g: Grid, p: Vec2): number {
  const i = Math.floor((p.x - g.originX) / g.dx);
  const j = Math.floor((p.y - g.originY) / g.dx);
  return j * g.nx + i;
}

/** 4-neighbour connectivity through open faces. */
function connected(g: Grid, a: number, b: number): boolean {
  const { nx, faceU, faceV } = g;
  const seen = new Uint8Array(g.nx * g.ny);
  const stack = [a];
  seen[a] = 1;
  while (stack.length) {
    const c = stack.pop()!;
    if (c === b) return true;
    const i = c % nx;
    const j = (c - i) / nx;
    const nbs: [number, number][] = [
      [c - 1, faceU[j * (nx + 1) + i]!],
      [c + 1, faceU[j * (nx + 1) + i + 1]!],
      [c - nx, faceV[c]!],
      [c + nx, faceV[c + nx]!],
    ];
    for (const [m, f] of nbs) {
      if (f > 0 && !seen[m]) {
        seen[m] = 1;
        stack.push(m);
      }
    }
  }
  return false;
}

function crossSectionCells(g: Grid, x: number): number {
  let n = 0;
  const i = Math.floor((x - g.originX) / g.dx);
  for (let j = 0; j < g.ny; j++) n += g.water[j * g.nx + i]!;
  return n;
}

describe('buildGrid', () => {
  it('rasterises reservoirs and a connected 10 m channel with bed levels', () => {
    for (const dx of [2.5, 10 / 3, 4]) {
      const g = buildGrid(channelScene(), { cellSizeM: dx });
      const v = cellAt(g, { x: -50, y: 0 });
      const d = cellAt(g, { x: 200, y: 0 });
      const a = cellAt(g, { x: CHANNEL_LENGTH + 50, y: 0 });
      expect(g.kind[v]).toBe(KIND_VECHT);
      expect(g.kind[d]).toBe(KIND_DANNEGRACHT);
      expect(g.kind[a]).toBe(KIND_ARK);
      expect(g.zb[d]).toBeCloseTo(-0.4 - 2.5);
      expect(g.zb[a]).toBeCloseTo(-0.4 - 4.5);
      expect(connected(g, v, a)).toBe(true);
      expect(crossSectionCells(g, 200)).toBeGreaterThanOrEqual(2);
      // padded: outer ring is land
      expect(g.water[0]).toBe(0);
    }
  });

  it('respects polygon holes', () => {
    const ring = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ];
    const scene: MetricScene = {
      waterBodies: [
        { id: 'l', kind: 'other', rings: [ring(0, 0, 100, 100), ring(30, 30, 70, 70)], depthM: 2 },
      ],
      structures: [],
    };
    const g = buildGrid(scene, { cellSizeM: 4 });
    expect(g.water[cellAt(g, { x: 50, y: 50 })]).toBe(0);
    expect(g.water[cellAt(g, { x: 15, y: 50 })]).toBe(1);
  });

  it('keeps a narrow diagonal canal 4-connected', () => {
    // 7 m wide canal at 45 degrees, 4 m cells.
    const w = 3.5 / Math.SQRT2;
    const scene: MetricScene = {
      waterBodies: [
        {
          id: 'c',
          kind: 'dannegracht',
          rings: [
            [
              { x: w, y: -w },
              { x: 200 + w, y: 200 - w },
              { x: 200 - w, y: 200 + w },
              { x: -w, y: w },
            ],
          ],
          depthM: 2,
        },
      ],
      structures: [],
    };
    const g = buildGrid(scene, { cellSizeM: 4 });
    expect(connected(g, cellAt(g, { x: 10, y: 10 }), cellAt(g, { x: 190, y: 190 }))).toBe(true);
  });

  it('a blocking structure cuts the channel, openFraction narrows faces', () => {
    const closed = buildGrid(
      channelScene([{ id: 'lock', kind: 'lock', position: { x: 200, y: 1 }, blocksFlow: true }]),
      { cellSizeM: 10 / 3 },
    );
    const v = cellAt(closed, { x: -50, y: 0 });
    const a = cellAt(closed, { x: CHANNEL_LENGTH + 50, y: 0 });
    expect(connected(closed, v, a)).toBe(false);
    expect(closed.blocked[cellAt(closed, { x: 200, y: 0 })]).toBe(1);
    // Reservoirs untouched.
    expect(closed.water[cellAt(closed, { x: -50, y: 0 })]).toBe(1);

    const bridge = buildGrid(
      channelScene([
        {
          id: 'b',
          kind: 'bridge',
          position: { x: 200, y: 0 },
          blocksFlow: false,
          openFraction: 0.5,
        },
      ]),
      { cellSizeM: 10 / 3 },
    );
    const c = cellAt(bridge, { x: 200, y: 0 });
    const j = Math.floor(c / bridge.nx);
    expect(bridge.faceU[c + j]).toBeCloseTo(0.5);
    expect(connected(bridge, v, a)).toBe(true);
  });
});
