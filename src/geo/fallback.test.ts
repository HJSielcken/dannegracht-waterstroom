import { describe, expect, it } from 'vitest';
import type { LatLon, Vec2 } from '../types';
import { fallbackScene } from './fallback';
import { toMetric } from './project';

function pointInRing(p: Vec2, ring: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function pointSegDist(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  let t = len2 === 0 ? 0 : ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + abx * t;
  const cy = a.y + aby * t;
  return Math.hypot(p.x - cx, p.y - cy);
}

function ringMinDistToPoint(ring: Vec2[], p: Vec2): number {
  let min = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    min = Math.min(min, pointSegDist(p, a, b));
  }
  return min;
}

function ringMinDistToRing(a: Vec2[], b: Vec2[]): number {
  let min = Infinity;
  for (const p of a) min = Math.min(min, ringMinDistToPoint(b, p));
  for (const p of b) min = Math.min(min, ringMinDistToPoint(a, p));
  return min;
}

describe('fallbackScene', () => {
  const scene = fallbackScene();

  it('has the three expected water bodies', () => {
    const kinds = scene.waterBodies.map((w) => w.kind).sort();
    expect(kinds).toEqual(['ark', 'dannegracht', 'vecht']);
  });

  it('marks the source as fallback', () => {
    expect(scene.source).toBe('fallback');
  });

  it('Dannegracht polygon connects to (touches/overlaps) both the Vecht and the ARK', () => {
    const origin = scene.origin;
    const toM = (ring: LatLon[]) => ring.map((p) => toMetric(p, origin));

    const vecht = scene.waterBodies.find((w) => w.kind === 'vecht')!;
    const danne = scene.waterBodies.find((w) => w.kind === 'dannegracht')!;
    const ark = scene.waterBodies.find((w) => w.kind === 'ark')!;

    const vechtRing = toM(vecht.rings[0]!);
    const danneRing = toM(danne.rings[0]!);
    const arkRing = toM(ark.rings[0]!);

    // "Touches/overlaps": the polygons share a junction vertex by construction, so the
    // minimum distance between their boundaries should be at most the wider channel's
    // half-width, not e.g. hundreds of metres apart.
    expect(ringMinDistToRing(danneRing, vechtRing)).toBeLessThan(15);
    expect(ringMinDistToRing(danneRing, arkRing)).toBeLessThan(60);
  });

  it('pins the Brugstraat 10e probe and cannot remove it', () => {
    const probe = scene.probes.find((p) => p.id === 'brugstraat-10e');
    expect(probe).toBeDefined();
    expect(probe?.pinned).toBe(true);
  });

  it('places Brugstraat 10e within ~50 m of the Dannegracht', () => {
    const origin = scene.origin;
    const probe = scene.probes.find((p) => p.id === 'brugstraat-10e')!;
    const danne = scene.waterBodies.find((w) => w.kind === 'dannegracht')!;
    const danneRing = danne.rings[0]!.map((p) => toMetric(p, origin));
    const probeM = toMetric(probe.position, origin);
    expect(ringMinDistToPoint(danneRing, probeM)).toBeLessThan(50);
  });

  it('includes the extra Dannegracht probes (Vecht mouth, ARK mouth, midway)', () => {
    const ids = scene.probes.map((p) => p.id).sort();
    expect(ids).toEqual(
      [
        'brugstraat-10e',
        'dannegracht-ark-mouth',
        'dannegracht-midway',
        'dannegracht-vecht-mouth',
      ].sort(),
    );
  });

  it('includes researched structures without inventing a weir or culvert', () => {
    const kinds = new Set(scene.structures.map((s) => s.kind));
    expect(kinds.has('lock')).toBe(true);
    expect(kinds.has('bridge')).toBe(true);
    expect(kinds.has('weir')).toBe(false);
    expect(kinds.has('culvert')).toBe(false);
  });

  it('every structure position lies close to the Dannegracht centerline area', () => {
    const origin = scene.origin;
    const danne = scene.waterBodies.find((w) => w.kind === 'dannegracht')!;
    const danneRing = danne.rings[0]!.map((p) => toMetric(p, origin));
    for (const s of scene.structures) {
      const p = toMetric(s.position, origin);
      expect(ringMinDistToPoint(danneRing, p)).toBeLessThan(20);
    }
  });

  it('runs the Dannegracht polygon well into both rivers so they visibly overlap', () => {
    const origin = scene.origin;
    const ring = (kind: string) =>
      scene.waterBodies.find((w) => w.kind === kind)!.rings[0]!.map((p) => toMetric(p, origin));
    const danne = ring('dannegracht');
    for (const river of ['vecht', 'ark']) {
      const riverRing = ring(river);
      // Deeply overlapping: at least 4 of the Danne outline's corners lie inside the river.
      const inside = danne.filter((p) => pointInRing(p, riverRing)).length;
      expect(inside, river).toBeGreaterThanOrEqual(4);
    }
  });
});
