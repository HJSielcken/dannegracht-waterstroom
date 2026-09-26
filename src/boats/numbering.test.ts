import { describe, expect, it } from 'vitest';
import { BoatNumbering } from './numbering';

describe('BoatNumbering', () => {
  it('numbers boats from 1 and keeps a number while the boat stays', () => {
    const n = new BoatNumbering();
    expect([...n.assign(['a', 'b']).entries()]).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
    expect(n.assign(['b', 'a']).get('a')).toBe(1);
  });

  it('gives a new boat the lowest number freed by a boat that left', () => {
    const n = new BoatNumbering();
    n.assign(['a', 'b', 'c']);
    const next = n.assign(['a', 'c', 'd']);
    expect(next.get('c')).toBe(3);
    expect(next.get('d')).toBe(2);
    expect(next.has('b')).toBe(false);
  });
});
