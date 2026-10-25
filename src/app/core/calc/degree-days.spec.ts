import { seasonalWeightBetween, UCCLE_DEGREE_DAYS_YEAR } from './degree-days';
import { toDayNumber } from './time';

describe('degree-days', () => {
  it('total annuel des normales', () => {
    expect(UCCLE_DEGREE_DAYS_YEAR).toBeCloseTo(1953.1, 1);
  });

  it('les poids saisonniers d’une année valent ~1', () => {
    const w = seasonalWeightBetween(toDayNumber('2025-01-01'), toDayNumber('2026-01-01'), 0.7);
    expect(w).toBeCloseTo(1, 2);
  });
});
