import { describe, expect, it } from 'vitest';
import { emptyData, type AnnualBill, type AppData, type PvDay } from '../models/app-data.model';
import { analyze } from './analysis';
import { annualHistory, billYears, houseBaseline } from './annual-history';
import { bestProfile } from './forecast';
import { referenceProfile } from './reference';
import { toDayNumber } from './time';

const bill = (from: string, to: string, netPeak: number, netOff: number): AnnualBill => ({
  id: from,
  from,
  to,
  netPeak,
  netOff,
  schedule: 'legacy',
  note: '',
});

const flat = () => 10;

describe('billYears', () => {
  it('ajoute la production de la période au solde facturé, et rien avant les panneaux', () => {
    const start = toDayNumber('2021-01-01');
    const days = Array.from({ length: 400 }, (_, i) => ({ day: start + i, kwh: 5 }));
    const years = billYears(
      [bill('2019-11-01', '2020-11-01', 2000, 1500), bill('2020-11-01', '2021-11-01', 500, -100)],
      days,
      flat,
      start,
    );
    expect(years[0]).toMatchObject({ production: 0, productionStatus: 'none', consumption: 3500 });
    // Production du 1er janvier au 31 octobre 2021 : 304 jours × 5 kWh.
    expect(years[1]!.production).toBeCloseTo(304 * 5, 6);
    expect(years[1]!.productionStatus).toBe('measured');
    expect(years[1]!.consumption).toBeCloseTo(400 + 304 * 5, 6);
  });

  it('complète par la production attendue les jours que le journal ne couvre pas', () => {
    const start = toDayNumber('2021-01-01');
    const days = Array.from({ length: 30 }, (_, i) => ({ day: start + i, kwh: 5 }));
    const [year] = billYears([bill('2021-01-01', '2021-03-01', 0, 0)], days, flat, start);
    expect(year!.productionStatus).toBe('estimated');
    expect(year!.production).toBeCloseTo(30 * 5 + 29 * 10, 6);
  });
});

describe('houseBaseline', () => {
  it('pondère les années récentes davantage et garde la moyenne belge en appoint', () => {
    const now = toDayNumber('2026-01-01');
    const b = houseBaseline(
      [
        { bill: bill('2018-11-01', '2019-11-01', 0, 0), consumptionPerYear: 3000 },
        { bill: bill('2024-11-01', '2025-11-01', 0, 0), consumptionPerYear: 5000 },
      ],
      4000,
      now,
    )!;
    expect(b.years).toBe(2);
    expect(b.annualKwh).toBeGreaterThan(4500);
    expect(b.annualKwh).toBeLessThan(5000);
    expect(b.belgianSharePct).toBeGreaterThan(20);
    expect(b.belgianSharePct).toBeLessThan(40);
    expect(houseBaseline([], 4000, now)).toBeNull();
  });
});

describe('annualHistory', () => {
  /** Panneaux qui produisent 15 kWh par jour depuis le 1er novembre 2021. */
  function data(): AppData {
    const d = emptyData();
    const pvDaily: PvDay[] = [];
    let total = 1000;
    const start = new Date(Date.UTC(2021, 10, 1));
    for (let i = 0; i < 4 * 366; i++) {
      const date = new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10);
      total += 15;
      pvDaily.push({ date, dayKwh: 15, totalKwh: total, at: `${date}T23:59` });
    }
    return {
      ...d,
      pvDaily,
      annualBills: [
        bill('2022-11-01', '2023-11-01', -1000, 200),
        bill('2023-11-01', '2024-11-01', -900, 100),
        bill('2024-11-01', '2025-11-01', -1100, 300),
      ],
    };
  }

  it('cale la référence sur la consommation de la maison et le rendement mesuré', () => {
    const d = data();
    const belgian = referenceProfile(d.house, d.settings);
    const h = annualHistory(d, belgian, toDayNumber('2025-11-10'))!;
    // 15 kWh × 365 jours de production, moins les soldes facturés : ~4 700 kWh par an.
    expect(h.years.every((y) => y.productionStatus === 'measured')).toBe(true);
    expect(h.years[0]!.consumption).toBeCloseTo(-800 + 15 * 365, 6);
    expect(h.baseline.annualKwh).toBeGreaterThan(4300);
    expect(h.baseline.annualKwh).toBeLessThan(4800);
    expect(h.measuredYield).not.toBeNull();
    expect(h.settings.specificYieldKwhPerKwp).toBe(h.measuredYield);
    // Le radiateur d'appoint, déjà dans les factures, n'est pas compté deux fois.
    const total = h.reference.annual.consumption;
    expect(total).toBeCloseTo(h.baseline.annualKwh, -1);
    expect(h.years[0]!.model).not.toBeNull();
  });

  it('propose le profil « historique annuel » et le préfère au profil belge', () => {
    const a = analyze(data(), toDayNumber('2025-11-10'));
    expect(a.annual).not.toBeNull();
    expect(a.base.profiles.map((p) => p.key)).toEqual(['reference', 'annual', 'adjusted', 'history']);
    expect(bestProfile(a.base.profiles).key).toBe('annual');
    expect(a.reference).toBe(a.annual!.reference);
    expect(a.belgian.annual.consumption).not.toBeCloseTo(a.reference.annual.consumption, 0);
  });

  it('ne fait rien sans facture', () => {
    const d = { ...data(), annualBills: [] };
    expect(annualHistory(d, referenceProfile(d.house, d.settings), toDayNumber('2025-11-10'))).toBeNull();
  });
});
