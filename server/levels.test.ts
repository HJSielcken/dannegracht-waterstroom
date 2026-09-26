import { describe, expect, it } from 'vitest';
import { pickLizardLevel, pickRwsLevel } from './levels.ts';

describe('pickRwsLevel', () => {
  it('takes the newest measurement, not the first series or last array entry', () => {
    const body = {
      WaarnemingenLijst: [
        {
          AquoMetadata: { ProcesType: 'verwachting', Hoedanigheid: { Code: 'NAP' } },
          MetingenLijst: [
            { Tijdstip: '2026-09-26T12:00:00.000+01:00', Meetwaarde: { Waarde_Numeriek: 10 } },
          ],
        },
        {
          AquoMetadata: { ProcesType: 'meting', Hoedanigheid: { Code: 'NAP' } },
          MetingenLijst: [
            { Tijdstip: '2026-09-26T11:10:00.000+01:00', Meetwaarde: { Waarde_Numeriek: -41 } },
            { Tijdstip: '2026-09-26T11:00:00.000+01:00', Meetwaarde: { Waarde_Numeriek: -39 } },
          ],
        },
      ],
    };
    expect(pickRwsLevel(body)).toEqual({
      value: -0.41,
      measuredAt: '2026-09-26T11:10:00.000+01:00',
    });
  });

  it('skips other reference levels and missing-value markers', () => {
    const body = {
      WaarnemingenLijst: [
        {
          AquoMetadata: { ProcesType: 'meting', Hoedanigheid: { Code: 'MSL' } },
          MetingenLijst: [
            { Tijdstip: '2026-09-26T11:00:00Z', Meetwaarde: { Waarde_Numeriek: -38 } },
          ],
        },
        {
          AquoMetadata: { ProcesType: 'meting', Hoedanigheid: { Code: 'NAP' } },
          MetingenLijst: [
            { Tijdstip: '2026-09-26T11:00:00Z', Meetwaarde: { Waarde_Numeriek: 999999999 } },
          ],
        },
      ],
    };
    expect(pickRwsLevel(body)).toBeNull();
  });
});

describe('pickLizardLevel', () => {
  it('takes the newest event whatever order Lizard returns', () => {
    const body = {
      results: [
        { time: '2026-09-26T10:00:00Z', value: -0.38 },
        { time: '2026-09-26T11:00:00Z', value: -0.42 },
        { time: '2026-09-26T10:30:00Z', value: -0.4 },
      ],
    };
    expect(pickLizardLevel(body)).toEqual({ value: -0.42, measuredAt: '2026-09-26T11:00:00Z' });
  });

  it('ignores empty and implausible values', () => {
    const body = {
      results: [
        { time: '2026-09-26T11:00:00Z', value: null },
        { time: '2026-09-26T11:05:00Z', value: -40 },
      ],
    };
    expect(pickLizardLevel(body)).toBeNull();
  });
});
