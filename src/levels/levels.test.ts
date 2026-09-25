import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_LEVELS, fetchLevels, parseLevelsResponse } from './levels';

describe('DEFAULT_LEVELS', () => {
  it('provides finite fallback levels for both boundaries', () => {
    expect(Number.isFinite(DEFAULT_LEVELS.vechtNapM)).toBe(true);
    expect(Number.isFinite(DEFAULT_LEVELS.arkNapM)).toBe(true);
  });
});

describe('parseLevelsResponse', () => {
  it('parses a well-formed proxy response', () => {
    const result = parseLevelsResponse({
      levels: { vechtNapM: -0.38, arkNapM: -0.41 },
      source: 'rws+hdsr',
      measuredAt: '2026-09-25T10:00:00Z',
    });
    expect(result).toEqual({
      levels: { vechtNapM: -0.38, arkNapM: -0.41 },
      source: 'rws+hdsr',
      measuredAt: '2026-09-25T10:00:00Z',
    });
  });

  it('rejects missing or non-numeric levels', () => {
    expect(parseLevelsResponse(null)).toBeNull();
    expect(parseLevelsResponse({})).toBeNull();
    expect(parseLevelsResponse({ levels: { vechtNapM: 'nope', arkNapM: -0.4 } })).toBeNull();
    expect(parseLevelsResponse({ levels: { vechtNapM: -0.4 } })).toBeNull();
  });

  it('defaults source/measuredAt when absent', () => {
    const result = parseLevelsResponse({ levels: { vechtNapM: -0.4, arkNapM: -0.4 } });
    expect(result?.source).toBe('unknown');
    expect(typeof result?.measuredAt).toBe('string');
  });
});

describe('fetchLevels', () => {
  it('returns null when no base URL is configured', async () => {
    const result = await fetchLevels({ fetchImpl: vi.fn() as unknown as typeof fetch });
    expect(result).toBeNull();
  });

  it('returns null when the upstream response is not ok', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    const result = await fetchLevels({
      baseUrl: 'https://proxy.example',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toBeNull();
  });

  it('returns null when fetch throws (e.g. network error)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
    const result = await fetchLevels({
      baseUrl: 'https://proxy.example',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toBeNull();
  });

  it('parses a successful response and calls the /levels endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        levels: { vechtNapM: -0.35, arkNapM: -0.42 },
        source: 'test',
        measuredAt: 'now',
      }),
    });
    const result = await fetchLevels({
      baseUrl: 'https://proxy.example',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result?.levels).toEqual({ vechtNapM: -0.35, arkNapM: -0.42 });
    expect(fetchImpl).toHaveBeenCalledWith('https://proxy.example/levels', expect.anything());
  });
});
