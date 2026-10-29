import { describe, expect, it } from 'vitest';
import { chartColors } from '../../shared/chart/chart-colors';
import { dayCurveChart } from './production-charts';

describe('dayCurveChart', () => {
  const day = new Date(2026, 9, 28).getTime();
  const colors = chartColors('light');

  it('va de 6 h à 22 h', () => {
    const x = dayCurveChart([{ at: day + 9 * 3_600_000, powerW: 1200 }], day, day + 9 * 3_600_000)(colors).options!
      .scales!['x']!;
    expect(x.min).toBe(new Date(2026, 9, 28, 6).getTime());
    expect(x.max).toBe(new Date(2026, 9, 28, 22).getTime());
  });

  it('s’étend jusqu’à maintenant passé 22 h', () => {
    const late = new Date(2026, 9, 28, 23, 10).getTime();
    expect(dayCurveChart([], day, late)(colors).options!.scales!['x']!.max).toBe(late);
    expect(dayCurveChart([], day, null)(colors).options!.scales!['x']!.max).toBe(new Date(2026, 9, 28, 22).getTime());
  });
});
