// Local tangent-plane projection between WGS84 (LatLon) and the metric frame (Vec2)
// used by the simulation grid. Equirectangular projection around `origin` is accurate
// to well under a metre over the ~1-2 km extent of this scene, which is more than
// sufficient here.

import type { LatLon, MetricScene, MetricStructure, MetricWaterBody, Scene, Vec2 } from '../types';

/** Metres per degree of latitude (approximately constant everywhere on Earth). */
const METRES_PER_DEG_LAT = 111_320;

function metresPerDegLon(latDeg: number): number {
  return METRES_PER_DEG_LAT * Math.cos((latDeg * Math.PI) / 180);
}

/** Projects a WGS84 point onto the local metric tangent plane around `origin`. */
export function toMetric(p: LatLon, origin: LatLon): Vec2 {
  const x = (p.lon - origin.lon) * metresPerDegLon(origin.lat);
  const y = (p.lat - origin.lat) * METRES_PER_DEG_LAT;
  return { x, y };
}

/** Inverse of {@link toMetric}: recovers a WGS84 point from a local metric coordinate. */
export function toLatLon(v: Vec2, origin: LatLon): LatLon {
  const lon = origin.lon + v.x / metresPerDegLon(origin.lat);
  const lat = origin.lat + v.y / METRES_PER_DEG_LAT;
  return { lat, lon };
}

function projectRings(rings: LatLon[][], origin: LatLon): Vec2[][] {
  return rings.map((ring) => ring.map((p) => toMetric(p, origin)));
}

function projectWaterBody(body: Scene['waterBodies'][number], origin: LatLon): MetricWaterBody {
  return {
    id: body.id,
    kind: body.kind,
    rings: projectRings(body.rings, origin),
    depthM: body.depthM,
  };
}

function projectStructure(structure: Scene['structures'][number], origin: LatLon): MetricStructure {
  return {
    id: structure.id,
    kind: structure.kind,
    position: toMetric(structure.position, origin),
    blocksFlow: structure.blocksFlow,
    ...(structure.openFraction !== undefined ? { openFraction: structure.openFraction } : {}),
  };
}

/** Projects a full `Scene` into the metric frame the simulator works in. */
export function projectScene(scene: Scene): MetricScene {
  const { origin } = scene;
  return {
    waterBodies: scene.waterBodies.map((b) => projectWaterBody(b, origin)),
    structures: scene.structures.map((s) => projectStructure(s, origin)),
  };
}
