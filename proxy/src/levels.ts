// Fetches live boundary water levels from upstream government APIs and
// returns them as BoundaryLevels-shaped JSON.
//
// ARK (Amsterdam-Rijnkanaal): Rijkswaterstaat Waterwebservices / DDL,
// `OphalenLaatsteWaarnemingen`, Grootheid WATHTE ("waterhoogte", water
// level), at the location given by env.RWS_ARK_LOCATION_CODE.
//   Docs: https://rijkswaterstaat.github.io/wm-ws-dl/ (classic DDL).
//   The classic DDL host (waterwebservices.rijkswaterstaat.nl) was retired
//   end of April 2026; this calls its successor (ddapi20-...), which keeps
//   the same OphalenLaatsteWaarnemingen POST contract. The successor uses
//   new, lowercase location codes (e.g. "ameland.nes"), so the old DDL code
//   in wrangler.toml must be replaced by the new one for the ARK gauge.
//
// Vecht: HDSR (Hoogheemraadschap De Stichtse Rijnlanden) Lizard open water
// data API, a timeseries `events` lookup by UUID
// (env.HDSR_VECHT_TIMESERIES_UUID).
//   Docs: "Handleiding Open Water Data API van HDSR",
//   https://hdsr.lizard.net.
//
// Both location identifiers are NOT independently verified against the
// live catalogues from the environment this proxy was written in (no
// outbound network beyond search results) — see wrangler.toml for the
// caveat and how to correct them. When either upstream call fails or the
// identifier is unset, that boundary falls back to FALLBACK_LEVELS below
// (kept in sync by hand with src/levels/levels.ts's DEFAULT_LEVELS; there
// is no shared module between the app and the Worker).
import type { Env } from './env';

/** Keep numerically in sync with src/levels/levels.ts DEFAULT_LEVELS. */
export const FALLBACK_LEVELS = { vechtNapM: -0.4, arkNapM: -0.4 };

const RWS_BASE_URL =
  'https://ddapi20-waterwebservices.rijkswaterstaat.nl/ONLINEWAARNEMINGENSERVICES/OphalenLaatsteWaarnemingen';

interface RwsResponse {
  WaarnemingenLijst?: Array<{
    MetingenLijst?: Array<{
      Tijdstip?: string;
      Meetwaarde?: { Waarde_Numeriek?: number };
    }>;
  }>;
}

async function fetchArkLevelNapM(env: Env): Promise<{ value: number; measuredAt: string } | null> {
  if (!env.RWS_ARK_LOCATION_CODE) return null;
  try {
    const res = await fetch(RWS_BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        AquoPlusWaarnemingMetadataLijst: [{ AquoMetadata: { Grootheid: { Code: 'WATHTE' } } }],
        LocatieLijst: [{ Code: env.RWS_ARK_LOCATION_CODE }],
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as RwsResponse;
    const metingen = body.WaarnemingenLijst?.[0]?.MetingenLijst ?? [];
    const last = metingen[metingen.length - 1];
    const cm = last?.Meetwaarde?.Waarde_Numeriek;
    if (typeof cm !== 'number' || !Number.isFinite(cm)) return null;
    return { value: cm / 100, measuredAt: last?.Tijdstip ?? new Date().toISOString() };
  } catch {
    return null;
  }
}

interface LizardEventsResponse {
  results?: Array<{ time?: string; value?: number }>;
}

async function fetchVechtLevelNapM(
  env: Env,
): Promise<{ value: number; measuredAt: string } | null> {
  if (!env.HDSR_VECHT_TIMESERIES_UUID) return null;
  try {
    const url = `https://hdsr.lizard.net/api/v4/timeseries/${env.HDSR_VECHT_TIMESERIES_UUID}/events/?page_size=1&ordering=-time`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const body = (await res.json()) as LizardEventsResponse;
    const event = body.results?.[0];
    if (!event || typeof event.value !== 'number' || !Number.isFinite(event.value)) return null;
    // Lizard timeseries values here are assumed to already be in m NAP
    // (HDSR's water level timeseries commonly are); adjust if the
    // configured timeseries turns out to use cm.
    return { value: event.value, measuredAt: event.time ?? new Date().toISOString() };
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
