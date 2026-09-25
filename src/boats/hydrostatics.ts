// Rough hydrostatic estimates for boats seen on the Dannegracht.
//
// We only ever have AIS-grade inputs (overall length, beam, and — often —
// no usable draught), so this is deliberately a simple box-with-a-fudge-factor
// model, not naval architecture:
//
//   displacement (m^3) = L x B x T x Cb
//   mass (kg)           = displacement (m^3) x rho (kg/m^3)
//
// where Cb ("block coefficient") is the fraction of the L x B x T bounding
// box that the underwater hull actually fills. Cb = 1 would be a rectangular
// barge; real hulls are always less full because bows and sterns taper.
//
// rho is fresh water density. The Vecht/ARK/Dannegracht system is fresh
// water, so we use 1000 kg/m^3 rather than the ~1025 kg/m^3 used for
// seawater estimates.
export const FRESH_WATER_DENSITY_KG_M3 = 1000;

/**
 * AIS "Type" is the ITU-R M.1371 "Type of ship and cargo" code (0-99),
 * exposed by aisstream.io as `ShipStaticData.Type` / `StaticDataReport...Type`.
 * See https://api.vtexplorer.com/docs/ref-aistypes.html for the standard
 * ranges; the ranges below group the codes we expect to see on Dutch inland
 * waterways.
 */
export type AisShipTypeCode = number;

/** Named hull-form buckets we bucket AIS type codes into. */
export type HullClass =
  'inland-cargo-tanker' | 'passenger' | 'pleasure-sailing' | 'tug' | 'unknown';

/**
 * Block coefficient (Cb) per hull class. These are deliberately broad
 * "textbook" ranges for inland/small craft (there is no authoritative public
 * table specific to Dutch pleasure/inland shipping); we use the midpoint of
 * each requested range. Treat these as coarse simulation inputs, not
 * naval-architecture-grade figures.
 */
export const BLOCK_COEFFICIENT_BY_HULL_CLASS: Record<HullClass, number> = {
  // Flat-bottomed inland barges/tankers: very full hulls.
  'inland-cargo-tanker': 0.875, // midpoint of ~0.85-0.9
  // Passenger/rondvaart boats: fuller than a yacht, less full than a barge.
  passenger: 0.6,
  // Pleasure craft, sloops and sailing yachts: fine, tapered hulls.
  'pleasure-sailing': 0.45, // midpoint of ~0.4-0.5
  // Tugs: compact, moderately full hulls built for bollard pull, not volume.
  tug: 0.55,
  // Anything we can't classify from the AIS type code.
  unknown: 0.7,
};

/**
 * Classify an AIS "Type of ship and cargo" code into a hull class.
 * Ranges follow the ITU-R M.1371 table:
 *  - 20-29 wing-in-ground, 30 fishing, 31-32 towing, 33 dredging,
 *    34 diving, 35 military, 36 sailing, 37 pleasure craft
 *  - 40-49 high-speed craft (treated as pleasure/passenger-like, fine hulls)
 *  - 50 pilot, 51 SAR, 52 tug, 53 port tender, 54 anti-pollution,
 *    55 law enforcement, 58 medical
 *  - 60-69 passenger
 *  - 70-79 cargo, 80-89 tanker (includes most Dutch inland cargo/tank barges)
 *  - 90-99 other
 */
export function classifyHull(code: AisShipTypeCode | undefined): HullClass {
  if (code === undefined || !Number.isFinite(code)) return 'unknown';
  const t = Math.trunc(code);
  if (t === 36 || t === 37) return 'pleasure-sailing';
  if (t === 52) return 'tug';
  if (t >= 60 && t <= 69) return 'passenger';
  if (t >= 70 && t <= 89) return 'inland-cargo-tanker';
  if (t >= 40 && t <= 49) return 'pleasure-sailing';
  return 'unknown';
}

export function blockCoefficientForType(code: AisShipTypeCode | undefined): number {
  return BLOCK_COEFFICIENT_BY_HULL_CLASS[classifyHull(code)];
}

/**
 * Default draught (metres) to assume when AIS static draught is missing or
 * zero — which is extremely common: many vessels never set it, and 0 is the
 * AIS "not available" sentinel for MaximumStaticDraught.
 *
 * These are rough rules of thumb by hull class and overall length, not
 * measured values:
 *  - Dutch inland cargo/tank vessels: draught scales roughly with length,
 *    from ~1.5 m for small barges up to ~3.5 m for the largest (110 m+)
 *    "Va"-class ships on the ARK.
 *  - Passenger/rondvaart boats: shallow draught, typically 1-1.5 m.
 *  - Pleasure/sailing craft: 0.6-2 m depending on size (motor boats shallow,
 *    sailing yachts with a keel deeper); we use length as a rough proxy.
 *  - Tugs: compact but deep-ish for their length, ~2 m typical on inland
 *    waters.
 */
export function defaultDraughtM(lengthM: number, code: AisShipTypeCode | undefined): number {
  const hull = classifyHull(code);
  const length = Number.isFinite(lengthM) && lengthM > 0 ? lengthM : 0;
  switch (hull) {
    case 'inland-cargo-tanker': {
      // ~1.5 m at 20 m LOA up to ~3.5 m at 135 m LOA (Va-class), clamped.
      const t = clamp((length - 20) / (135 - 20), 0, 1);
      return 1.5 + t * (3.5 - 1.5);
    }
    case 'passenger':
      return length >= 20 ? 1.5 : 1.1;
    case 'tug':
      return 2.0;
    case 'pleasure-sailing':
      // Small sloep ~0.5 m, larger motor yacht/sailing yacht up to ~1.8 m.
      return clamp(0.4 + length * 0.08, 0.4, 1.8);
    case 'unknown':
    default:
      return clamp(0.5 + length * 0.02, 0.5, 2.5);
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export interface HydrostaticsInput {
  lengthM: number;
  beamM: number;
  /**
   * AIS static draught in metres, as reported (MaximumStaticDraught).
   * Pass `undefined` or `0` when unavailable — AIS uses 0 as the
   * "not available" sentinel, and we treat it the same as missing.
   */
  draughtM?: number;
  /** AIS "Type of ship and cargo" code (0-99), when known. */
  shipTypeCode?: AisShipTypeCode;
}

export interface HydrostaticsEstimate {
  /** Draught used for the estimate (reported, or a per-type default). */
  draughtM: number;
  /** Block coefficient used for the estimate. */
  blockCoefficient: number;
  /** Estimated displaced volume, m^3. */
  displacementM3: number;
  /** Estimated mass, kg (displacement x fresh water density). */
  massKg: number;
}

/**
 * Estimate displaced volume and mass from AIS-grade dimensions.
 *
 * displacement = L x B x T x Cb; mass = displacement x rho(fresh water).
 */
export function estimateHydrostatics(input: HydrostaticsInput): HydrostaticsEstimate {
  const lengthM = Number.isFinite(input.lengthM) && input.lengthM > 0 ? input.lengthM : 0;
  const beamM = Number.isFinite(input.beamM) && input.beamM > 0 ? input.beamM : 0;
  const blockCoefficient = blockCoefficientForType(input.shipTypeCode);
  const reportedDraught =
    input.draughtM !== undefined && Number.isFinite(input.draughtM) && input.draughtM > 0
      ? input.draughtM
      : undefined;
  const draughtM = reportedDraught ?? defaultDraughtM(lengthM, input.shipTypeCode);

  const displacementM3 = lengthM * beamM * draughtM * blockCoefficient;
  const massKg = displacementM3 * FRESH_WATER_DENSITY_KG_M3;

  return { draughtM, blockCoefficient, displacementM3, massKg };
}
