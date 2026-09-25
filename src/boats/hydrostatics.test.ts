import { describe, expect, it } from 'vitest';
import {
  blockCoefficientForType,
  classifyHull,
  defaultDraughtM,
  estimateHydrostatics,
  FRESH_WATER_DENSITY_KG_M3,
} from './hydrostatics';

describe('classifyHull', () => {
  it('classifies inland cargo/tanker codes (70-89)', () => {
    expect(classifyHull(70)).toBe('inland-cargo-tanker');
    expect(classifyHull(89)).toBe('inland-cargo-tanker');
  });
  it('classifies pleasure/sailing codes (36, 37)', () => {
    expect(classifyHull(36)).toBe('pleasure-sailing');
    expect(classifyHull(37)).toBe('pleasure-sailing');
  });
  it('classifies passenger codes (60-69)', () => {
    expect(classifyHull(65)).toBe('passenger');
  });
  it('classifies tug (52)', () => {
    expect(classifyHull(52)).toBe('tug');
  });
  it('falls back to unknown for unmapped/missing codes', () => {
    expect(classifyHull(undefined)).toBe('unknown');
    expect(classifyHull(30)).toBe('unknown'); // fishing
  });
});

describe('blockCoefficientForType', () => {
  it('is within the requested ranges', () => {
    expect(blockCoefficientForType(75)).toBeGreaterThanOrEqual(0.85);
    expect(blockCoefficientForType(75)).toBeLessThanOrEqual(0.9);
    expect(blockCoefficientForType(65)).toBeCloseTo(0.6);
    expect(blockCoefficientForType(37)).toBeGreaterThanOrEqual(0.4);
    expect(blockCoefficientForType(37)).toBeLessThanOrEqual(0.5);
    expect(blockCoefficientForType(52)).toBeCloseTo(0.55);
    expect(blockCoefficientForType(undefined)).toBeCloseTo(0.7);
  });
});

describe('defaultDraughtM', () => {
  it('grows with length for inland cargo/tanker', () => {
    const small = defaultDraughtM(20, 79);
    const large = defaultDraughtM(135, 79);
    expect(large).toBeGreaterThan(small);
    expect(small).toBeCloseTo(1.5, 1);
    expect(large).toBeCloseTo(3.5, 1);
  });
  it('gives a shallow default for pleasure craft', () => {
    expect(defaultDraughtM(6, 37)).toBeLessThan(1);
  });
});

describe('estimateHydrostatics', () => {
  it('uses reported draught when present and > 0', () => {
    const result = estimateHydrostatics({ lengthM: 20, beamM: 5, draughtM: 2, shipTypeCode: 79 });
    expect(result.draughtM).toBe(2);
    expect(result.displacementM3).toBeCloseTo(20 * 5 * 2 * result.blockCoefficient);
    expect(result.massKg).toBeCloseTo(result.displacementM3 * FRESH_WATER_DENSITY_KG_M3);
  });

  it('falls back to a default draught when the reported one is 0 (AIS "not available")', () => {
    const withZero = estimateHydrostatics({ lengthM: 20, beamM: 5, draughtM: 0, shipTypeCode: 79 });
    const withUndefined = estimateHydrostatics({ lengthM: 20, beamM: 5, shipTypeCode: 79 });
    expect(withZero.draughtM).toBe(withUndefined.draughtM);
    expect(withZero.draughtM).toBeGreaterThan(0);
  });

  it('produces a larger mass for a barge than an equally-long pleasure boat', () => {
    const barge = estimateHydrostatics({ lengthM: 20, beamM: 5, draughtM: 1.5, shipTypeCode: 79 });
    const pleasure = estimateHydrostatics({
      lengthM: 20,
      beamM: 5,
      draughtM: 1.5,
      shipTypeCode: 37,
    });
    expect(barge.massKg).toBeGreaterThan(pleasure.massKg);
  });

  it('handles missing dimensions without throwing or producing NaN', () => {
    const result = estimateHydrostatics({ lengthM: 0, beamM: 0 });
    expect(Number.isFinite(result.displacementM3)).toBe(true);
    expect(result.displacementM3).toBe(0);
  });
});
