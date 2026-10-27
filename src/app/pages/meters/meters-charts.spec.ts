import { describe, expect, it } from 'vitest';
import { billingHorizon, indexAxisRange, keepTooltipItem } from './meters-charts';

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

describe('keepTooltipItem', () => {
  it('masque une prévision quand la mesure de la même série est déjà dans l’infobulle', () => {
    const labels = ['Soutirage HP', 'Soutirage HP (prévision)', 'Injection HC (prévision)'];
    expect(keepTooltipItem('Soutirage HP', labels)).toBe(true);
    expect(keepTooltipItem('Soutirage HP (prévision)', labels)).toBe(false);
    // Pas de mesure de cette série à cet endroit : la prévision reste.
    expect(keepTooltipItem('Injection HC (prévision)', labels)).toBe(true);
    expect(keepTooltipItem(undefined, labels)).toBe(true);
  });
});

describe('billingHorizon', () => {
  it('va jusqu’à une facturation qui tombe juste après la période choisie', () => {
    const now = 20_000;
    expect(billingHorizon([now + 5, now + 370], now, 365)).toBe(372);
    expect(billingHorizon([now + 5, now + 400], now, 365)).toBe(365);
    expect(billingHorizon([now + 5], now, 0)).toBe(0);
  });
});
