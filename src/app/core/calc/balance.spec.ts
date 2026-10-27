import { describe, expect, it } from 'vitest';
import { emptyData, type MeterReading } from '../models/app-data.model';
import { analyze } from './analysis';
import { balanceSeries, billingCost, billingYearStart } from './balance';
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
    expect(atBoundary[0]!.kind).toBe('yearEnd');
    expect(atBoundary[1]).toMatchObject({ hp: 0, hc: 0, kind: 'yearStart' });
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
    expect(reset.map((p) => p.kind)).toEqual(['yearEnd', 'yearStart']);
    expect(reset.at(-1)).toMatchObject({ hp: 0, hc: 0 });
    // Le solde facturé affiché est celui de la fin d'année prévue dans le résumé.
    expect(reset[0]!.hp).toBeCloseTo(s.years[0]!.hp, 6);
    expect(s.years).toHaveLength(2);
    expect(s.years[0]).toMatchObject({ forecast: true, start: toDayNumber('2025-11-01') });
    expect(s.years[0]!.coveredFrom).toBe(toDayNumber('2025-11-05T20:00'));
    // Fin de l'année en cours : proche du dernier solde mesuré (5 jours de prévision seulement).
    expect(s.years[0]!.hp).toBeGreaterThan(300 - 1);
    expect(s.years[0]!.hp).toBeLessThan(300 + 40);
    expect(s.years[1]).toMatchObject({ forecast: true, coveredFrom: null, start: toDayNumber('2026-11-01') });
    expect(Number.isFinite(s.years[1]!.hc)).toBe(true);
  });

  it('donne le mesuré de l’année à ce jour avec les relevés réels d’octobre', () => {
    const s = series(
      [
        reading('2026-10-09T20:00', 461, 295, 1135, 2450),
        reading('2026-10-14T20:00', 530, 316, 1141, 2496),
        reading('2026-10-22T20:00', 634, 366, 1151, 2537),
        reading('2026-10-25T18:15', 706.48, 413.31, 1153.33, 2545.13),
        reading('2026-10-27T13:45', 716.64, 422.85, 1157.98, 2554.73),
      ],
      '2026-10-27T15:00',
      '2027-11-01',
    );
    const toDate = s.years[0]!.toDate!;
    expect(toDate.day).toBe(toDayNumber('2026-10-27T13:45'));
    expect(toDate.importPeak).toBeCloseTo(255.64, 6);
    expect(toDate.exportPeak).toBeCloseTo(22.98, 6);
    expect(toDate.hp).toBeCloseTo(232.66, 6);
    expect(toDate.hc).toBeCloseTo(23.12, 6);
    // L'année suivante n'a pas encore de relevé.
    expect(s.years[1]!.toDate).toBeNull();
  });

  it('chiffre le coût des seuls soldes positifs', () => {
    expect(billingCost(100, -50, { hp: 0.34, hc: 0.24 })).toEqual({
      hp: 34,
      hc: 0,
      total: 34,
      surplusKwh: 50,
    });
    const both = billingCost(10, 20, { hp: 0.3, hc: 0.2 });
    expect(both.total).toBeCloseTo(7, 6);
    expect(both.surplusKwh).toBe(0);
  });

  it('ne donne rien avec moins de deux relevés', () => {
    expect(series([reading('2026-10-09T20:00', 1, 1, 1, 1)], '2026-10-10T12:00', '2027-01-01')).toEqual({
      history: [],
      forecast: [],
      years: [],
    });
  });
});
