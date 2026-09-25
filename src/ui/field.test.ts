import { describe, expect, it } from 'vitest';
import type { FlowField } from '../types';
import { compassLabel, directionDeg, velocityAt } from './field';

function field(): FlowField {
  // 2 x 2 cells of 10 m, only the bottom-left cell dry.
  return {
    nx: 2,
    ny: 2,
    cellSizeM: 10,
    originX: 0,
    originY: 0,
    u: Float32Array.from([0, 1, 1, 1]),
    v: Float32Array.from([0, 0, 0, 0]),
    eta: new Float32Array(4),
    wet: Uint8Array.from([0, 1, 1, 1]),
    timeS: 0,
  };
}

describe('directionDeg', () => {
  it('uses bearings clockwise from north', () => {
    expect(directionDeg(0, 1)).toBeCloseTo(0);
    expect(directionDeg(1, 0)).toBeCloseTo(90);
    expect(directionDeg(0, -1)).toBeCloseTo(180);
    expect(directionDeg(-1, 0)).toBeCloseTo(270);
  });
});

describe('compassLabel', () => {
  it('maps bearings to Dutch compass points', () => {
    expect(compassLabel(0)).toBe('N');
    expect(compassLabel(90)).toBe('O');
    expect(compassLabel(225)).toBe('ZW');
    expect(compassLabel(359)).toBe('N');
  });
});

describe('velocityAt', () => {
  it('interpolates only over wet cells', () => {
    const f = field();
    expect(velocityAt(f, { x: 10, y: 10 })).toEqual({ x: 1, y: 0 });
    expect(velocityAt(f, { x: 15, y: 15 })).toEqual({ x: 1, y: 0 });
  });

  it('returns null outside the wet area', () => {
    const f = field();
    expect(velocityAt(f, { x: 2, y: 2 })).toBeNull();
    expect(velocityAt(f, { x: -50, y: -50 })).toBeNull();
  });
});
