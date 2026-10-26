import { describe, expect, it } from 'vitest';
import { indexAxisRange } from './meters-charts';

describe('indexAxisRange', () => {
  const now = 20_000;

  it('laisse une marge avant un relevé récent au lieu de démarrer sur lui', () => {
    const r = indexAxisRange([now - 1], now - 365, 183, now);
    expect(r.min).toBeLessThan(now - 1);
    expect(r.min).toBe(now - 1 - Math.round((now + 183 - (now - 1)) * 0.04));
    expect(r.max).toBe(now + 183);
  });

  it('ne remonte jamais avant le début de la période choisie', () => {
    const r = indexAxisRange([now - 360, now - 200, now - 1], now - 365, 0, now);
    expect(r.min).toBe(now - 365);
    expect(r.max).toBe(now);
  });

  it('garde au moins deux jours de marge, sans limite quand la période est « Tout »', () => {
    expect(indexAxisRange([now - 3], null, 0, now).min).toBe(now - 5);
    expect(indexAxisRange([now - 900], null, 0, now).min).toBe(now - 900 - 36);
  });

  it('sans relevé dans la période, montre la période entière', () => {
    expect(indexAxisRange([], now - 183, 0, now)).toEqual({ min: now - 183, max: now });
    expect(indexAxisRange([], null, 0, now)).toEqual({ min: now - 30, max: now });
  });
});
