import L from 'leaflet';
import type { FlowField, LatLon, Vec2 } from '../types';
import { cellCentre, speedColour, velocityAt } from './field';

export interface FlowLayerOptions {
  toLatLon: (v: Vec2) => LatLon;
  toMetric: (p: LatLon) => Vec2;
  /** Speed (m/s) mapped to the top of the colour ramp. */
  maxSpeed?: number;
}

interface Particle {
  p: Vec2;
  age: number;
  trail: Vec2[];
}

const ARROW_SPACING_PX = 26;
const PARTICLE_COUNT = 900;
const PARTICLE_LIFE = 160;
const TRAIL_LENGTH = 10;

/**
 * Canvas overlay that draws the flow field as arrows and animated tracer particles.
 * Particles move with the local velocity, exaggerated so slow canal flow is still visible.
 */
export class FlowLayer extends L.Layer {
  private canvas = document.createElement('canvas');
  private field: FlowField | null = null;
  private wetCells: number[] = [];
  private particles: Particle[] = [];
  private frame = 0;
  private lastTs = 0;
  showArrows = true;
  showParticles = true;
  /** Visual speed-up of particles relative to the real flow velocity. */
  particleSpeedup = 40;

  constructor(private opts: FlowLayerOptions) {
    super();
    this.canvas.className = 'flow-canvas';
  }

  override onAdd(map: L.Map): this {
    map.getPanes().overlayPane.appendChild(this.canvas);
    map.on('moveend zoomend resize', this.reset, this);
    map.on('zoomstart', this.hide, this);
    this.reset();
    this.frame = requestAnimationFrame(this.tick);
    return this;
  }

  override onRemove(map: L.Map): this {
    cancelAnimationFrame(this.frame);
    map.off('moveend zoomend resize', this.reset, this);
    map.off('zoomstart', this.hide, this);
    this.canvas.remove();
    return this;
  }

  setField(field: FlowField): void {
    const layoutChanged = !this.field || this.field.nx !== field.nx || this.field.ny !== field.ny;
    this.field = field;
    if (layoutChanged) {
      this.wetCells = [];
      for (let k = 0; k < field.wet.length; k++) if (field.wet[k]) this.wetCells.push(k);
      this.particles = [];
    }
  }

  private get maxSpeed(): number {
    return this.opts.maxSpeed ?? 0.3;
  }

  private hide = (): void => {
    this.canvas.style.visibility = 'hidden';
  };

  private reset = (): void => {
    const map = this._map;
    if (!map) return;
    const size = map.getSize();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = size.x * dpr;
    this.canvas.height = size.y * dpr;
    this.canvas.style.width = `${size.x}px`;
    this.canvas.style.height = `${size.y}px`;
    L.DomUtil.setPosition(this.canvas, map.containerPointToLayerPoint([0, 0]));
    this.canvas.style.visibility = 'visible';
    for (const pt of this.particles) pt.trail = [];
  };

  private toPx(v: Vec2): L.Point {
    const ll = this.opts.toLatLon(v);
    return this._map.latLngToContainerPoint([ll.lat, ll.lon]);
  }

  private spawn(): Particle | null {
    const field = this.field;
    if (!field || this.wetCells.length === 0) return null;
    const k = this.wetCells[Math.floor(Math.random() * this.wetCells.length)] ?? 0;
    const c = cellCentre(field, k % field.nx, Math.floor(k / field.nx));
    const jitter = () => (Math.random() - 0.5) * field.cellSizeM;
    return {
      p: { x: c.x + jitter(), y: c.y + jitter() },
      age: Math.floor(Math.random() * PARTICLE_LIFE),
      trail: [],
    };
  }

  private tick = (ts: number): void => {
    this.frame = requestAnimationFrame(this.tick);
    const dt = Math.min(0.05, (ts - this.lastTs) / 1000 || 0);
    this.lastTs = ts;
    const map = this._map;
    const field = this.field;
    const ctx = this.canvas.getContext('2d');
    if (!map || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!field) return;
    if (this.showArrows) this.drawArrows(ctx, field);
    if (this.showParticles) this.drawParticles(ctx, field, dt);
  };

  private drawArrows(ctx: CanvasRenderingContext2D, field: FlowField): void {
    const map = this._map;
    // Metres per pixel at the current zoom, measured at the map centre.
    const c = map.getCenter();
    const p0 = map.latLngToContainerPoint(c);
    const mPerPx = c.distanceTo(map.containerPointToLatLng([p0.x + 100, p0.y])) / 100;
    const stride = Math.max(1, Math.round((ARROW_SPACING_PX * mPerPx) / field.cellSizeM));
    const size = map.getSize();
    ctx.lineWidth = 1.5;
    for (let j = Math.floor(stride / 2); j < field.ny; j += stride) {
      for (let i = Math.floor(stride / 2); i < field.nx; i += stride) {
        const k = j * field.nx + i;
        if (!field.wet[k]) continue;
        const u = field.u[k] ?? 0;
        const v = field.v[k] ?? 0;
        const speed = Math.hypot(u, v);
        if (speed < 1e-4) continue;
        const px = this.toPx(cellCentre(field, i, j));
        if (px.x < -20 || px.y < -20 || px.x > size.x + 20 || px.y > size.y + 20) continue;
        // Arrow length grows with speed but stays readable: 6..22 px.
        const len = 6 + 16 * Math.min(1, speed / this.maxSpeed);
        // Screen y points down, metric y points north.
        const dx = (u / speed) * len;
        const dy = (-v / speed) * len;
        drawArrow(ctx, px.x - dx / 2, px.y - dy / 2, dx, dy, speedColour(speed, this.maxSpeed));
      }
    }
  }

  private drawParticles(ctx: CanvasRenderingContext2D, field: FlowField, dt: number): void {
    while (this.particles.length < PARTICLE_COUNT) {
      const p = this.spawn();
      if (!p) break;
      this.particles.push(p);
    }
    ctx.lineWidth = 1.2;
    for (let n = 0; n < this.particles.length; n++) {
      const pt = this.particles[n]!;
      const vel = velocityAt(field, pt.p);
      pt.age++;
      if (!vel || pt.age > PARTICLE_LIFE) {
        const fresh = this.spawn();
        if (fresh) {
          fresh.age = 0;
          this.particles[n] = fresh;
        }
        continue;
      }
      pt.p = {
        x: pt.p.x + vel.x * dt * this.particleSpeedup,
        y: pt.p.y + vel.y * dt * this.particleSpeedup,
      };
      pt.trail.push(pt.p);
      if (pt.trail.length > TRAIL_LENGTH) pt.trail.shift();
      if (pt.trail.length < 2) continue;
      const speed = Math.hypot(vel.x, vel.y);
      ctx.strokeStyle = speedColour(speed, this.maxSpeed);
      ctx.globalAlpha = 0.75 * Math.min(1, (PARTICLE_LIFE - pt.age) / 30);
      ctx.beginPath();
      pt.trail.forEach((q, idx) => {
        const s = this.toPx(q);
        if (idx === 0) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
      });
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  dx: number,
  dy: number,
  colour: string,
): void {
  const len = Math.hypot(dx, dy);
  const head = Math.min(6, len * 0.45);
  const ux = dx / len;
  const uy = dy / len;
  const tx = x + dx;
  const ty = y + dy;
  ctx.strokeStyle = colour;
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(tx - ux * head * 0.6, ty - uy * head * 0.6);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(tx, ty);
  ctx.lineTo(tx - ux * head - uy * head * 0.5, ty - uy * head + ux * head * 0.5);
  ctx.lineTo(tx - ux * head + uy * head * 0.5, ty - uy * head - ux * head * 0.5);
  ctx.closePath();
  ctx.fill();
}
