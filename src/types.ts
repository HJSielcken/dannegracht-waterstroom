// Shared contracts between the geo, sim, boats and ui modules.
// Keep this file free of runtime code so every module can import it cheaply.

/** WGS84 coordinate. */
export interface LatLon {
  lat: number;
  lon: number;
}

/** Local metric coordinate on a tangent plane around `Scene.origin`: x = east, y = north (metres). */
export interface Vec2 {
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// Geo
// ---------------------------------------------------------------------------

export type WaterBodyKind = 'vecht' | 'ark' | 'dannegracht' | 'other';

export interface WaterBody {
  id: string;
  kind: WaterBodyKind;
  name: string;
  /** Polygon rings: first is the outer ring, the rest are holes. Rings are not closed (first != last). */
  rings: LatLon[][];
  /** Assumed mean water depth in metres; used to derive the bed level. */
  depthM: number;
}

export type StructureKind = 'lock' | 'weir' | 'culvert' | 'bridge';

export interface Structure {
  id: string;
  kind: StructureKind;
  name: string;
  position: LatLon;
  /** True when the structure (in its current state) blocks through-flow, e.g. a closed lock. */
  blocksFlow: boolean;
  /** For bridges/culverts: fraction of the channel cross-section that stays open (0..1). */
  openFraction?: number;
}

/** A named measuring point the user can inspect. */
export interface Probe {
  id: string;
  name: string;
  position: LatLon;
  /** The default probe (Brugstraat 10e) is pinned and cannot be removed. */
  pinned?: boolean;
}

export interface Scene {
  /** Origin of the local metric frame. */
  origin: LatLon;
  waterBodies: WaterBody[];
  structures: Structure[];
  probes: Probe[];
  /** Where the geometry came from. */
  source: 'osm' | 'fallback';
}

/** Scene projected into the local metric frame, ready for rasterisation. */
export interface MetricWaterBody {
  id: string;
  kind: WaterBodyKind;
  rings: Vec2[][];
  depthM: number;
}

export interface MetricStructure {
  id: string;
  kind: StructureKind;
  position: Vec2;
  blocksFlow: boolean;
  openFraction?: number;
}

export interface MetricScene {
  waterBodies: MetricWaterBody[];
  structures: MetricStructure[];
}

// ---------------------------------------------------------------------------
// Boats
// ---------------------------------------------------------------------------

export interface Boat {
  id: string;
  name?: string;
  source: 'ais' | 'virtual';
  position: LatLon;
  /** Course over ground, degrees clockwise from north. */
  courseDeg: number;
  /** Speed through water in m/s. */
  speedMs: number;
  lengthM: number;
  beamM: number;
  draughtM: number;
  /** Estimated displaced volume in m^3 (L x B x T x Cb). */
  displacementM3: number;
  /** Estimated mass in kg (displacement x water density). */
  massKg: number;
  /** Epoch ms of the last position update. */
  updatedAt: number;
}

/** Boat as seen by the solver (metric frame). */
export interface SimBoat {
  id: string;
  position: Vec2;
  /** Velocity in m/s, metric frame. */
  velocity: Vec2;
  lengthM: number;
  beamM: number;
  draughtM: number;
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

/** Water levels in metres relative to NAP at the two ends of the Dannegracht. */
export interface BoundaryLevels {
  vechtNapM: number;
  arkNapM: number;
}

export interface SimConfig {
  /** Grid cell size in metres. */
  cellSizeM: number;
  /** Manning roughness coefficient (s/m^(1/3)). */
  manningN: number;
  /** Physical seconds simulated per real second (1 = real time). */
  timeScale: number;
}

/** Depth-averaged flow at a point. */
export interface FlowSample {
  /** Velocity in m/s, metric frame (x = east, y = north). */
  u: number;
  v: number;
  /** Speed in m/s. */
  speedMs: number;
  /** Direction the water flows TO, degrees clockwise from north. */
  directionDeg: number;
  /** Water surface level in m NAP. */
  levelNapM: number;
  /** Water depth in metres. */
  depthM: number;
  /** False when the point is on land. */
  wet: boolean;
}

/** Snapshot of the full velocity field for rendering. Arrays are row-major, row 0 = south edge. */
export interface FlowField {
  nx: number;
  ny: number;
  cellSizeM: number;
  /** Metric coordinate of the south-west corner of cell (0,0). */
  originX: number;
  originY: number;
  u: Float32Array;
  v: Float32Array;
  /** Water surface level (m NAP). */
  eta: Float32Array;
  /** 1 = wet cell, 0 = land. */
  wet: Uint8Array;
  /** Simulated time in seconds. */
  timeS: number;
}

// Worker protocol (main thread <-> src/sim/worker.ts).

export type SimRequest =
  | { type: 'init'; scene: MetricScene; config: SimConfig; levels: BoundaryLevels }
  | { type: 'setLevels'; levels: BoundaryLevels }
  | { type: 'setConfig'; config: Partial<SimConfig> }
  | { type: 'setBoats'; boats: SimBoat[] }
  | { type: 'run'; running: boolean }
  | { type: 'sample'; requestId: number; points: Vec2[] };

export type SimResponse =
  | {
      type: 'ready';
      nx: number;
      ny: number;
      /** Water body kind code per cell (see KIND_CODES in src/sim/grid.ts), -1 = land. */
      kind: Int8Array;
    }
  | { type: 'field'; field: FlowField }
  | { type: 'samples'; requestId: number; samples: FlowSample[] }
  | { type: 'error'; message: string };
