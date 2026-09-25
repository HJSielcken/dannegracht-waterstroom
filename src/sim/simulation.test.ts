import { describe, expect, it } from 'vitest';
import type { BoundaryLevels, MetricStructure, SimBoat, SimConfig } from '../types';
import { fallbackScene } from '../geo/fallback';
import { projectScene } from '../geo/project';
import { Simulation, directionDeg } from './simulation';
import { CHANNEL_LENGTH, CHANNEL_WIDTH, channelScene } from './testScene';

// 3.33 m cells -> the 10 m channel is 3 cells wide; small sponge distances for small reservoirs.
const CONFIG: SimConfig = { cellSizeM: 10 / 3, manningN: 0.03, timeScale: 1 };
const PARAMS = { spongeStartM: 20, spongeFullM: 80 };
const EQUAL: BoundaryLevels = { vechtNapM: -0.4, arkNapM: -0.4 };
const VECHT_HIGH: BoundaryLevels = { vechtNapM: -0.3, arkNapM: -0.4 };
const ARK_HIGH: BoundaryLevels = { vechtNapM: -0.4, arkNapM: -0.3 };

function make(levels: BoundaryLevels, structures: MetricStructure[] = []): Simulation {
  return new Simulation(channelScene(structures), CONFIG, levels, PARAMS);
}

/** Cross-section averaged x-velocity at several stations along the channel. */
function channelU(sim: Simulation, xs = [60, 140, 260, 340]): number[] {
  const w = CHANNEL_WIDTH / 2 - 1;
  return xs.map((x) => {
    const s = sim.sample([
      { x, y: -w },
      { x, y: 0 },
      { x, y: w },
    ]);
    return s.reduce((a, q) => a + q.u, 0) / s.length;
  });
}

function boat(x: number, vx: number, size = 1): SimBoat {
  return {
    id: `b${x}${vx}${size}`,
    position: { x, y: 0 },
    velocity: { x: vx, y: 0 },
    lengthM: 20 * size,
    beamM: 4 * size,
    draughtM: 1 * size,
  };
}

describe('Simulation', { timeout: 30_000 }, () => {
  it('(a) equal levels give no flow; flow dies out after levels are equalised', () => {
    const still = make(EQUAL);
    still.advanceSim(300);
    for (const u of channelU(still)) expect(Math.abs(u)).toBeLessThan(1e-9);

    const sim = make(VECHT_HIGH);
    sim.advanceSim(300);
    expect(channelU(sim)[1]!).toBeGreaterThan(0.1);
    sim.setLevels(EQUAL);
    sim.advanceSim(900);
    for (const u of channelU(sim)) expect(Math.abs(u)).toBeLessThan(0.03);
  });

  it('(b) flow goes from high to low level and reverses with the levels', () => {
    const fwd = make(VECHT_HIGH);
    fwd.advanceSim(400);
    const uf = channelU(fwd);
    for (const u of uf) expect(u).toBeGreaterThan(0.2);
    const s = fwd.sample([{ x: 200, y: 0 }])[0]!;
    expect(s.wet).toBe(true);
    expect(s.directionDeg).toBeGreaterThan(80); // towards the east (ARK)
    expect(s.directionDeg).toBeLessThan(100);
    // Water level decreases from the Vecht end to the ARK end.
    const [l0, l1] = fwd.sample([
      { x: 20, y: 0 },
      { x: CHANNEL_LENGTH - 20, y: 0 },
    ]);
    expect(l0!.levelNapM).toBeGreaterThan(l1!.levelNapM);

    const rev = make(ARK_HIGH);
    rev.advanceSim(400);
    const ur = channelU(rev);
    for (let i = 0; i < ur.length; i++) {
      expect(ur[i]!).toBeLessThan(-0.2);
      // Nearly symmetric response (depth differs between the two reservoirs).
      expect(Math.abs(ur[i]! + uf[i]!)).toBeLessThan(0.1);
    }
    const sr = rev.sample([{ x: 200, y: 0 }])[0]!;
    expect(sr.directionDeg).toBeGreaterThan(260);
    expect(sr.directionDeg).toBeLessThan(280);
  });

  it('(c) conserves mass (volume budget closes) and stays finite over long runs', () => {
    const sim = make(VECHT_HIGH);
    const v0 = sim.solver.volume();
    sim.setBoats([boat(-60, 2.5, 1.2), boat(CHANNEL_LENGTH + 40, -2, 1)]);
    sim.advanceSim(600);
    const v1 = sim.solver.volume();
    expect(Math.abs(v1 - v0 - sim.solver.spongeVolumeM3) / v0).toBeLessThan(1e-9);
    expect(sim.solver.repairs).toBe(0);
    const f = sim.field();
    expect(f.u.length).toBe(f.nx * f.ny);
    let wet = 0;
    for (let c = 0; c < f.nx * f.ny; c++) {
      if (!f.wet[c]) continue;
      wet++;
      expect(Number.isFinite(f.u[c]!) && Number.isFinite(f.v[c]!)).toBe(true);
      expect(Number.isFinite(f.eta[c]!)).toBe(true);
      expect(Math.hypot(f.u[c]!, f.v[c]!)).toBeLessThan(3);
    }
    expect(wet).toBe(sim.grid.waterCount);
    expect(f.timeS).toBeCloseTo(600);
  });

  it('(d) a sailing boat induces a return current opposite to its motion, growing with size/speed', () => {
    const run = (vx: number, size: number, x0: number): { u: number; drawdown: number } => {
      const sim = make(EQUAL);
      sim.setBoats([boat(x0, vx, size)]);
      sim.advanceSim(100);
      const pos = sim.solver.boats.positions()[0]!.pos;
      expect(Math.abs(pos.x - (x0 + vx * 100))).toBeLessThan(1e-6);
      const s = sim.sample([
        { x: pos.x, y: -3 },
        { x: pos.x, y: 3 },
      ]);
      return {
        u: (s[0]!.u + s[1]!.u) / 2,
        drawdown: -0.4 - (s[0]!.levelNapM + s[1]!.levelNapM) / 2,
      };
    };
    const east = run(1.5, 1, 50);
    expect(east.u).toBeLessThan(-0.05);
    expect(east.drawdown).toBeGreaterThan(0.05);
    const west = run(-1.5, 1, 350);
    expect(west.u).toBeGreaterThan(0.05);
    const bigFast = run(2.2, 1.3, 20);
    expect(bigFast.u).toBeLessThan(east.u);
  });

  it('(e) a closed lock stops the flow through the channel', () => {
    const sim = make(VECHT_HIGH, [
      { id: 'lock', kind: 'lock', position: { x: 200, y: 0 }, blocksFlow: true },
    ]);
    sim.advanceSim(400);
    for (const u of channelU(sim)) expect(Math.abs(u)).toBeLessThan(0.01);
    expect(sim.sample([{ x: 200, y: 0 }])[0]!.wet).toBe(false);
  });

  it('samples land as dry and handles config changes', () => {
    const sim = make(VECHT_HIGH);
    const land = sim.sample([{ x: 200, y: 60 }])[0]!;
    expect(land.wet).toBe(false);
    expect(land.speedMs).toBe(0);
    const outside = sim.sample([{ x: 1e6, y: 1e6 }])[0]!;
    expect(outside.wet).toBe(false);

    sim.setConfig({ manningN: 0.05 });
    expect(sim.getConfig().manningN).toBe(0.05);
    sim.setConfig({ cellSizeM: 5 });
    expect(sim.grid.dx).toBe(5);
    // timeScale: 0.5 s real at 10x -> 5 s simulated.
    sim.setConfig({ timeScale: 10 });
    expect(sim.advance(0.5)).toBeCloseTo(5);
  });

  it('stays still at equal levels when advanced in short calls, as the browser does', () => {
    // A short remainder step at the end of every call used to make grid-scale waves in the
    // ARK grow to decimetres within a few minutes, without any boat or level difference.
    const scene = projectScene(fallbackScene());
    const currents = { vechtMs: 0.05, arkMs: 0.02 };
    const sim = new Simulation(scene, { ...CONFIG, cellSizeM: 3 }, EQUAL, {}, currents);
    for (let t = 0; t < 300; t++) sim.advanceSim(1);
    expect(sim.timeS).toBeCloseTo(300);
    let maxDev = 0;
    for (const c of sim.solver.cells) maxDev = Math.max(maxDev, Math.abs(sim.solver.eta[c]! + 0.4));
    expect(maxDev).toBeLessThan(0.01);
  });

  it('a boat lying still in a river does not drive a current through the channel', () => {
    // The reservoir nudging used to lift the depression under the hull back to the river
    // level, so the boat kept feeding water that flowed away through the channel.
    const sim = make(EQUAL);
    sim.setBoats([{ ...boat(CHANNEL_LENGTH + 100, 0, 1.5), id: 'still' }]);
    // The boat's appearance sets the channel sloshing; only the mean flow is of interest.
    sim.advanceSim(300);
    const mean = [0, 0, 0, 0];
    for (let k = 0; k < 60; k++) {
      sim.advanceSim(10);
      channelU(sim).forEach((u, i) => (mean[i]! += u / 60));
    }
    for (const u of mean) expect(Math.abs(u)).toBeLessThan(0.005);
  });

  it('directionDeg is clockwise from north, pointing where the water goes', () => {
    expect(directionDeg(0, 1)).toBeCloseTo(0);
    expect(directionDeg(1, 0)).toBeCloseTo(90);
    expect(directionDeg(0, -1)).toBeCloseTo(180);
    expect(directionDeg(-1, 0)).toBeCloseTo(270);
  });
});
