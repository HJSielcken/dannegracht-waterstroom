import 'leaflet/dist/leaflet.css';
import './style.css';
import L from 'leaflet';
import { AisClient, type AisStatus } from './boats/ais';
import { boatsToSimBoats } from './boats/toSim';
import { VIRTUAL_BOAT_PRESETS, VirtualBoat, type VirtualBoatPresetId } from './boats/virtual';
import { fallbackScene } from './geo/fallback';
import { geocode } from './geo/geocode';
import { loadSceneFromOsm } from './geo/overpass';
import { projectScene, toLatLon, toMetric } from './geo/project';
import { DEFAULT_LEVELS, fetchLevels } from './levels/levels';
import type {
  Boat,
  BoundaryLevels,
  FlowField,
  Probe,
  Scene,
  SimConfig,
  SimRequest,
  SimResponse,
  Vec2,
} from './types';
import { FlowLayer } from './ui/flowLayer';
import { ProbePanel } from './ui/probePanel';

const DEFAULT_CONFIG: SimConfig = { cellSizeM: 3, manningN: 0.03, timeScale: 1 };
const PINNED_PROBE_ID = 'brugstraat-10e';
/** Geocoded probe positions further than this from the scene origin are rejected as wrong hits. */
const MAX_GEOCODE_DISTANCE_M = 1500;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let scene: Scene = fallbackScene();
let probes: Probe[] = scene.probes.map((p) => ({ ...p }));
let levels: BoundaryLevels = { ...DEFAULT_LEVELS };
let config: SimConfig = { ...DEFAULT_CONFIG };
let running = true;
let lockOpen = true;
let virtualBoats: VirtualBoat[] = [];
let aisBoats: Boat[] = [];
let nextBoatId = 1;
let nextProbeId = 1;
let sampleRequestId = 0;

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
        html: `<div class="probe-marker${probe.pinned ? ' probe-marker--pinned' : ''}"></div>`,
        iconSize: probe.pinned ? [18, 18] : [14, 14],
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

const boatMarkers = new Map<string, { marker: L.Marker; box: number }>();
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
  for (const b of boats) {
    seen.add(b.id);
    // True-to-scale when zoomed in, never smaller than MIN_BOAT_PX.
    const lengthPx = Math.max(MIN_BOAT_PX, b.lengthM / mPerPx);
    const box = Math.ceil(lengthPx * 1.1);
    const makeIcon = () =>
      L.divIcon({
        className: 'boat-icon',
        html: `<div class="boat-icon__rot">${boatSvg(b, lengthPx)}</div>`,
        iconSize: [box, box],
        iconAnchor: [box / 2, box / 2],
      });
    const pos: L.LatLngExpression = [b.position.lat, b.position.lon];
    let entry = boatMarkers.get(b.id);
    if (!entry) {
      const marker = L.marker(pos, { icon: makeIcon(), keyboard: false, zIndexOffset: 1000 })
        .bindTooltip('', { direction: 'top' })
        .addTo(boatLayer);
      entry = { marker, box };
      boatMarkers.set(b.id, entry);
    } else {
      entry.marker.setLatLng(pos);
      // Rebuild the icon only when its on-screen size changes (zoom), not on every tick.
      if (entry.box !== box) {
        entry.marker.setIcon(makeIcon());
        entry.box = box;
      }
    }
    const marker = entry.marker;
    const rot = marker.getElement()?.querySelector<HTMLElement>('.boat-icon__rot');
    if (rot) rot.style.transform = `rotate(${b.courseDeg.toFixed(1)}deg)`;
    marker.setTooltipContent(boatLabel(b));
  }
  for (const [id, { marker }] of boatMarkers) {
    if (seen.has(id)) continue;
    marker.remove();
    boatMarkers.delete(id);
  }

  const list = $<HTMLUListElement>('boat-list');
  list.innerHTML = '';
  for (const b of boats) {
    const li = document.createElement('li');
    li.innerHTML = `<span></span><span></span>`;
    li.children[0]!.textContent = `${b.source === 'ais' ? 'AIS' : 'virtueel'} · ${b.name ?? b.id}`;
    li.children[1]!.textContent = `${(b.massKg / 1000).toFixed(1)} t · ${b.displacementM3.toFixed(1)} m³ · ${(b.speedMs * 3.6).toFixed(1)} km/u`;
    list.append(li);
  }
}

function boatLabel(b: Boat): string {
  return [
    b.name ?? b.id,
    `${b.lengthM.toFixed(1)} × ${b.beamM.toFixed(1)} m, diepgang ${b.draughtM.toFixed(1)} m`,
    `waterverplaatsing ≈ ${b.displacementM3.toFixed(1)} m³, massa ≈ ${(b.massKg / 1000).toFixed(1)} t`,
    `${(b.speedMs * 3.6).toFixed(1)} km/u, koers ${b.courseDeg.toFixed(0)}°`,
  ].join('<br>');
}

map.on('click', (e: L.LeafletMouseEvent) => {
  probes.push({
    id: `probe-${nextProbeId++}`,
    name: `Meetpunt ${nextProbeId - 1}`,
    position: { lat: e.latlng.lat, lon: e.latlng.lng },
  });
  drawProbes();
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

/** Route through the Dannegracht used by virtual boats, Vecht side first. */
function channelRoute() {
  return ['dannegracht-vecht-mouth', 'dannegracht-midway', 'dannegracht-ark-mouth']
    .map((id) => scene.probes.find((p) => p.id === id)?.position)
    .filter((p): p is { lat: number; lon: number } => !!p);
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
        status.textContent = `Geometrie: ${scene.source === 'osm' ? 'OpenStreetMap' : 'ingebouwde schets'} · rooster ${msg.nx} × ${msg.ny} cellen van ${config.cellSizeM} m`;
        send({ type: 'run', running });
        break;
      case 'field':
        flowLayer.setField(msg.field);
        snapPinnedProbe(msg.field);
        $('sim-time').textContent = `Gesimuleerde tijd: ${formatDuration(msg.field.timeS)}`;
        break;
      case 'samples':
        if (msg.requestId === pendingSample?.id) {
          panel.update(pendingSample.probes, msg.samples);
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
  send({ type: 'init', scene: projectScene(sceneForSim()), config, levels });
}

/** Address of the pinned probe; the probe itself sits on the nearest water. */
let pinnedAddress = probes.find((p) => p.id === PINNED_PROBE_ID)?.position ?? null;
let pinnedSnapped = false;

/** Move the pinned probe from the (on-land) address to the nearest wet cell. */
function snapPinnedProbe(field: FlowField): void {
  const pinned = probes.find((p) => p.id === PINNED_PROBE_ID);
  if (pinnedSnapped || !pinned || !pinnedAddress) return;
  pinnedSnapped = true;
  const a = project(pinnedAddress);
  let best: Vec2 | null = null;
  let bestD = 80; // metres; beyond this the address is not really at the gracht
  for (let j = 0; j < field.ny; j++) {
    for (let i = 0; i < field.nx; i++) {
      if (!field.wet[j * field.nx + i]) continue;
      const x = field.originX + (i + 0.5) * field.cellSizeM;
      const y = field.originY + (j + 0.5) * field.cellSizeM;
      const d = Math.hypot(x - a.x, y - a.y);
      if (d < bestD) {
        bestD = d;
        best = { x, y };
      }
    }
  }
  if (!best) return;
  pinned.position = unproject(best);
  pinned.name = `Brugstraat 10e (water op ${bestD.toFixed(0)} m)`;
  panel.rename(pinned);
  drawProbes();
}

let pendingSample: { id: number; probes: Probe[] } | null = null;
setInterval(() => {
  if (!worker || pendingSample) return;
  const snapshot = probes.slice();
  pendingSample = { id: ++sampleRequestId, probes: snapshot };
  send({
    type: 'sample',
    requestId: pendingSample.id,
    points: snapshot.map((p) => project(p.position)),
  });
  // Drop a request that never got an answer (e.g. worker restarted).
  const id = pendingSample.id;
  setTimeout(() => {
    if (pendingSample?.id === id) pendingSample = null;
  }, 2000);
}, 250);

function formatDuration(s: number): string {
  const m = Math.floor(s / 60);
  return m > 0 ? `${m} min ${Math.floor(s % 60)} s` : `${s.toFixed(0)} s`;
}

// ---------------------------------------------------------------------------
// Boats
// ---------------------------------------------------------------------------

let lastBoatTick = performance.now();
setInterval(() => {
  const now = performance.now();
  const dt = ((now - lastBoatTick) / 1000) * (running ? config.timeScale : 0);
  lastBoatTick = now;
  for (const vb of virtualBoats) vb.advance(dt);
  const boats = [...virtualBoats.map((vb) => vb.toBoat(Date.now())), ...aisBoats];
  send({ type: 'setBoats', boats: boatsToSimBoats(boats, project) });
  drawBoats(boats);
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
  const route = channelRoute();
  if (route.length < 2) return;
  if ($<HTMLSelectElement>('boat-route').value === 'a2v') route.reverse();
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
  else $('levels-source').textContent = 'Live peilen niet beschikbaar (geen proxy ingesteld).';
});

$('run').addEventListener('click', () => {
  running = !running;
  $('run').textContent = running ? 'Pauze' : 'Start';
  send({ type: 'run', running });
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

$<HTMLFormElement>('geocode-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const query = $<HTMLInputElement>('geocode-input').value.trim();
  if (!query) return;
  const hit = await geocode(query.includes('Breukelen') ? query : `${query} Breukelen`);
  if (!hit) {
    status.textContent = `Adres "${query}" niet gevonden.`;
    return;
  }
  probes.push({ id: `probe-${nextProbeId++}`, name: query, position: hit });
  drawProbes();
  map.panTo([hit.lat, hit.lon]);
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function init(): Promise<void> {
  renderLevels();
  updateTimeScale();
  lockToggle.checked = lockOpen;
  drawScene();
  fitToGracht();
  drawProbes();
  startWorker();

  // Upgrade to live OSM geometry when reachable; keep the fallback otherwise.
  try {
    const osm = await loadSceneFromOsm(AbortSignal.timeout(20000));
    if (osm.waterBodies.some((w) => w.kind === 'dannegracht')) {
      scene = osm;
      pinnedSnapped = false;
      drawScene();
      startWorker();
    }
  } catch {
    // Fallback scene stays active; the status line already says so.
  }

  // Place the pinned probe on the real address.
  const hit = await geocode('Brugstraat 10e, Breukelen').catch(() => null);
  if (hit) {
    const d = Math.hypot(project(hit).x, project(hit).y);
    const pinned = probes.find((p) => p.id === PINNED_PROBE_ID);
    if (pinned && d < MAX_GEOCODE_DISTANCE_M) {
      pinnedAddress = hit;
      pinnedSnapped = false;
    }
  }
}

void init();
