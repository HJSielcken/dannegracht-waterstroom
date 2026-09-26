// Fetches live boundary water levels from upstream government APIs and
// returns them as BoundaryLevels-shaped JSON.
//
// ARK (Amsterdam-Rijnkanaal): Rijkswaterstaat Waterwebservices / DDL,
// `OphalenLaatsteWaarnemingen`, Grootheid WATHTE ("waterhoogte", water
// level) in m NAP, measured rather than forecast, at the location given by
// env.RWS_ARK_LOCATION_CODE.
//   Docs: https://rijkswaterstaat.github.io/wm-ws-dl/ (classic DDL).
//   The classic DDL host (waterwebservices.rijkswaterstaat.nl) was retired
//   end of April 2026; this calls its successor (ddapi20-...), which keeps
//   the OphalenLaatsteWaarnemingen endpoint but takes lists
//   (LocatieLijst, AquoPlusWaarnemingMetadataLijst) and new, lowercase
//   location codes (e.g. "maarssen.kanaal").
//
// Vecht: HDSR (Hoogheemraadschap De Stichtse Rijnlanden) Lizard open water
// data API, the newest event of the last few hours of the timeseries
// env.HDSR_VECHT_TIMESERIES_UUID.
//   Docs: "Handleiding Open Water Data API van HDSR",
//   https://hdsr.lizard.net.
//
// When either upstream call fails, returns no plausible level (outside
// NAP -3..+3 m) or the identifier is unset, that boundary
// falls back to FALLBACK_LEVELS below (kept in sync by hand with
// src/levels/levels.ts's DEFAULT_LEVELS).
import type { Env } from './env.ts';

/** Keep numerically in sync with src/levels/levels.ts DEFAULT_LEVELS. */
export const FALLBACK_LEVELS = { vechtNapM: -0.4, arkNapM: -0.4 };

const RWS_BASE_URL =
  'https://ddapi20-waterwebservices.rijkswaterstaat.nl/ONLINEWAARNEMINGENSERVICES/OphalenLaatsteWaarnemingen';

interface RwsResponse {
  WaarnemingenLijst?: Array<{
    AquoMetadata?: {
      ProcesType?: string;
      Hoedanigheid?: { Code?: string };
    };
    MetingenLijst?: Array<{
      Tijdstip?: string;
      Meetwaarde?: { Waarde_Numeriek?: number };
    }>;
  }>;
}

/** A level outside this band (m NAP) is a unit mix-up or a sensor fault, not the ARK or Vecht. */
const PLAUSIBLE_NAP_M = { min: -3, max: 3 };

function plausibleNapM(value: number): boolean {
  return Number.isFinite(value) && value >= PLAUSIBLE_NAP_M.min && value <= PLAUSIBLE_NAP_M.max;
}

/**
 * Picks the newest measured (not forecast) water level in m NAP from an
 * OphalenLaatsteWaarnemingen response. A location can return several
 * WATHTE series (measurement and forecast, or other reference levels), so
 * series that say they are something else are skipped rather than taking
 * the first one. Exported for testing.
 */
export function pickRwsLevel(body: RwsResponse): { value: number; measuredAt: string } | null {
  let best: { value: number; measuredAt: string; t: number } | null = null;
  for (const reeks of body.WaarnemingenLijst ?? []) {
    const meta = reeks.AquoMetadata;
    if (meta?.ProcesType && meta.ProcesType.toLowerCase() !== 'meting') continue;
    const hoedanigheid = meta?.Hoedanigheid?.Code;
    if (hoedanigheid && hoedanigheid.toUpperCase() !== 'NAP') continue;
    for (const meting of reeks.MetingenLijst ?? []) {
      const cm = meting.Meetwaarde?.Waarde_Numeriek;
      const t = Date.parse(meting.Tijdstip ?? '');
      if (typeof cm !== 'number' || !Number.isFinite(t)) continue;
      // RWS WATHTE is in cm; 999999999 marks a missing value.
      const value = cm / 100;
      if (!plausibleNapM(value)) continue;
      if (!best || t > best.t) best = { value, measuredAt: meting.Tijdstip!, t };
    }
  }
  return best ? { value: best.value, measuredAt: best.measuredAt } : null;
}

async function fetchArkLevelNapM(env: Env): Promise<{ value: number; measuredAt: string } | null> {
  if (!env.RWS_ARK_LOCATION_CODE) return null;
  try {
    const res = await fetch(RWS_BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        AquoPlusWaarnemingMetadataLijst: [
          {
            AquoMetadata: {
              Compartiment: { Code: 'OW' },
              Grootheid: { Code: 'WATHTE' },
              Hoedanigheid: { Code: 'NAP' },
            },
          },
        ],
        LocatieLijst: [{ Code: env.RWS_ARK_LOCATION_CODE }],
      }),
    });
    if (!res.ok) return null;
    return pickRwsLevel((await res.json()) as RwsResponse);
  } catch {
    return null;
  }
}

interface LizardEventsResponse {
  results?: Array<{ time?: string; value?: number | null }>;
}

/**
 * How far back to ask Lizard for events. Short enough that one page holds
 * them all (the gauge reports every few minutes); a gauge silent for longer
 * falls back to streefpeil rather than showing a stale level.
 */
const LIZARD_LOOKBACK_MS = 6 * 60 * 60 * 1000;

/**
 * Picks the newest event from a Lizard events page by its timestamp, so the
 * result does not depend on the order Lizard returns events in. Exported for
 * testing.
 */
export function pickLizardLevel(
  body: LizardEventsResponse,
): { value: number; measuredAt: string } | null {
  let best: { value: number; measuredAt: string; t: number } | null = null;
  for (const event of body.results ?? []) {
    const t = Date.parse(event.time ?? '');
    const value = event.value;
    // Lizard values for this timeseries are m NAP; a value outside the
    // plausible band means a different unit or a bad reading.
    if (typeof value !== 'number' || !Number.isFinite(t) || !plausibleNapM(value)) continue;
    if (!best || t > best.t) best = { value, measuredAt: event.time!, t };
  }
  return best ? { value: best.value, measuredAt: best.measuredAt } : null;
}

async function fetchVechtLevelNapM(
  env: Env,
): Promise<{ value: number; measuredAt: string } | null> {
  if (!env.HDSR_VECHT_TIMESERIES_UUID) return null;
  try {
    const start = new Date(Date.now() - LIZARD_LOOKBACK_MS).toISOString();
    const params = new URLSearchParams({ start, page_size: '1000' });
    const url = `https://hdsr.lizard.net/api/v4/timeseries/${env.HDSR_VECHT_TIMESERIES_UUID}/events/?${params}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    return pickLizardLevel((await res.json()) as LizardEventsResponse);
  } catch {
    return null;
  }
}

export interface LevelsPayload {
  levels: { vechtNapM: number; arkNapM: number };
  source: string;
  measuredAt: string;
}

export async function fetchLevelsPayload(env: Env): Promise<LevelsPayload> {
  const [ark, vecht] = await Promise.all([fetchArkLevelNapM(env), fetchVechtLevelNapM(env)]);

  const sources: string[] = [];
  let arkNapM: number;
  if (ark) {
    sources.push('rws');
    arkNapM = ark.value;
  } else {
    sources.push('ark-fallback');
    arkNapM = FALLBACK_LEVELS.arkNapM;
  }
  let vechtNapM: number;
  if (vecht) {
    sources.push('hdsr');
    vechtNapM = vecht.value;
  } else {
    sources.push('vecht-fallback');
    vechtNapM = FALLBACK_LEVELS.vechtNapM;
  }

  const measuredAt = ark?.measuredAt ?? vecht?.measuredAt ?? new Date().toISOString();

  return {
    levels: { vechtNapM, arkNapM },
    source: sources.join('+'),
    measuredAt,
  };
}
