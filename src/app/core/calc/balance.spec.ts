import { describe, expect, it } from 'vitest';
import { emptyData, type MeterReading } from '../models/app-data.model';
import { analyze } from './analysis';
import { balanceSeries, billingYearStart } from './balance';
import { toDayNumber } from './time';

function reading(
  date: string,
  importPeak: number,
  importOff: number,
  exportPeak: number,
  exportOff: number,
  meterChange = false,
): MeterReading {
  return {
    id: date,
    date,
    importPeak,
    importOff,
    exportPeak,
    exportOff,
    pvTotal: null,
    meterChange,
    source: 'manual',
    note: '',
  };
}

function series(readings: MeterReading[], now: string, until: string, billingStart = '11-01') {
  const a = analyze({ ...emptyData(), readings }, toDayNumber(now));
  return balanceSeries(a.consumption, a.weights, a.base.best, billingStart, toDayNumber(until), toDayNumber(now));
}

describe('billingYearStart', () => {
  it('donne le dernier début d’année de facturation', () => {
    expect(billingYearStart(toDayNumber('2026-10-27'), '11-01')).toBe(toDayNumber('2025-11-01'));
    expect(billingYearStart(toDayNumber('2026-11-01'), '11-01')).toBe(toDayNumber('2026-11-01'));
    expect(billingYearStart(toDayNumber('2026-03-15T08:00'), '01-01')).toBe(toDayNumber('2026-01-01'));
  });
});

describe('balanceSeries', () => {
  it('calcule les soldes HP et HC entre relevés de la même année', () => {
    const s = series(
      [reading('2026-10-09T20:00', 461, 295, 1135, 2450), reading('2026-10-22T20:00', 634, 366, 1151, 2537)],
      '2026-10-23T12:00',
      '2026-10-23T12:00',
    );
    const last = s.history.at(-1)!;
    expect(last.hp).toBeCloseTo(173 - 16, 6);
    expect(last.hc).toBeCloseTo(71 - 87, 6);
    expect(s.history[0]).toMatchObject({ hp: 0, hc: 0 });
  });

  it('remet les soldes à zéro au début de l’année de facturation, sans rien perdre', () => {
    const readings = [
      reading('2026-10-09T20:00', 461, 295, 1135, 2450),
      reading('2026-11-20T20:00', 761, 495, 1155, 2550),
    ];
    const s = series(readings, '2026-11-21T12:00', '2026-11-21T12:00');
    const boundary = toDayNumber('2026-11-01');
    const atBoundary = s.history.filter((p) => p.day === boundary);
    expect(atBoundary).toHaveLength(2);
    expect(atBoundary[1]).toMatchObject({ hp: 0, hc: 0 });
    const last = s.history.at(-1)!;
    // Fin d'année + début de la suivante = écart total entre les deux relevés.
    expect(atBoundary[0]!.hp + last.hp).toBeCloseTo(300 - 20, 6);
    expect(atBoundary[0]!.hc + last.hc).toBeCloseTo(200 - 100, 6);
  });

  it('ignore l’intervalle d’un changement de compteur', () => {
    const s = series(
      [
        reading('2026-02-01T20:00', 5000, 4000, 8000, 9000),
        reading('2026-03-01T20:00', 20, 10, 30, 40, true),
        reading('2026-04-01T20:00', 120, 60, 80, 140),
      ],
      '2026-04-02T12:00',
      '2026-04-02T12:00',
      '01-01',
    );
    const last = s.history.at(-1)!;
    expect(last.hp).toBeCloseTo(100 - 50, 6);
    expect(last.hc).toBeCloseTo(50 - 100, 6);
  });

  it('prolonge les soldes par la prévision, remis à zéro au 1er novembre, et résume les deux années', () => {
    const readings = [
      reading('2025-11-05T20:00', 0, 0, 0, 0),
      reading('2026-02-05T20:00', 450, 300, 40, 60),
      reading('2026-05-05T20:00', 700, 520, 300, 700),
      reading('2026-08-05T20:00', 900, 700, 650, 1500),
      reading('2026-10-22T20:00', 1100, 830, 800, 1800),
    ];
    const s = series(readings, '2026-10-27T12:00', '2027-10-27T12:00');
    expect(s.forecast.length).toBeGreaterThan(40);
    const reset = s.forecast.filter((p) => p.day === toDayNumber('2026-11-01'));
    expect(reset.at(-1)).toMatchObject({ hp: 0, hc: 0 });
    expect(s.years).toHaveLength(2);
    expect(s.years[0]).toMatchObject({ forecast: true, start: toDayNumber('2025-11-01') });
    expect(s.years[0]!.coveredFrom).toBe(toDayNumber('2025-11-05T20:00'));
    // Fin de l'année en cours : proche du dernier solde mesuré (5 jours de prévision seulement).
    expect(s.years[0]!.hp).toBeGreaterThan(300 - 1);
    expect(s.years[0]!.hp).toBeLessThan(300 + 40);
    expect(s.years[1]).toMatchObject({ forecast: true, coveredFrom: null, start: toDayNumber('2026-11-01') });
    expect(Number.isFinite(s.years[1]!.hc)).toBe(true);
  });

  it('ne donne rien avec moins de deux relevés', () => {
    expect(series([reading('2026-10-09T20:00', 1, 1, 1, 1)], '2026-10-10T12:00', '2027-01-01')).toEqual({
      history: [],
      forecast: [],
      years: [],
    });
  });
});
