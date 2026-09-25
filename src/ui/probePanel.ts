import type { FlowSample, Probe, Vec2 } from '../types';
import { compassLabel } from './field';

export interface ProbePanelOptions {
  /** Unit vector along the Dannegracht pointing from the Vecht towards the ARK (metric frame). */
  axis: Vec2;
  onFocus: (probe: Probe) => void;
  onRemove: (probe: Probe) => void;
}

interface Row {
  probe: Probe;
  el: HTMLElement;
  history: number[];
}

const HISTORY = 240;

/** Side panel listing every probe with its current speed, direction and a history sparkline. */
export class ProbePanel {
  private rows = new Map<string, Row>();

  constructor(
    private root: HTMLElement,
    private opts: ProbePanelOptions,
  ) {}

  setProbes(probes: Probe[]): void {
    for (const [id, row] of this.rows) {
      if (!probes.some((p) => p.id === id)) {
        row.el.remove();
        this.rows.delete(id);
      }
    }
    for (const probe of probes) {
      if (this.rows.has(probe.id)) continue;
      const el = document.createElement('article');
      el.className = `probe${probe.pinned ? ' probe--pinned' : ''}`;
      el.innerHTML = `
        <header>
          <button class="probe__name" type="button"></button>
          ${probe.pinned ? '' : '<button class="probe__remove" type="button" aria-label="Verwijder meetpunt">×</button>'}
        </header>
        <div class="probe__body">
          <svg class="probe__dial" viewBox="-20 -20 40 40" aria-hidden="true">
            <circle r="18" />
            <path class="probe__needle" d="M0 12 L0 -12 M-5 -6 L0 -13 L5 -6" />
          </svg>
          <div class="probe__values">
            <div class="probe__speed">–</div>
            <div class="probe__dir">–</div>
            <div class="probe__axis">–</div>
          </div>
        </div>
        <canvas class="probe__spark" width="280" height="44"></canvas>`;
      el.querySelector<HTMLButtonElement>('.probe__name')!.textContent = probe.name;
      el.querySelector('.probe__name')!.addEventListener('click', () => this.opts.onFocus(probe));
      el.querySelector('.probe__remove')?.addEventListener('click', () =>
        this.opts.onRemove(probe),
      );
      if (probe.pinned) this.root.prepend(el);
      else this.root.append(el);
      this.rows.set(probe.id, { probe, el, history: [] });
    }
  }

  update(probes: Probe[], samples: FlowSample[]): void {
    probes.forEach((probe, idx) => {
      const row = this.rows.get(probe.id);
      const s = samples[idx];
      if (!row || !s) return;
      const q = (sel: string) => row.el.querySelector<HTMLElement>(sel)!;
      if (!s.wet) {
        q('.probe__speed').textContent = 'op het land';
        q('.probe__dir').textContent = 'kies een punt op het water';
        q('.probe__axis').textContent = '';
        return;
      }
      const cms = s.speedMs * 100;
      q('.probe__speed').textContent = `${cms.toFixed(cms < 10 ? 1 : 0)} cm/s`;
      q('.probe__dir').textContent =
        `naar ${compassLabel(s.directionDeg)} (${s.directionDeg.toFixed(0)}°) · peil ${s.levelNapM.toFixed(3)} m NAP`;
      const along = s.u * this.opts.axis.x + s.v * this.opts.axis.y;
      q('.probe__axis').textContent =
        Math.abs(along) < 0.002
          ? 'vrijwel stilstaand'
          : along > 0
            ? '→ richting Amsterdam-Rijnkanaal'
            : '← richting Vecht';
      q('.probe__axis').dataset.sign = along > 0.002 ? 'ark' : along < -0.002 ? 'vecht' : 'still';
      const needle = row.el.querySelector<SVGElement>('.probe__needle')!;
      needle.setAttribute('transform', `rotate(${s.directionDeg.toFixed(1)})`);
      needle.style.opacity = s.speedMs < 0.001 ? '0.2' : '1';
      row.history.push(along);
      if (row.history.length > HISTORY) row.history.shift();
      drawSpark(row.el.querySelector<HTMLCanvasElement>('.probe__spark')!, row.history);
    });
  }
}

/** Sparkline of the along-channel velocity; above the midline = towards the ARK. */
function drawSpark(canvas: HTMLCanvasElement, values: number[]): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width: w, height: h } = canvas;
  ctx.clearRect(0, 0, w, h);
  const styles = getComputedStyle(canvas);
  const max = Math.max(0.01, ...values.map(Math.abs));
  ctx.strokeStyle = styles.getPropertyValue('--muted') || '#888';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();
  ctx.strokeStyle = styles.getPropertyValue('--accent') || '#2b7bb9';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  values.forEach((val, i) => {
    const x = (i / (HISTORY - 1)) * w;
    const y = h / 2 - (val / max) * (h / 2 - 3);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}
