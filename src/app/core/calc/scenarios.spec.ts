import {
  DEFAULT_HOUSE,
  DEFAULT_SETTINGS,
  emptyData,
  type AppData,
  type House,
  type MeterReading,
  type RegisterKey,
  type Settings,
} from '../models/app-data.model';
import { analyze } from './analysis';
import { backtest } from './backtest';
import { analyzeConsumption } from './consumption';
import { buildProfiles } from './forecast';
import {
  monthlyDates,
  readingsFrom,
  regularDates,
  simulateHouse,
  type SimConfig,
  type SimDay,
} from './house-simulator';
import { referenceProfile, seriesWeights } from './reference';
import { monthlyAverages } from './stats';
import { dateToDayNumber, toDayNumber } from './time';

const house: House = structuredClone(DEFAULT_HOUSE);
const settings: Settings = { ...DEFAULT_SETTINGS };
const reference = referenceProfile(house, settings);
const weights = seriesWeights(reference);

const sum = (v: readonly number[]): number => v.reduce((a, b) => a + b, 0);
const imp = (d: SimDay): number => d.importPeak + d.importOff;
const exp = (d: SimDay): number => d.exportPeak + d.exportOff;
const at = (iso: string): number => dateToDayNumber(new Date(`${iso}:00`));

function simulate(over: Partial<SimConfig> = {}): SimDay[] {
  return simulateHouse({ house, settings, start: '2024-01-01', days: 731, seed: 7, ...over });
}

function dataFrom(readings: MeterReading[]): AppData {
  return { ...emptyData(), readings };
}

/** Écart absolu total rapporté au total de référence (WAPE), en %. */
function wape(pairs: { predicted: number; actual: number }[]): number {
  return (
    (sum(pairs.map((p) => Math.abs(p.predicted - p.actual))) / sum(pairs.map((p) => p.actual))) *
    100
  );
}

const err = (predicted: number, actual: number): number => (predicted / actual - 1) * 100;

describe('modèle de référence contre une année simulée jour par jour (météo aléatoire)', () => {
  const years = 8;
  const runs = Array.from({ length: years }, (_, y) =>
    simulate({ start: '2025-01-01', days: 365, seed: 100 + y }),
  );

  const mean = (pick: (d: SimDay) => number): number =>
    sum(runs.map((r) => sum(r.map(pick)))) / years;
  const monthly = (pick: (d: SimDay) => number): number[] =>
    Array.from({ length: 12 }, (_, m) => {
      const key = String(m + 1).padStart(2, '0');
      return (
        sum(runs.map((r) => sum(r.filter((d) => d.date.slice(5, 7) === key).map(pick)))) / years
      );
    });

  it('soutirage et injection annuels à moins de 6 %', () => {
    expect(Math.abs(err(reference.annual.import, mean(imp)))).toBeLessThan(6);
    expect(Math.abs(err(reference.annual.export, mean(exp)))).toBeLessThan(6);
  });

  it('production après écrêtage, écrêtage et radiateur proches de la simulation', () => {
    expect(
      Math.abs(
        err(
          reference.annual.production,
          mean((d) => d.production),
        ),
      ),
    ).toBeLessThan(3);
    expect(Math.abs(reference.annual.clipped - mean((d) => d.clipped))).toBeLessThan(60);
    expect(Math.abs(reference.annual.heater - mean((d) => d.heater))).toBeLessThan(120);
  });

  it('profil mensuel du soutirage et de l’injection : erreur pondérée sous 8 %', () => {
    const simImport = monthly(imp);
    const simExport = monthly(exp);
    const refImport = reference.registers.importPeak.map(
      (v, m) => v + reference.registers.importOff[m]!,
    );
    const refExport = reference.registers.exportPeak.map(
      (v, m) => v + reference.registers.exportOff[m]!,
    );
    expect(
      wape(refImport.map((predicted, m) => ({ predicted, actual: simImport[m]! }))),
    ).toBeLessThan(8);
    expect(
      wape(refExport.map((predicted, m) => ({ predicted, actual: simExport[m]! }))),
    ).toBeLessThan(8);
  });

  it('part du soutirage en heures creuses à 3 points près', () => {
    const simShare = (mean((d) => d.importOff) / mean(imp)) * 100;
    const refShare = (sum(reference.registers.importOff) / reference.annual.import) * 100;
    expect(Math.abs(refShare - simShare)).toBeLessThan(3);
  });
});

describe('répartition mensuelle à partir de relevés espacés', () => {
  const days = simulate({ consumptionScale: 1.2 });
  const truth = (key: string): { imp: number; exp: number } => {
    const month = days.filter((d) => d.date.startsWith(key));
    return { imp: sum(month.map(imp)), exp: sum(month.map(exp)) };
  };

  function allocationError(
    dates: string[],
    hour = 0,
  ): { imp: number; exp: number; months: number } {
    const readings = readingsFrom(days, { dates, hour });
    const analysis = analyzeConsumption(readings, weights);
    const complete = analysis.months.filter((m) => m.complete);
    return {
      imp: wape(
        complete.map((m) => ({
          predicted: m.values.importPeak + m.values.importOff,
          actual: truth(m.key).imp,
        })),
      ),
      exp: wape(
        complete.map((m) => ({
          predicted: m.values.exportPeak + m.values.exportOff,
          actual: truth(m.key).exp,
        })),
      ),
      months: complete.length,
    };
  }

  it('relevé le 1er de chaque mois : les mois sont exacts', () => {
    const e = allocationError(monthlyDates('2024-01', 25));
    expect(e.months).toBeGreaterThanOrEqual(23);
    expect(e.imp).toBeLessThan(0.1);
    expect(e.exp).toBeLessThan(0.1);
  });

  it('relevé le 15 de chaque mois : la répartition saisonnière limite l’erreur', () => {
    const e = allocationError(monthlyDates('2024-01', 25, 15));
    expect(e.imp).toBeLessThan(3.5);
    expect(e.exp).toBeLessThan(9);
  });

  it('relevé tous les 2 mois : erreur contenue', () => {
    const e = allocationError(monthlyDates('2024-01', 25).filter((_, i) => i % 2 === 0));
    expect(e.imp).toBeLessThan(5);
    expect(e.exp).toBeLessThan(10);
  });

  it('relevé tous les trimestres : encore exploitable', () => {
    const e = allocationError(monthlyDates('2024-01', 25).filter((_, i) => i % 3 === 0));
    expect(e.imp).toBeLessThan(6);
    expect(e.exp).toBeLessThan(12);
  });

  it('relevé à 8 h (index à mi-journée) : pas de dérive', () => {
    const e = allocationError(monthlyDates('2024-01', 25, 3), 8);
    expect(e.imp).toBeLessThan(3.5);
    expect(e.exp).toBeLessThan(7);
  });

  it('les totaux de l’année restent exacts quel que soit le rythme des relevés', () => {
    for (const step of [1, 2, 3]) {
      const dates = monthlyDates('2024-01', 24).filter((_, i) => i % step === 0);
      const readings = readingsFrom(days, { dates });
      const analysis = analyzeConsumption(readings, weights);
      const allocated = sum(analysis.months.map((m) => m.values.importPeak + m.values.importOff));
      const first = days.findIndex((d) => d.date === dates[0]);
      const last = days.findIndex((d) => d.date === dates.at(-1));
      expect(allocated).toBeCloseTo(sum(days.slice(first, last).map(imp)), 0);
    }
  });
});

describe('précision des prévisions selon la durée des relevés', () => {
  // La famille consomme 20 % de plus que la référence belge ; la référence seule se trompe donc d'environ 15 %.
  const days = simulate({ consumptionScale: 1.2 });

  function forecastErrors(trainMonths: number) {
    const dates = monthlyDates('2024-01', trainMonths + 1);
    const lastDate = dates.at(-1)!;
    const readings = readingsFrom(days, { dates, withPv: true });
    const analysis = analyze(dataFrom(readings), at(`${lastDate}T12:00`));
    const from = days.findIndex((d) => d.date === lastDate);
    const horizon = days.slice(from, from + 365);
    const truth = { imp: sum(horizon.map(imp)), exp: sum(horizon.map(exp)) };
    const errors = (key: 'reference' | 'adjusted' | 'history') => {
      const f = analysis.base.forecasts[key];
      return f
        ? {
            imp: err(f.next12.importPeak + f.next12.importOff, truth.imp),
            exp: err(f.next12.exportPeak + f.next12.exportOff, truth.exp),
          }
        : null;
    };
    return {
      analysis,
      reference: errors('reference')!,
      adjusted: errors('adjusted'),
      history: errors('history'),
    };
  }

  it('la référence seule sous-estime une famille qui consomme 20 % de plus', () => {
    const e = forecastErrors(3).reference;
    expect(e.imp).toBeLessThan(-10);
  });

  it('avec 3 mois de relevés, la statistique ajustée corrige l’essentiel', () => {
    const e = forecastErrors(3);
    expect(Math.abs(e.adjusted!.imp)).toBeLessThan(8);
    expect(Math.abs(e.adjusted!.imp)).toBeLessThan(Math.abs(e.reference.imp));
    expect(Math.abs(e.adjusted!.exp)).toBeLessThan(15);
  });

  it('avec 6 mois, soutirage à moins de 8 % et injection à moins de 15 %', () => {
    const e = forecastErrors(6);
    expect(Math.abs(e.adjusted!.imp)).toBeLessThan(8);
    expect(Math.abs(e.adjusted!.exp)).toBeLessThan(15);
    expect(e.history).toBeNull();
  });

  it('avec 12 mois, l’historique prévoit l’année suivante à moins de 6 %', () => {
    const e = forecastErrors(12);
    expect(e.history).not.toBeNull();
    expect(Math.abs(e.history!.imp)).toBeLessThan(6);
    expect(Math.abs(e.history!.exp)).toBeLessThan(8);
    expect(Math.abs(e.history!.imp)).toBeLessThan(Math.abs(e.reference.imp));
  });

  it('le meilleur profil retenu est celui dont l’erreur observée est la plus faible', () => {
    const { analysis } = forecastErrors(12);
    const scores = analysis.backtest!.scores;
    expect(scores.adjusted!.error).toBeLessThan(scores.reference!.error);
    expect(scores.adjusted!.samples).toBeGreaterThanOrEqual(8);
    expect(analysis.base.best!.profile.key).not.toBe('reference');
    const best = analysis.base.best!.profile.key;
    if (scores.history && scores.history.samples >= 3) {
      expect(scores[best]!.error).toBeLessThanOrEqual(
        Math.min(scores.adjusted!.error, scores.history.error) + 1e-9,
      );
    }
  });
});

describe('prudence du recalage avec peu de données', () => {
  it('quinze jours de relevés très au-dessus de la référence ne sont repris qu’en partie', () => {
    // Consommation double de la référence, observée seulement 15 jours : on ne triple pas toute l'année.
    const days = simulate({ consumptionScale: 2, days: 40 });
    const readings = readingsFrom(days, { dates: ['2024-01-01', '2024-01-16'] });
    const a = analyze(dataFrom(readings), at('2024-01-16T12:00'));
    const adjusted = a.base.profiles.find((p) => p.key === 'adjusted')!;
    const ratio = adjusted.ratios!.importPeak;
    expect(ratio).toBeGreaterThan(1.05);
    expect(ratio).toBeLessThan(1.5);
    expect(adjusted.confidence!).toBeLessThan(0.3);
  });

  it('la confiance croît avec la durée couverte', () => {
    const days = simulate({ consumptionScale: 1.2 });
    const confidence = (months: number): number => {
      const readings = readingsFrom(days, { dates: monthlyDates('2024-01', months + 1) });
      const profile = buildProfiles(
        reference,
        analyzeConsumption(readings, weights),
        monthlyAverages(analyzeConsumption(readings, weights).months),
        null,
      ).find((p) => p.key === 'adjusted')!;
      return profile.confidence ?? 0;
    };
    expect(confidence(1)).toBeLessThan(confidence(6));
    expect(confidence(6)).toBeLessThan(confidence(18));
    expect(confidence(18)).toBeGreaterThan(0.8);
  });
});

describe('historique partiel et mois manquants', () => {
  it('complète les mois manquants avec la statistique ajustée dès 9 mois', () => {
    const days = simulate({ consumptionScale: 1.2 });
    const readings = readingsFrom(days, { dates: monthlyDates('2024-01', 11) });
    const analysis = analyze(dataFrom(readings), at('2024-10-15T12:00'));
    const history = analysis.base.profiles.find((p) => p.key === 'history')!;
    expect(history.available).toBe(true);
    expect(history.note).toContain('complétés');
    expect(history.monthly.importPeak.every((v) => Number.isFinite(v) && v > 0)).toBe(true);
  });

  it('n’utilise pas l’historique avec moins de 9 mois', () => {
    const days = simulate();
    const readings = readingsFrom(days, { dates: monthlyDates('2024-01', 7) });
    const analysis = analyze(dataFrom(readings), at('2024-06-15T12:00'));
    expect(analysis.base.profiles.find((p) => p.key === 'history')!.available).toBe(false);
  });
});

describe('rétro-test des prévisions', () => {
  it('mesure l’erreur de chaque profil sur les mois passés', () => {
    const days = simulate({ consumptionScale: 1.2 });
    const readings = readingsFrom(days, { dates: monthlyDates('2024-01', 25) });
    const result = backtest(readings, reference, weights, null);
    expect(result.months.length).toBeGreaterThanOrEqual(15);
    const { reference: r, adjusted: a, history: h } = result.scores;
    expect(a!.error).toBeLessThan(r!.error);
    expect(a!.error).toBeLessThan(0.15);
    expect(h).toBeDefined();
    expect(h!.error).toBeLessThan(0.12);
  });

  it('ne teste rien sans assez de relevés', () => {
    const days = simulate({ days: 60 });
    const readings = readingsFrom(days, { dates: ['2024-01-01', '2024-01-20'] });
    expect(backtest(readings, reference, weights, null).months).toEqual([]);
  });
});

describe('voiture électrique dans les prévisions', () => {
  const planned: House = structuredClone(house);
  planned.ev = {
    ...planned.ev,
    mode: 'planned',
    startDate: '2025-01-01',
    kmPerYear: 15000,
    chargeWindow: 'night',
  };

  it('une voiture prévue de nuit ajoute environ sa consommation en heures creuses', () => {
    const days = simulate({ consumptionScale: 1.1 });
    const readings = readingsFrom(days, { dates: monthlyDates('2024-01', 13) });
    const data = { ...dataFrom(readings), house: planned };
    const a = analyze(data, at('2025-01-15T12:00'));
    const base = a.base.best!.next12;
    const withCar = a.withEv!.best!.next12;
    const need = (15000 * 17 * 0.8) / 100;
    expect(withCar.importOff - base.importOff).toBeGreaterThan(need * 0.9);
    expect(withCar.importOff - base.importOff).toBeLessThan(need * 1.1);
    expect(Math.abs(withCar.importPeak - base.importPeak)).toBeLessThan(need * 0.05);
    expect(withCar.exportPeak + withCar.exportOff).toBeCloseTo(base.exportPeak + base.exportOff, 0);
  });

  it('l’effet ne démarre qu’à la date d’arrivée de la voiture', () => {
    const later: House = structuredClone(planned);
    later.ev.startDate = '2025-07-01';
    const days = simulate();
    const readings = readingsFrom(days, { dates: monthlyDates('2024-01', 13) });
    const a = analyze({ ...dataFrom(readings), house: later }, at('2025-01-15T12:00'));
    const gain = a.withEv!.best!.next12.importOff - a.base.best!.next12.importOff;
    const need = (15000 * 17 * 0.8) / 100;
    // Six mois de voiture seulement sur les douze mois à venir.
    expect(gain).toBeGreaterThan(need * 0.4);
    expect(gain).toBeLessThan(need * 0.6);
  });

  it('une voiture déjà en service est incluse dans le scénario de base', () => {
    const owned: House = structuredClone(planned);
    owned.ev.mode = 'owned';
    const days = simulate();
    const readings = readingsFrom(days, { dates: monthlyDates('2024-01', 13) });
    const a = analyze({ ...dataFrom(readings), house: owned }, at('2025-01-15T12:00'));
    expect(a.withEv).toBeNull();
    const without = analyze(
      { ...dataFrom(readings), house: structuredClone(house) },
      at('2025-01-15T12:00'),
    );
    const reference12 = (x: typeof a): number => {
      const f = x.base.forecasts.reference!.next12;
      return f.importPeak + f.importOff;
    };
    expect(reference12(a) - reference12(without)).toBeGreaterThan(1000);
  });

  it('une voiture réelle dans l’historique est comprise : l’ajustement ne double pas la recharge', () => {
    // Voiture utilisée depuis le premier jour des relevés ; déclarée « en service ».
    const owned: House = structuredClone(house);
    owned.ev = {
      ...owned.ev,
      mode: 'owned',
      startDate: '2024-01-01',
      kmPerYear: 15000,
      chargeWindow: 'night',
    };
    const days = simulate({ evFromDay: 0, house: owned });
    const readings = readingsFrom(days, { dates: monthlyDates('2024-01', 13) });
    const a = analyze({ ...dataFrom(readings), house: owned }, at('2025-01-15T12:00'));
    const truth = sum(days.slice(0, 365).map(imp));
    const f = a.base.forecasts.adjusted!.next12;
    expect(Math.abs(err(f.importPeak + f.importOff, truth))).toBeLessThan(8);
  });
});

describe('compteur remplacé', () => {
  it('ignore l’intervalle du changement sans le compter comme une erreur', () => {
    const days = simulate();
    const dates = monthlyDates('2024-01', 8);
    const readings = readingsFrom(days, { dates });
    // Le nouveau compteur repart de zéro à partir du cinquième relevé.
    const offset = readings[4]!;
    const swapped: MeterReading[] = readings.map((r, i) =>
      i < 4
        ? r
        : {
            ...r,
            importPeak: r.importPeak - offset.importPeak + 3,
            importOff: r.importOff - offset.importOff + 1,
            exportPeak: r.exportPeak - offset.exportPeak,
            exportOff: r.exportOff - offset.exportOff,
            meterChange: i === 4,
          },
    );
    const analysis = analyzeConsumption(swapped, weights);
    expect(analysis.anomalyCount).toBe(0);
    expect(analysis.intervals[3]!.anomalies).toContain('meter-change');
    expect(analysis.intervals[3]!.delta.importPeak).toBeNull();
    const truthJan = sum(days.filter((d) => d.date.startsWith('2024-01')).map(imp));
    const jan = analysis.months.find((m) => m.key === '2024-01')!;
    expect(jan.values.importPeak + jan.values.importOff).toBeCloseTo(truthJan, 0);
    // Le mois du changement n'est pas complet : il ne fausse pas les moyennes.
    const april = analysis.months.find((m) => m.key === '2024-04');
    expect(april === undefined || !april.complete).toBe(true);
  });

  it('sans l’indication « nouveau compteur », un index en baisse est signalé', () => {
    const days = simulate();
    const readings = readingsFrom(days, { dates: monthlyDates('2024-01', 4) });
    readings[2] = { ...readings[2]!, importPeak: 5 };
    const analysis = analyzeConsumption(readings, weights);
    expect(analysis.anomalyCount).toBeGreaterThan(0);
    expect(analysis.intervals[1]!.anomalies).toContain('decrease');
  });
});

describe('indicateurs sur 12 mois glissants', () => {
  it('s’arrêtent au dernier relevé : trois semaines sans relevé ne font pas perdre 3 semaines', () => {
    const days = simulate();
    const readings = readingsFrom(days, { dates: monthlyDates('2024-01', 13), withPv: true });
    const a = analyze(dataFrom(readings), at('2025-01-25T12:00')); // 24 jours après le dernier relevé
    expect(a.windowEnd).toBeCloseTo(toDayNumber('2025-01-01'), 3);
    expect(a.last365!.coveredDays).toBeGreaterThan(364);
    const truth = sum(days.slice(1, 366).map(imp));
    expect(a.last365!.derived.import).toBeCloseTo(truth, -1);
  });

  it('l’autoconsommation se calcule sur les jours où l’index de production est connu', () => {
    const days = simulate();
    const readings = readingsFrom(days, { dates: monthlyDates('2024-01', 13), withPv: true });
    readings.push({
      ...readings.at(-1)!,
      id: 'x',
      date: '2025-01-15T12:00',
      pvTotal: null,
      importPeak: readings.at(-1)!.importPeak + 5,
    });
    const a = analyze(dataFrom(readings), at('2025-01-16T12:00'));
    const pv = a.last365!.pv!;
    expect(pv.coveredDays).toBeLessThanOrEqual(a.last365!.coveredDays);
    const production = sum(days.slice(1, 366).map((d) => d.production));
    const selfConsumed = sum(days.slice(1, 366).map((d) => d.production - exp(d)));
    expect(pv.derived.production!).toBeCloseTo(production, -2);
    expect(
      Math.abs(pv.derived.selfConsumptionPct! - (selfConsumed / production) * 100),
    ).toBeLessThan(1);
  });

  it('autoconsommation et autarcie mesurées proches de la simulation, radiateur compris', () => {
    const days = simulate();
    const readings = readingsFrom(days, { dates: monthlyDates('2024-01', 25), withPv: true });
    const a = analyze(dataFrom(readings), at('2026-01-01T12:00'));
    const pv = a.last365!.pv!;
    const year = days.slice(365, 731);
    const production = sum(year.map((d) => d.production));
    const selfConsumed = sum(year.map((d) => d.production - exp(d)));
    const consumption = sum(year.map((d) => d.consumption));
    expect(
      Math.abs(pv.derived.selfConsumptionPct! - (selfConsumed / production) * 100),
    ).toBeLessThan(1.5);
    expect(Math.abs(pv.derived.autarkyPct! - (selfConsumed / consumption) * 100)).toBeLessThan(1.5);
  });
});

describe('fiabilité du recalage selon le rythme des relevés', () => {
  const days = simulate({ consumptionScale: 1.15 });
  const registers: RegisterKey[] = ['importPeak', 'importOff', 'exportPeak', 'exportOff'];

  it('un relevé par semaine pendant 4 mois donne un ajustement cohérent sur chaque registre', () => {
    const readings = readingsFrom(days, { dates: regularDates('2024-03-01', 18, 7) });
    const analysis = analyzeConsumption(readings, weights);
    const adjusted = buildProfiles(
      reference,
      analysis,
      monthlyAverages(analysis.months),
      null,
    ).find((p) => p.key === 'adjusted')!;
    for (const key of registers) {
      expect(adjusted.ratios![key]).toBeGreaterThan(0.5);
      expect(adjusted.ratios![key]).toBeLessThan(2);
    }
    expect(adjusted.ratios!.importPeak).toBeGreaterThan(1.02);
  });
});

describe('données de démonstration', () => {
  it('forment deux années cohérentes, avec un historique complet', async () => {
    const { buildDemoData } = await import('./demo-data');
    const now = new Date('2026-10-25T12:00:00');
    const data = buildDemoData(now);
    expect(data.readings.length).toBeGreaterThanOrEqual(23);
    expect(data.readings.every((r) => r.pvTotal !== null)).toBe(true);
    const a = analyze(data, dateToDayNumber(now));
    expect(a.consumption.anomalyCount).toBe(0);
    expect(a.base.profiles.find((p) => p.key === 'history')!.available).toBe(true);
    expect(a.last365!.derived.net).toBeLessThan(0);
    const pv = a.last365!.pv!;
    expect(pv.derived.selfConsumptionPct!).toBeGreaterThan(18);
    expect(pv.derived.selfConsumptionPct!).toBeLessThan(40);
  });
});
