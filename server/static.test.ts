import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveStaticPath } from './static.ts';

const root = join('/srv', 'dist');

describe('resolveStaticPath', () => {
  it('maps paths inside the root', () => {
    expect(resolveStaticPath(root, '/assets/index.js?v=1')).toBe(join(root, 'assets/index.js'));
    expect(resolveStaticPath(root, '/')).toBe(join(root, 'index.html'));
  });

  it('rejects paths that escape the root', () => {
    expect(resolveStaticPath(root, '/../etc/passwd')).toBeNull();
    expect(resolveStaticPath(root, '/%2e%2e/%2e%2e/etc/passwd')).toBeNull();
    expect(resolveStaticPath(root, '/..%2fdist-secret/x')).toBeNull();
  });

  it('rejects malformed or NUL-containing paths', () => {
    expect(resolveStaticPath(root, '/%E0%A4%A')).toBeNull();
    expect(resolveStaticPath(root, '/index.html%00.js')).toBeNull();
  });
});
