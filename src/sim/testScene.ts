// Synthetic test geometry: two reservoirs joined by a narrow straight channel along x.
//   Vecht:       x in [-RES, 0],        y in [-RES/2, RES/2]   (west)
//   Dannegracht: x in [0, LEN],         y in [-W/2, W/2]
//   ARK:         x in [LEN, LEN + RES], y in [-RES/2, RES/2]   (east)

import type { MetricScene, MetricStructure, Vec2 } from '../types';

export const CHANNEL_LENGTH = 400;
export const CHANNEL_WIDTH = 10;
export const RESERVOIR = 150;

function rect(x0: number, y0: number, x1: number, y1: number): Vec2[] {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

export function channelScene(structures: MetricStructure[] = []): MetricScene {
  const h = RESERVOIR / 2;
  const w = CHANNEL_WIDTH / 2;
  return {
    waterBodies: [
      { id: 'vecht', kind: 'vecht', rings: [rect(-RESERVOIR, -h, 0, h)], depthM: 3 },
      { id: 'danne', kind: 'dannegracht', rings: [rect(0, -w, CHANNEL_LENGTH, w)], depthM: 2.5 },
      {
        id: 'ark',
        kind: 'ark',
        rings: [rect(CHANNEL_LENGTH, -h, CHANNEL_LENGTH + RESERVOIR, h)],
        depthM: 4.5,
      },
    ],
    structures,
  };
}
