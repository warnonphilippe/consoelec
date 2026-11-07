import { dayWhFromTotal } from './pv-day';

describe('production du jour déduite de l’index total', () => {
  const day = (date: string, dayKwh: number, totalKwh: number) => ({ date, dayKwh, totalKwh, at: `${date}T18:00` });

  it('part de l’index de la veille', () => {
    expect(dayWhFromTotal(1_012_500, '2026-06-21', [day('2026-06-20', 30, 1000)])).toBe(12_500);
  });

  it('garde le point de départ de la journée déjà enregistrée', () => {
    expect(dayWhFromTotal(1_020_000, '2026-06-21', [day('2026-06-20', 30, 1000), day('2026-06-21', 5, 1005)])).toBe(
      20_000,
    );
  });

  it('sans la veille, compte depuis la première lecture', () => {
    expect(dayWhFromTotal(1_012_500, '2026-06-21', [day('2026-06-18', 30, 990)])).toBe(0);
    expect(dayWhFromTotal(1_012_500, '2026-06-21', [])).toBe(0);
  });
});
