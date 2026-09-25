// Simulation Web Worker. Usage (main thread):
//   const w = new Worker(new URL('./sim/worker.ts', import.meta.url), { type: 'module' });
//   w.postMessage({ type: 'init', scene, config, levels } satisfies SimRequest);
// Protocol: see SimRequest / SimResponse in src/types.ts.
// While running, the model is advanced every TICK_MS and a 'field' snapshot is posted about
// every FIELD_MS (buffers are transferred; each snapshot uses fresh arrays).

import type { SimRequest, SimResponse } from '../types';
import { Simulation } from './simulation';

const TICK_MS = 30;
const FIELD_MS = 100;
/** Compute budget per tick; if exceeded the simulation runs slower than requested. */
const BUDGET_MS = 22;

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let sim: Simulation | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let lastTick = 0;
let lastField = 0;

function post(msg: SimResponse, transfer: Transferable[] = []): void {
  ctx.postMessage(msg, transfer);
}

function postField(): void {
  if (!sim) return;
  const field = sim.field();
  post({ type: 'field', field }, [
    field.u.buffer,
    field.v.buffer,
    field.eta.buffer,
    field.wet.buffer,
  ]);
  lastField = performance.now();
}

function postReady(): void {
  if (!sim) return;
  const { nx, ny, kind } = sim.grid;
  post({ type: 'ready', nx, ny, kind: kind.slice() });
}

function tick(): void {
  if (!sim) return;
  const t = performance.now();
  const dt = (t - lastTick) / 1000;
  lastTick = t;
  try {
    sim.advance(dt, BUDGET_MS);
  } catch (e) {
    stop();
    post({ type: 'error', message: errorMessage(e) });
    return;
  }
  if (t - lastField >= FIELD_MS) postField();
}

function start(): void {
  if (timer !== null || !sim) return;
  lastTick = performance.now();
  timer = setInterval(tick, TICK_MS);
}

function stop(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

ctx.onmessage = (ev: MessageEvent<SimRequest>) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case 'init': {
        const wasRunning = timer !== null;
        stop();
        sim = new Simulation(msg.scene, msg.config, msg.levels);
        postReady();
        postField();
        if (wasRunning) start();
        break;
      }
      case 'setLevels':
        sim?.setLevels(msg.levels);
        break;
      case 'setConfig': {
        if (!sim) break;
        const before = sim.getConfig().cellSizeM;
        sim.setConfig(msg.config);
        if (sim.getConfig().cellSizeM !== before) {
          postReady();
          postField();
        }
        break;
      }
      case 'setBoats':
        sim?.setBoats(msg.boats);
        break;
      case 'run':
        if (msg.running) start();
        else {
          stop();
          postField();
        }
        break;
      case 'sample':
        post({
          type: 'samples',
          requestId: msg.requestId,
          samples: sim ? sim.sample(msg.points) : [],
        });
        break;
    }
  } catch (e) {
    post({ type: 'error', message: errorMessage(e) });
  }
};
