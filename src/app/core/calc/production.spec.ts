import { describe, expect, it } from 'vitest';
import type { MeterReading, PvDay } from '../models/app-data.model';
import {
  productionDays,
  productionMonths,
  productionSummary,
  solarFractionAt,
} from './production';
import { toDayNumber } from './time';

const flat = () => 10;

function pv(date: string, dayKwh: number, totalKwh: number, time = '22:00'): PvDay {
  return { date, dayKwh, totalKwh, at: `${date}T${time}` };
}

function reading(date: string, pvTotal: number | null): MeterReading {
  return {
    id: date,
    date,
    importPeak: 0,
    importOff: 0,
    exportPeak: 0,
    exportOff: 0,
    pvTotal,
    meterChange: false,
    source: 'manual',
    note: '',
  };
}

describe('solarFractionAt', () => {
  it('va de 0 à minuit à 1 en fin de journée, en croissant', () => {
    for (const month of [0, 5, 10]) {
      expect(solarFractionAt(month, 0)).toBe(0);
      expect(solarFractionAt(month, 24)).toBe(1);
      let previous = 0;
      for (let h = 0; h <= 24; h += 0.5) {
        const f = solarFractionAt(month, h);
        expect(f).toBeGreaterThanOrEqual(previous);
        previous = f;
      }
    }
  });

  it('place la moitié de la production vers le midi solaire et presque tout avant 18 h en octobre', () => {
    expect(solarFractionAt(9, 13.6)).toBeCloseTo(0.5, 1);
    expect(solarFractionAt(9, 18.25)).toBeGreaterThan(0.99);
    expect(solarFractionAt(9, 7)).toBe(0);
  });
});

describe('productionDays', () => {
  const now = toDayNumber('2026-10-26T21:00');

  it('reprend telles quelles les journées lues jusqu’au soir', () => {
    const days = productionDays(
      [pv('2026-10-20', 12, 1012), pv('2026-10-21', 8, 1020), pv('2026-10-22', 15, 1035)],
      [],
      flat,
      now,
    );
    expect(days.map((d) => d.status)).toEqual(['measured', 'measured', 'measured']);
    expect(days.map((d) => d.kwh)).toEqual([12, 8, 15]);
  });

  it('estime les jours sans lecture à partir des index qui les encadrent', () => {
    const days = productionDays(
      [pv('2026-10-20', 12, 1012), pv('2026-10-23', 9, 1051)],
      [],
      flat,
      now,
    );
    expect(days.map((d) => d.status)).toEqual(['measured', 'estimated', 'estimated', 'measured']);
    // 1051 − 9 − 1012 = 30 kWh produits les 21 et 22, répartis selon l'attendu (égal ici).
    expect(days[1]!.kwh + days[2]!.kwh).toBeCloseTo(30, 6);
    expect(days[1]!.kwh).toBeCloseTo(15, 6);
    expect(days[3]!.kwh).toBeCloseTo(9, 6);
  });

  it('complète une journée lue trop tôt avec la suite de l’index', () => {
    const days = productionDays(
      [pv('2026-10-20', 5, 1005, '11:00'), pv('2026-10-21', 10, 1020)],
      [],
      flat,
      now,
    );
    // 1020 − 10 − 1005 = 5 kWh produits le 20 après 11 h.
    expect(days[0]!.kwh).toBeCloseTo(10, 6);
    expect(days[0]!.status).toBe('measured');
  });

  it('signale la journée en cours et une première journée couverte en partie', () => {
    const days = productionDays(
      [pv('2026-10-26', 6, 1106, '14:00')],
      [reading('2026-10-24T12:00', 1080)],
      flat,
      now,
    );
    expect(days.map((d) => d.status)).toEqual(['partial', 'estimated', 'today']);
    expect(days.reduce((s, d) => s + d.kwh, 0)).toBeCloseTo(26, 6);
    expect(days[2]!.kwh).toBeCloseTo(6, 6);
  });

  it('ignore un intervalle où l’index recule et n’invente rien sans deux index', () => {
    const days = productionDays(
      [pv('2026-10-20', 12, 5012), pv('2026-10-22', 7, 17)],
      [],
      flat,
      now,
    );
    expect(days[1]!.kwh).toBe(0);
    expect(days[2]!.kwh).toBeCloseTo(7, 6);
    expect(productionDays([], [reading('2026-10-20T10:00', 100)], flat, now)).toEqual([]);
  });
});

describe('productionMonths et productionSummary', () => {
  it('additionne par mois et marque les mois complets', () => {
    const daily: PvDay[] = [];
    let total = 1000;
    for (let d = 1; d <= 30; d++) {
      total += 3;
      daily.push(pv(`2026-09-${String(d).padStart(2, '0')}`, 3, total));
    }
    total += 4;
    daily.push(pv('2026-10-01', 4, total));
    const days = productionDays(daily, [], flat, toDayNumber('2026-10-20T12:00'));
    const months = productionMonths(days, flat);
    expect(months).toHaveLength(2);
    expect(months[0]).toMatchObject({ year: 2026, month: 8, days: 30, complete: true, expected: 300 });
    expect(months[0]!.kwh).toBeCloseTo(90, 6);
    expect(months[1]).toMatchObject({ month: 9, days: 1, complete: false, expectedCovered: 10 });

    const summary = productionSummary(days, toDayNumber('2026-10-02T12:00'));
    expect(summary.last7?.days).toBe(7);
    expect(summary.last7?.kwh).toBeCloseTo(3 * 6 + 4, 6);
    expect(summary.best?.kwh).toBeCloseTo(4, 6);
    expect(summary.total).toBeCloseTo(94, 6);
  });

  it('écarte de la meilleure journée une valeur impossible pour l’onduleur', () => {
    const days = productionDays(
      [pv('2022-03-27', 34, 1034), pv('2022-03-28', 36, 1070), pv('2022-03-29', 69, 1139), pv('2022-03-30', 17, 1156)],
      [],
      flat,
      toDayNumber('2022-04-02T12:00'),
    );
    // 5 kW × 11,6 h de jour en mars = 58 kWh au plus.
    expect(productionSummary(days, toDayNumber('2022-04-02T12:00'), 5).best?.kwh).toBeCloseTo(36, 6);
    expect(productionSummary(days, toDayNumber('2022-04-02T12:00')).best?.kwh).toBeCloseTo(69, 6);
  });
});
