import { describe, expect, it } from 'vitest';
import { Rng } from '../src/index.js';

describe('Rng', () => {
  it('is reproducible from its seed', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    const xs = Array.from({ length: 100 }, () => a.next());
    const ys = Array.from({ length: 100 }, () => b.next());
    expect(xs).toEqual(ys);
  });

  it('gives different sequences for different seeds', () => {
    expect(new Rng(1).next()).not.toEqual(new Rng(2).next());
  });

  it('keeps int() within bounds, inclusive', () => {
    const r = new Rng(7);
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      const v = r.int(3, 6);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(6);
      seen.add(v);
    }
    expect([...seen].sort()).toEqual([3, 4, 5, 6]);
  });

  it('shuffles without losing items', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(new Rng(3).shuffle([...items]).sort()).toEqual(items);
  });
});
