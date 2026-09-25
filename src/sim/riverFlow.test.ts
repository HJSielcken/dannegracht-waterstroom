import { describe, expect, it } from 'vitest';
import type { MetricScene, Vec2 } from '../types';
import { buildGrid, KIND_ARK, KIND_VECHT } from './grid';
import { riverPotential } from './riverFlow';
import { Simulation } from './simulation';

function rect(x0: number, y0: number, x1: number, y1: number): Vec2[] {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

/** Two north-south rivers, 600 m long, joined halfway by a 10 m wide gracht (Vecht east). */
function riversScene(): MetricScene {
  return {
    waterBodies: [
      { id: 'vecht', kind: 'vecht', rings: [rect(0, -300, 30, 300)], depthM: 2.5 },
      { id: 'danne', kind: 'dannegracht', rings: [rect(-80, -5, 0, 5)], depthM: 1.8 },
      { id: 'ark', kind: 'ark', rings: [rect(-200, -300, -80, 300)], depthM: 5.5 },
    ],
    structures: [],
  };
}

const CONFIG = { cellSizeM: 10 / 3, manningN: 0.03, timeScale: 1 };
const LEVELS = { vechtNapM: -0.4, arkNapM: -0.4 };

describe('riverPotential', () => {
  it('falls linearly downstream by about one metre per metre in a straight river', () => {
    const grid = buildGrid(riversScene(), { cellSizeM: CONFIG.cellSizeM });
    const { psi, ends } = riverPotential(grid, KIND_VECHT);
    expect(ends.length).toBeGreaterThan(0);
    const at = (x: number, y: number) => {
      const i = Math.floor((x - grid.originX) / grid.dx);
      const j = Math.floor((y - grid.originY) / grid.dx);
      return psi[j * grid.nx + i]!;
    };
    // Upstream (south) is higher; 200 m apart along the river gives ~200.
    expect(at(15, -100) - at(15, 100)).toBeGreaterThan(190);
    expect(at(15, -100) - at(15, 100)).toBeLessThan(210);
    // Flat across the river.
    expect(Math.abs(at(3, 0) - at(27, 0))).toBeLessThan(5);
  });

  it('is NaN outside the river', () => {
    const grid = buildGrid(riversScene(), { cellSizeM: CONFIG.cellSizeM });
    const { psi } = riverPotential(grid, KIND_ARK);
    const i = Math.floor((15 - grid.originX) / grid.dx);
    const j = Math.floor((0 - grid.originY) / grid.dx);
    expect(Number.isNaN(psi[j * grid.nx + i]!)).toBe(true);
  });
});

describe('river currents', () => {
  const points = [
    { x: 15, y: -150 },
    { x: 15, y: 150 },
    { x: -140, y: -150 },
    { x: -140, y: 150 },
    { x: -40, y: 0 },
  ];

  it('makes both rivers flow north at the requested speed', () => {
    const sim = new Simulation(riversScene(), CONFIG, LEVELS, {}, { vechtMs: 0.05, arkMs: 0.02 });
    sim.advanceSim(300);
    const [v1, v2, a1, a2] = sim.sample(points);
    for (const s of [v1!, v2!]) {
      expect(s.v).toBeGreaterThan(0.045);
      expect(s.v).toBeLessThan(0.055);
      expect(Math.abs(s.u)).toBeLessThan(0.005);
    }
    for (const s of [a1!, a2!]) {
      expect(s.v).toBeGreaterThan(0.018);
      expect(s.v).toBeLessThan(0.022);
    }
  });

  it('flows south for a negative current', () => {
    const sim = new Simulation(riversScene(), CONFIG, LEVELS, {}, { vechtMs: -0.05, arkMs: 0 });
    sim.advanceSim(300);
    expect(sim.sample(points)[0]!.v).toBeLessThan(-0.045);
  });

  it('keeps the levels flat and leaves the gracht at rest', () => {
    const sim = new Simulation(riversScene(), CONFIG, LEVELS, {}, { vechtMs: 0.05, arkMs: 0.02 });
    sim.advanceSim(300);
    const samples = sim.sample(points);
    for (const s of samples) expect(Math.abs(s.levelNapM - LEVELS.vechtNapM)).toBeLessThan(0.001);
    expect(samples[4]!.speedMs).toBeLessThan(0.005);
  });
});
