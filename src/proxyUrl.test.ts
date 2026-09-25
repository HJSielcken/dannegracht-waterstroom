import { describe, expect, it } from 'vitest';
import { aisSocketUrl, proxyHttpBase } from './proxyUrl';

describe('aisSocketUrl', () => {
  it('keeps an absolute proxy URL', () => {
    expect(aisSocketUrl('wss://proxy.example/ais')).toBe('wss://proxy.example/ais');
  });

  it('resolves a path against the page, matching its scheme', () => {
    expect(aisSocketUrl('/ais', 'http://nas.local:8533/')).toBe('ws://nas.local:8533/ais');
    expect(aisSocketUrl('/ais', 'https://water.example/app/')).toBe('wss://water.example/ais');
  });

  it('returns null for a path without a page to resolve against', () => {
    expect(aisSocketUrl('/ais', undefined)).toBeNull();
  });
});

describe('proxyHttpBase', () => {
  it('maps an absolute WebSocket URL to its http base', () => {
    expect(proxyHttpBase('wss://proxy.example/ais')).toBe('https://proxy.example');
    expect(proxyHttpBase('ws://localhost:8787/ais/')).toBe('http://localhost:8787');
  });

  it('resolves a path to the page origin', () => {
    expect(proxyHttpBase('/ais', 'http://nas.local:8533/')).toBe('http://nas.local:8533');
  });
});
