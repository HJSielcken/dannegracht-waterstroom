import type { FlowSample, Probe, Vec2 } from '../types';
import { compassLabel, formatDuration } from './field';

export interface ProbePanelOptions {
  /** Unit vector along the Dannegracht pointing from the Vecht towards the ARK (metric frame). */
  axis: Vec2;
  onFocus: (probe: Probe) => void;
  onRemove: (probe: Probe) => void;
}

interface HistoryPoint {
  /** Velocity along the gracht axis in m/s; positive = towards the ARK. */
  along: number;
  speedMs: number;
  simTimeS: number;
  wallTime: Date;
}

interface Row {
  probe: Probe;
  el: HTMLElement;
  history: HistoryPoint[];
  /** History index under the mouse, or null when not hovering the sparkline. */
  hover: number | null;
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
      el.className = 'probe';
      el.innerHTML = `
        <header>
          <span class="probe__badge probe-marker" aria-hidden="true"></span>
          <button class="probe__name" type="button"></button>
          <button class="probe__remove" type="button" aria-label="Verwijder meetpunt">×</button>
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
        <div class="probe__chart">
          <canvas class="probe__spark"></canvas>
          <div class="probe__tip" hidden></div>
        </div>`;
      el.querySelector<HTMLElement>('.probe__badge')!.textContent = probe.label ?? '';
      el.querySelector<HTMLButtonElement>('.probe__name')!.textContent = probe.name;
      el.querySelector('.probe__name')!.addEventListener('click', () => this.opts.onFocus(probe));
      el.querySelector('.probe__remove')?.addEventListener('click', () =>
        this.opts.onRemove(probe),
      );
      this.root.append(el);
      const row: Row = { probe, el, history: [], hover: null };
      this.rows.set(probe.id, row);
      const canvas = el.querySelector<HTMLCanvasElement>('.probe__spark')!;
      canvas.addEventListener('pointermove', (e) => {
        const rect = canvas.getBoundingClientRect();
        const idx = Math.round(((e.clientX - rect.left) / rect.width) * (HISTORY - 1));
        row.hover = Math.min(Math.max(idx, 0), HISTORY - 1);
        renderChart(row);
      });
      canvas.addEventListener('pointerleave', () => {
        row.hover = null;
        renderChart(row);
      });
    }
  }

  rename(probe: Probe): void {
    const btn = this.rows.get(probe.id)?.el.querySelector('.probe__name');
    if (btn) btn.textContent = probe.name;
  }

  update(probes: Probe[], samples: FlowSample[], simTimeS: number): void {
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
      row.history.push({ along, speedMs: s.speedMs, simTimeS, wallTime: new Date() });
      if (row.history.length > HISTORY) row.history.shift();
      renderChart(row);
    });
  }
}

/** Redraw the sparkline and, when hovering, the tooltip for the point under the mouse. */
function renderChart(row: Row): void {
  const canvas = row.el.querySelector<HTMLCanvasElement>('.probe__spark')!;
  const tip = row.el.querySelector<HTMLElement>('.probe__tip')!;
  // Snap to the newest point while the history does not yet span the full width.
  const idx = row.hover === null ? null : Math.min(row.hover, row.history.length - 1);
  const point = idx !== null && idx >= 0 ? row.history[idx] : undefined;
  drawSpark(canvas, row.history, point ? idx : null);
  if (!point) {
    tip.hidden = true;
    return;
  }
  const cms = point.speedMs * 100;
  const dir = Math.abs(point.along) < 0.002 ? 'stil' : point.along > 0 ? '→ ARK' : '← Vecht';
  tip.textContent = `${cms.toFixed(cms < 10 ? 1 : 0)} cm/s ${dir} · ${point.wallTime.toLocaleTimeString('nl-NL')} (sim ${formatDuration(point.simTimeS)})`;
  tip.hidden = false;
  const w = canvas.clientWidth;
  const x = ((idx ?? 0) / (HISTORY - 1)) * w;
  const half = tip.offsetWidth / 2;
  tip.style.left = `${Math.min(Math.max(x, half), w - half)}px`;
}

/** Sparkline of the along-channel velocity; above the midline = towards the ARK. */
function drawSpark(canvas: HTMLCanvasElement, points: HistoryPoint[], hover: number | null): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  // Match the backing store to the displayed size so the line stays crisp at any sidebar width.
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const values = points.map((p) => p.along);
  const styles = getComputedStyle(canvas);
  const muted = styles.getPropertyValue('--muted') || '#888';
  const accent = styles.getPropertyValue('--accent') || '#2b7bb9';
  const max = Math.max(0.01, ...values.map(Math.abs));
  const xAt = (i: number) => (i / (HISTORY - 1)) * w;
  const yAt = (val: number) => h / 2 - (val / max) * (h / 2 - 3);
  ctx.strokeStyle = muted;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  values.forEach((val, i) => {
    if (i === 0) ctx.moveTo(xAt(i), yAt(val));
    else ctx.lineTo(xAt(i), yAt(val));
  });
  ctx.stroke();
  if (hover === null || hover >= values.length) return;
  const x = xAt(hover);
  ctx.strokeStyle = muted;
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 2]);
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, h);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(x, yAt(values[hover]!), 3, 0, Math.PI * 2);
  ctx.fill();
}
