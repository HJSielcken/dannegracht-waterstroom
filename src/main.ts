import 'leaflet/dist/leaflet.css';
import './style.css';
import L from 'leaflet';
import { AisClient, type AisStatus } from './boats/ais';
import { deadReckon, isUnderway } from './boats/aisMessages';
import { BoatNumbering } from './boats/numbering';
import { SimWaterLock } from './boats/simLock';
import { boatsToSimBoats } from './boats/toSim';
import { VIRTUAL_BOAT_PRESETS, VirtualBoat, type VirtualBoatPresetId } from './boats/virtual';
import { ARK_ROUTE, DANNEGRACHT_ROUTE, fallbackScene } from './geo/fallback';
import { loadSceneFromOsm } from './geo/overpass';
import { projectScene, toLatLon, toMetric } from './geo/project';
import { DEFAULT_LEVELS, fetchLevels } from './levels/levels';
import { KIND_DANNEGRACHT, LAND } from './sim/grid';
import type {
  Boat,
  BoundaryLevels,
  FlowField,
  FlowSample,
  LatLon,
  Probe,
  RiverCurrents,
  Scene,
  SimConfig,
  SimRequest,
  SimResponse,
  Vec2,
} from './types';
import { compassLabel, formatDuration } from './ui/field';
import { FlowLayer, flowLegend } from './ui/flowLayer';
import { ProbePanel } from './ui/probePanel';
import { initSidebarResizer } from './ui/sidebarResizer';
import { ScreenWakeLock } from './ui/wakeLock';

const DEFAULT_CONFIG: SimConfig = { cellSizeM: 3, manningN: 0.03, timeScale: 1 };
/**
 * Typical northward currents: the Vecht carries ~4 m³/s from the Weerdsluis (≈ 5 cm/s over
 * 30 m × 2.5 m), the ARK ~13 m³/s let in at Wijk bij Duurstede and Vreeswijk (≈ 2 cm/s over
 * 115 m × 5.5 m). See README.
 */
const DEFAULT_CURRENTS: RiverCurrents = { vechtMs: 0.05, arkMs: 0.02 };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let scene: Scene = fallbackScene();
let probes: Probe[] = scene.probes.map((p, i) => ({ ...p, label: String(i + 1) }));
let levels: BoundaryLevels = { ...DEFAULT_LEVELS };
let currents: RiverCurrents = { ...DEFAULT_CURRENTS };
let config: SimConfig = { ...DEFAULT_CONFIG };
let running = true;
/** Keeps a phone's screen on while the simulation runs. */
const wakeLock = new ScreenWakeLock();
let lockOpen = true;
let virtualBoats: VirtualBoat[] = [];
let aisBoats: Boat[] = [];
let nextBoatId = 1;
let nextProbeId = 1;
/** Next number shown on a new probe's map marker and panel badge. */
let nextProbeLabel = probes.length + 1;
let sampleRequestId = 0;
/** Simulated time of the latest flow field, used to label the probe history. */
let simTimeS = 0;

const project = (p: { lat: number; lon: number }) => toMetric(p, scene.origin);
const unproject = (v: Vec2) => toLatLon(v, scene.origin);

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

const map = L.map('map', { zoomControl: true, preferCanvas: true }).setView(
  [scene.origin.lat, scene.origin.lon],
  16,
);
const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  opacity: 0.55,
  attribution: '© OpenStreetMap-bijdragers',
}).addTo(map);
const waterLayer = L.layerGroup().addTo(map);
const structureLayer = L.layerGroup().addTo(map);
const probeLayer = L.layerGroup().addTo(map);
const boatLayer = L.layerGroup().addTo(map);
const flowLayer = new FlowLayer({ toLatLon: unproject, toMetric: project }).addTo(map);
flowLegend().addTo(map);
initSidebarResizer($('sidebar-resizer'), () => map.invalidateSize());

/** Zoom to the Dannegracht, where the interesting flow is. */
function fitToGracht(): void {
  const gracht = scene.waterBodies.filter((w) => w.kind === 'dannegracht');
  const pts = gracht.flatMap((w) => w.rings.flat().map((p) => [p.lat, p.lon] as [number, number]));
  if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [40, 40] });
}

function drawScene(): void {
  waterLayer.clearLayers();
  structureLayer.clearLayers();
  const css = getComputedStyle(document.documentElement);
  for (const wb of scene.waterBodies) {
    L.polygon(
      wb.rings.map((r) => r.map((p) => [p.lat, p.lon] as [number, number])),
      {
        color: css.getPropertyValue('--water-edge').trim(),
        fillColor: css.getPropertyValue('--water').trim(),
        fillOpacity: 0.55,
        weight: 1,
        interactive: false,
      },
    ).addTo(waterLayer);
  }
  for (const s of scene.structures) {
    const blocked = s.kind === 'lock' ? !lockOpen : s.blocksFlow;
    L.circleMarker([s.position.lat, s.position.lon], {
      radius: s.kind === 'lock' ? 7 : 4,
      color: blocked ? '#c0392b' : '#555',
      fillOpacity: 0.9,
      weight: 2,
    })
      .bindTooltip(`${s.name}${s.kind === 'lock' ? (lockOpen ? ' (open)' : ' (dicht)') : ''}`)
      .on('click', () => {
        if (s.kind === 'lock') setLockOpen(!lockOpen);
      })
      .addTo(structureLayer);
  }
}

function drawProbes(): void {
  probeLayer.clearLayers();
  for (const probe of probes) {
    L.marker([probe.position.lat, probe.position.lon], {
      icon: L.divIcon({
        className: '',
        html: `<div class="probe-marker">${probe.label ?? ''}</div>`,
        iconSize: [22, 22],
      }),
      draggable: true,
      title: probe.name,
    })
      .on('dragend', (e) => {
        const ll = (e.target as L.Marker).getLatLng();
        probe.position = { lat: ll.lat, lon: ll.lng };
      })
      .addTo(probeLayer);
  }
  panel.setProbes(probes);
}

const boatMarkers = new Map<string, { marker: L.Marker; box: number; label: number }>();
/** Number on each boat's map marker and list row. */
const boatNumbering = new BoatNumbering();
/** Smallest on-screen boat size, so small boats stay visible when zoomed out. */
const MIN_BOAT_PX = 26;

/** Top-view boat outline pointing north; rotated to the course by the caller. */
function boatSvg(b: Boat, lengthPx: number): string {
  const widthPx = Math.max(lengthPx * 0.42, lengthPx * (b.beamM / b.lengthM));
  const hull = b.source === 'ais' ? 'var(--boat-ais)' : 'var(--boat-virtual)';
  return `<svg class="boat-icon__svg" viewBox="0 0 20 48" preserveAspectRatio="none"
      width="${widthPx.toFixed(1)}" height="${lengthPx.toFixed(1)}">
    <path d="M10 1 C16 9 18.5 17 18.5 28 L18.5 43 Q10 47.5 1.5 43 L1.5 28 C1.5 17 4 9 10 1 Z"
      fill="${hull}" stroke="#fff" stroke-width="1.2" />
    <rect x="5.5" y="20" width="9" height="13" rx="2" fill="#fff" opacity="0.85" />
    <path d="M10 5 L10 16" stroke="#fff" stroke-width="1.4" stroke-linecap="round" opacity="0.7" />
  </svg>`;
}

/** Metres per screen pixel at the map centre. */
function metresPerPixel(): number {
  const c = map.getCenter();
  const p = map.latLngToContainerPoint(c);
  return c.distanceTo(map.containerPointToLatLng([p.x + 100, p.y])) / 100;
}

function drawBoats(boats: Boat[]): void {
  const mPerPx = metresPerPixel();
  const seen = new Set<string>();
  const numbers = boatNumbering.assign(boats.map((b) => b.id));
  for (const b of boats) {
    seen.add(b.id);
    const label = numbers.get(b.id)!;
    // True-to-scale when zoomed in, never smaller than MIN_BOAT_PX.
    const lengthPx = Math.max(MIN_BOAT_PX, b.lengthM / mPerPx);
    const box = Math.ceil(lengthPx * 1.1);
    const makeIcon = () =>
      L.divIcon({
        className: 'boat-icon',
        html: `<div class="boat-icon__rot">${boatSvg(b, lengthPx)}</div>
          <div class="boat-icon__label boat-badge--${b.source}">${label}</div>`,
        iconSize: [box, box],
        iconAnchor: [box / 2, box / 2],
      });
    const pos: L.LatLngExpression = [b.position.lat, b.position.lon];
    let entry = boatMarkers.get(b.id);
    if (!entry) {
      const marker = L.marker(pos, { icon: makeIcon(), keyboard: false, zIndexOffset: 1000 })
        .bindTooltip('', { direction: 'top' })
        .addTo(boatLayer);
      entry = { marker, box, label };
      boatMarkers.set(b.id, entry);
    } else {
      entry.marker.setLatLng(pos);
      // Rebuild the icon only when its on-screen size (zoom) or number changes.
      if (entry.box !== box || entry.label !== label) {
        entry.marker.setIcon(makeIcon());
        entry.box = box;
        entry.label = label;
      }
    }
    const marker = entry.marker;
    const rot = marker.getElement()?.querySelector<HTMLElement>('.boat-icon__rot');
    if (rot) rot.style.transform = `rotate(${b.courseDeg.toFixed(1)}deg)`;
    marker.setTooltipContent(boatLabel(b, label));
  }
  for (const [id, { marker }] of boatMarkers) {
    if (seen.has(id)) continue;
    marker.remove();
    boatMarkers.delete(id);
  }

  const list = $<HTMLUListElement>('boat-list');
  list.innerHTML = '';
  for (const b of [...boats].sort((x, y) => numbers.get(x.id)! - numbers.get(y.id)!)) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="boat-badge"></span><span class="boats__name"></span><span></span>`;
    li.children[0]!.textContent = String(numbers.get(b.id));
    li.children[0]!.classList.add(`boat-badge--${b.source}`);
    li.children[1]!.textContent = `${b.source === 'ais' ? 'AIS' : 'virtueel'} · ${b.name ?? b.id}`;
    li.children[2]!.textContent = `${(b.massKg / 1000).toFixed(1)} t · ${b.displacementM3.toFixed(1)} m³ · ${(b.speedMs * 3.6).toFixed(1)} km/u`;
    list.append(li);
  }
}

function boatLabel(b: Boat, label: number): string {
  return [
    `${label}. ${b.name ?? b.id}`,
    `${b.lengthM.toFixed(1)} × ${b.beamM.toFixed(1)} m, diepgang ${b.draughtM.toFixed(1)} m`,
    `waterverplaatsing ≈ ${b.displacementM3.toFixed(1)} m³, massa ≈ ${(b.massKg / 1000).toFixed(1)} t`,
    `${(b.speedMs * 3.6).toFixed(1)} km/u, koers ${b.courseDeg.toFixed(0)}°`,
  ].join('<br>');
}

// ---------------------------------------------------------------------------
// Point inspector: click anywhere on the map to read the water speed there
// ---------------------------------------------------------------------------

/** Coordinate clicked on the map; sampled together with the probes while its popup is open. */
let inspectPoint: LatLon | null = null;
const inspectPopup = L.popup({ className: 'inspect-popup', autoPan: false, maxWidth: 260 });
inspectPopup.on('remove', () => {
  inspectPoint = null;
});

function inspectHtml(pos: LatLon, sample: FlowSample | null): string {
  const coord = `${pos.lat.toFixed(6)}, ${pos.lon.toFixed(6)}`;
  let body: string;
  if (!sample) {
    body = '<div class="inspect__speed">…</div>';
  } else if (!sample.wet) {
    body = '<div class="inspect__speed inspect__speed--dry">Geen water op dit punt</div>';
  } else {
    body = `
      <div class="inspect__speed">${(sample.speedMs * 100).toFixed(1)} cm/s</div>
      <div class="inspect__detail">
        richting ${compassLabel(sample.directionDeg)} (${sample.directionDeg.toFixed(0)}°)<br>
        ${(sample.speedMs * 3.6).toFixed(2)} km/u · diepte ${sample.depthM.toFixed(2)} m
      </div>`;
  }
  return `
    <div class="inspect">
      <div class="inspect__coord">${coord}</div>
      ${body}
      <button class="inspect__add" type="button">Als meetpunt volgen</button>
    </div>`;
}

function renderInspect(sample: FlowSample | null): void {
  if (!inspectPoint) return;
  inspectPopup.setContent(inspectHtml(inspectPoint, sample));
  const pos = inspectPoint;
  inspectPopup
    .getElement()
    ?.querySelector('.inspect__add')
    ?.addEventListener('click', () => {
      probes.push({
        id: `probe-${nextProbeId++}`,
        name: `${pos.lat.toFixed(5)}, ${pos.lon.toFixed(5)}`,
        position: pos,
        label: String(nextProbeLabel++),
      });
      drawProbes();
      map.closePopup(inspectPopup);
    });
}

map.on('click', (e: L.LeafletMouseEvent) => {
  inspectPoint = { lat: e.latlng.lat, lon: e.latlng.lng };
  inspectPopup.setLatLng(e.latlng).openOn(map);
  renderInspect(null);
});

// ---------------------------------------------------------------------------
// Probe panel
// ---------------------------------------------------------------------------

/** Unit vector along the Dannegracht from the Vecht mouth to the ARK mouth. */
function channelAxis(): Vec2 {
  const byId = (id: string) => scene.probes.find((p) => p.id === id)?.position;
  const a = byId('dannegracht-vecht-mouth');
  const b = byId('dannegracht-ark-mouth');
  if (!a || !b) return { x: -1, y: 0 };
  const pa = project(a);
  const pb = project(b);
  const len = Math.hypot(pb.x - pa.x, pb.y - pa.y) || 1;
  return { x: (pb.x - pa.x) / len, y: (pb.y - pa.y) / len };
}

/** Route used by virtual boats: the ARK (north first) or the Dannegracht (Vecht side first). */
function channelRoute(waterway: string) {
  const route = waterway === 'danne' ? DANNEGRACHT_ROUTE : ARK_ROUTE;
  return route.map((p) => ({ ...p }));
}

const panel = new ProbePanel($('probes'), {
  axis: channelAxis(),
  onFocus: (p) => map.panTo([p.position.lat, p.position.lon]),
  onRemove: (p) => {
    probes = probes.filter((q) => q.id !== p.id);
    drawProbes();
  },
});

// ---------------------------------------------------------------------------
// Simulation worker
// ---------------------------------------------------------------------------

let worker: Worker | null = null;
const status = $('status');

function send(msg: SimRequest): void {
  worker?.postMessage(msg);
}

function sceneForSim(): Scene {
  return {
    ...scene,
    structures: scene.structures.map((s) =>
      s.kind === 'lock' ? { ...s, blocksFlow: !lockOpen } : s,
    ),
  };
}

function startWorker(): void {
  worker?.terminate();
  worker = new Worker(new URL('./sim/worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<SimResponse>) => {
    const msg = e.data;
    switch (msg.type) {
      case 'ready':
        gridKind = msg.kind;
        gridGeometry = null;
        defaultsSnapped = false;
        status.textContent = `Geometrie: ${scene.source === 'osm' ? 'OpenStreetMap' : 'ingebouwde schets'} · rooster ${msg.nx} × ${msg.ny} cellen van ${config.cellSizeM} m`;
        send({ type: 'run', running });
        break;
      case 'field':
        gridGeometry = msg.field;
        flowLayer.setField(msg.field);
        snapProbes(msg.field);
        simTimeS = msg.field.timeS;
        $('sim-time').textContent = `Gesimuleerde tijd: ${formatDuration(msg.field.timeS)}`;
        break;
      case 'samples':
        if (msg.requestId === pendingSample?.id) {
          const n = pendingSample.probes.length;
          panel.update(pendingSample.probes, msg.samples.slice(0, n), simTimeS);
          if (inspectPoint === pendingSample.inspect) renderInspect(msg.samples[n] ?? null);
          pendingSample = null;
        }
        break;
      case 'error':
        status.textContent = `Fout in simulatie: ${msg.message}`;
        break;
    }
  };
  worker.onerror = (e) => {
    status.textContent = `Fout in simulatie: ${e.message}`;
  };
  send({ type: 'init', scene: projectScene(sceneForSim()), config, levels, currents });
}

/** Water body kind per grid cell of the current simulation (from the worker's 'ready'). */
let gridKind: Int8Array | null = null;
/** Grid size and placement of the current simulation (from its latest 'field'). */
let gridGeometry: Pick<FlowField, 'nx' | 'ny' | 'cellSizeM' | 'originX' | 'originY'> | null = null;
let defaultsSnapped = false;
/** Default probes that must measure the gracht itself, not the Vecht or the ARK. */
const GRACHT_PROBE_IDS = new Set(scene.probes.map((p) => p.id));

/** Nearest wet Dannegracht cell centre within maxM of `a`, or null. */
function nearestGrachtCell(field: FlowField, a: Vec2, maxM: number): { p: Vec2; d: number } | null {
  if (!gridKind || gridKind.length !== field.nx * field.ny) return null;
  let best: { p: Vec2; d: number } | null = null;
  for (let j = 0; j < field.ny; j++) {
    for (let i = 0; i < field.nx; i++) {
      const c = j * field.nx + i;
      if (!field.wet[c] || gridKind[c] !== KIND_DANNEGRACHT) continue;
      const x = field.originX + (i + 0.5) * field.cellSizeM;
      const y = field.originY + (j + 0.5) * field.cellSizeM;
      const d = Math.hypot(x - a.x, y - a.y);
      if (d < maxM && (!best || d < best.d)) best = { p: { x, y }, d };
    }
  }
  return best;
}

/**
 * Keep the default probes on the gracht: they move to the nearest Dannegracht cell when they
 * fall on land or in a river (e.g. with live OSM geometry, which differs from the fallback
 * sketch). Only Dannegracht cells count, so a probe near the Vecht does not end up measuring it.
 */
function snapProbes(field: FlowField): void {
  if (!gridKind) return;
  let moved = false;
  if (!defaultsSnapped) {
    defaultsSnapped = true;
    for (const probe of probes) {
      if (!GRACHT_PROBE_IDS.has(probe.id)) continue;
      const hit = nearestGrachtCell(field, project(probe.position), 150);
      if (hit && hit.d > 0.75 * field.cellSizeM) {
        probe.position = unproject(hit.p);
        moved = true;
      }
    }
  }
  if (moved) drawProbes();
}

let pendingSample: { id: number; probes: Probe[]; inspect: LatLon | null } | null = null;
setInterval(() => {
  if (!worker || pendingSample) return;
  const snapshot = probes.slice();
  const inspect = inspectPoint;
  pendingSample = { id: ++sampleRequestId, probes: snapshot, inspect };
  const points = snapshot.map((p) => project(p.position));
  if (inspect) points.push(project(inspect));
  send({ type: 'sample', requestId: pendingSample.id, points });
  // Drop a request that never got an answer (e.g. worker restarted).
  const id = pendingSample.id;
  setTimeout(() => {
    if (pendingSample?.id === id) pendingSample = null;
  }, 2000);
}, 250);

// ---------------------------------------------------------------------------
// Boats
// ---------------------------------------------------------------------------

/** AIS boats in simulated water are moved by the sim clock instead of by AIS (see simLock.ts). */
const aisLock = new SimWaterLock();

/** Whether `p` lies on a water cell of the running simulation's grid. */
function inSimWater(p: LatLon): boolean {
  const g = gridGeometry;
  if (!gridKind || !g || gridKind.length !== g.nx * g.ny) return false;
  const v = project(p);
  const i = Math.floor((v.x - g.originX) / g.cellSizeM);
  const j = Math.floor((v.y - g.originY) / g.cellSizeM);
  if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) return false;
  return gridKind[j * g.nx + i] !== LAND;
}

/**
 * Simulated time the boats were last advanced to. Virtual and locked AIS boats run on the
 * simulation's clock, not the wall clock: in a hidden tab the browser throttles or freezes this
 * page (on Android the worker too), and a wall-clock step on return would move them far ahead of
 * the simulated water, or out of it. On the sim clock they pick up where the sim is.
 */
let lastBoatSimS = 0;
setInterval(() => {
  // A restarted worker starts again at 0 s; don't move boats backwards.
  const dt = Math.max(0, simTimeS - lastBoatSimS);
  lastBoatSimS = simTimeS;
  for (const vb of virtualBoats) vb.advance(dt);
  aisLock.advance(dt);
  const wallNow = Date.now();
  const virtual = virtualBoats.map((vb) => vb.toBoat(wallNow));
  // Moored boats are left out: on the map they only clutter the gracht and the list.
  const ais = aisLock.apply(
    aisBoats.filter(isUnderway).map((b) => deadReckon(b, wallNow)),
    inSimWater,
    wallNow,
  );
  send({ type: 'setBoats', boats: boatsToSimBoats([...virtual, ...ais.sim], project) });
  drawBoats([...virtual, ...ais.shown]);
}, 100);

const presetSelect = $<HTMLSelectElement>('boat-preset');
for (const preset of Object.values(VIRTUAL_BOAT_PRESETS)) {
  const opt = document.createElement('option');
  opt.value = preset.id;
  opt.textContent = `${preset.label} (${preset.lengthM} m)`;
  presetSelect.append(opt);
}
const boatSpeed = $<HTMLInputElement>('boat-speed');
const boatSpeedOut = $<HTMLOutputElement>('boat-speed-out');
const updateBoatSpeed = () => {
  boatSpeedOut.textContent = `${(Number(boatSpeed.value) * 3.6).toFixed(1)} km/u`;
};
boatSpeed.addEventListener('input', updateBoatSpeed);
presetSelect.addEventListener('change', () => {
  const preset = VIRTUAL_BOAT_PRESETS[presetSelect.value as VirtualBoatPresetId];
  boatSpeed.value = String(preset.defaultSpeedMs);
  updateBoatSpeed();
});
presetSelect.dispatchEvent(new Event('change'));

$('boat-launch').addEventListener('click', () => {
  const [waterway, direction] = $<HTMLSelectElement>('boat-route').value.split(':');
  const route = channelRoute(waterway!);
  if (route.length < 2) return;
  if (direction === 'reverse') route.reverse();
  virtualBoats.push(
    new VirtualBoat({
      id: `virtual-${nextBoatId++}`,
      preset: presetSelect.value as VirtualBoatPresetId,
      path: route,
      speedMs: Number(boatSpeed.value),
      mode: 'stop',
    }),
  );
});
$('boat-clear').addEventListener('click', () => {
  virtualBoats = [];
});

const ais = new AisClient();
const aisLabels: Record<AisStatus, string> = {
  disabled: 'Live AIS staat uit (geen proxy ingesteld, zie README).',
  connecting: 'Verbinden met live AIS…',
  open: 'Live AIS verbonden.',
  reconnecting: 'Live AIS: opnieuw verbinden…',
  closed: 'Live AIS gesloten.',
};
ais.subscribeStatus((s) => {
  $('ais-status').textContent = aisLabels[s];
});
ais.subscribe((boats) => {
  aisBoats = boats;
});
ais.start();

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

const vechtInput = $<HTMLInputElement>('level-vecht');
const arkInput = $<HTMLInputElement>('level-ark');

function renderLevels(): void {
  vechtInput.value = String(levels.vechtNapM);
  arkInput.value = String(levels.arkNapM);
  $('level-vecht-out').textContent = levels.vechtNapM.toFixed(3);
  $('level-ark-out').textContent = levels.arkNapM.toFixed(3);
}

function setLevels(next: BoundaryLevels, source: string): void {
  levels = next;
  renderLevels();
  $('levels-source').textContent = source;
  send({ type: 'setLevels', levels });
}

const onLevelInput = () =>
  setLevels(
    { vechtNapM: Number(vechtInput.value), arkNapM: Number(arkInput.value) },
    'Handmatig ingesteld.',
  );
vechtInput.addEventListener('input', onLevelInput);
arkInput.addEventListener('input', onLevelInput);
$('levels-swap').addEventListener('click', () =>
  setLevels({ vechtNapM: levels.arkNapM, arkNapM: levels.vechtNapM }, 'Omgedraaid.'),
);
$('levels-live').addEventListener('click', async () => {
  $('levels-source').textContent = 'Live peilen ophalen…';
  const live = await fetchLevels();
  if (live) setLevels(live.levels, `Bron: ${live.source} (${live.measuredAt}).`);
  else
    $('levels-source').textContent =
      'Live peilen niet beschikbaar (proxy niet ingesteld of niet bereikbaar).';
});

const currentVecht = $<HTMLInputElement>('current-vecht');
const currentArk = $<HTMLInputElement>('current-ark');
function renderCurrents(): void {
  currentVecht.value = String(currents.vechtMs * 100);
  currentArk.value = String(currents.arkMs * 100);
  $('current-vecht-out').textContent = (currents.vechtMs * 100).toFixed(1);
  $('current-ark-out').textContent = (currents.arkMs * 100).toFixed(1);
}
const onCurrentInput = () => {
  currents = { vechtMs: Number(currentVecht.value) / 100, arkMs: Number(currentArk.value) / 100 };
  renderCurrents();
  send({ type: 'setCurrents', currents });
};
currentVecht.addEventListener('input', onCurrentInput);
currentArk.addEventListener('input', onCurrentInput);

$('run').addEventListener('click', () => {
  running = !running;
  $('run').textContent = running ? 'Pauze' : 'Start';
  send({ type: 'run', running });
  wakeLock.set(running);
});
const timeScale = $<HTMLInputElement>('time-scale');
const updateTimeScale = () => {
  config = { ...config, timeScale: Number(timeScale.value) };
  $('time-scale-out').textContent = `${config.timeScale}×`;
  send({ type: 'setConfig', config: { timeScale: config.timeScale } });
};
timeScale.addEventListener('input', updateTimeScale);
$<HTMLInputElement>('show-arrows').addEventListener('change', (e) => {
  flowLayer.showArrows = (e.target as HTMLInputElement).checked;
});
$<HTMLInputElement>('show-particles').addEventListener('change', (e) => {
  flowLayer.showParticles = (e.target as HTMLInputElement).checked;
});
$<HTMLInputElement>('show-tiles').addEventListener('change', (e) => {
  if ((e.target as HTMLInputElement).checked) tiles.addTo(map);
  else tiles.remove();
});

const lockToggle = $<HTMLInputElement>('lock-open');
function setLockOpen(open: boolean): void {
  lockOpen = open;
  lockToggle.checked = open;
  drawScene();
  startWorker();
}
lockToggle.addEventListener('change', () => setLockOpen(lockToggle.checked));

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function init(): Promise<void> {
  renderLevels();
  renderCurrents();
  updateTimeScale();
  lockToggle.checked = lockOpen;
  wakeLock.set(running);
  drawScene();
  fitToGracht();
  drawProbes();
  startWorker();

  // Upgrade to live OSM geometry when reachable; keep the fallback otherwise.
  try {
    const osm = await loadSceneFromOsm(AbortSignal.timeout(20000));
    if (osm.waterBodies.some((w) => w.kind === 'dannegracht')) {
      scene = osm;
      drawScene();
      startWorker();
    }
  } catch {
    // Fallback scene stays active; the status line already says so.
  }
}

void init();
