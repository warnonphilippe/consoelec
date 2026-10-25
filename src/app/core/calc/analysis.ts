import { REGISTER_KEYS, type AppData } from '../models/app-data.model';
import { backtest, type BacktestResult } from './backtest';
import {
  analyzeConsumption,
  totalsBetween,
  type ConsumptionAnalysis,
  type Values,
} from './consumption';
import { evDelta } from './ev';
import {
  bestProfile,
  buildProfiles,
  expectedBetween,
  simulate,
  type EvScenario,
  type Forecast,
  type ForecastProfile,
  type IndexValues,
  type ProfileKey,
  type ProfileScores,
} from './forecast';
import {
  referenceProfile,
  seriesWeights,
  type ReferenceProfile,
  type SeriesWeights,
} from './reference';
import {
  derive,
  monthlyAverages,
  seasonStats,
  yearRows,
  type Derived,
  type MonthAverages,
  type SeasonStat,
  type YearRow,
} from './stats';
import { toDayNumber } from './time';

/** Horizon des prévisions : 18 mois. */
export const FORECAST_HORIZON_DAYS = 548;

export interface PvPeriod {
  readonly derived: Derived;
  /** Jours couverts à la fois par les quatre registres et par l'index de production. */
  readonly coveredDays: number;
}

export interface PeriodTotals {
  readonly values: Values;
  /** Soutirage, injection et solde net (les indicateurs solaires sont dans `pv`). */
  readonly derived: Derived;
  /** Production, autoconsommation et autarcie, calculées sur les seuls jours où l'index de production est connu. */
  readonly pv: PvPeriod | null;
  /** Jours réellement couverts par des relevés (le plus petit des quatre registres). */
  readonly coveredDays: number;
  readonly days: number;
}

export interface ForecastSet {
  readonly profiles: ForecastProfile[];
  readonly forecasts: Partial<Record<ProfileKey, Forecast>>;
  /** Prévision retenue pour les indicateurs (meilleur profil disponible). */
  readonly best: Forecast | null;
}

export interface FullAnalysis {
  readonly reference: ReferenceProfile;
  readonly weights: SeriesWeights;
  readonly consumption: ConsumptionAnalysis;
  readonly hasReadings: boolean;
  /** Au moins deux relevés. */
  readonly hasIntervals: boolean;
  readonly hasPv: boolean;
  readonly years: YearRow[];
  readonly averages: MonthAverages;
  readonly seasons: SeasonStat[];
  /** Prévisions sans voiture électrique (ou avec, si elle est déjà en service). */
  readonly base: ForecastSet;
  /** Prévisions avec la voiture électrique prévue ; `null` si aucune voiture n'est prévue. */
  readonly withEv: ForecastSet | null;
  readonly evScenario: EvScenario | null;
  /** Fiabilité observée des profils sur les mois passés ; `null` s'il n'y a pas assez de relevés. */
  readonly backtest: BacktestResult | null;
  /**
   * Fin des périodes glissantes : le dernier relevé (ou aujourd'hui s'il est plus ancien). Les « 12 derniers mois »
   * s'arrêtent là : ce qui se passe après le dernier relevé n'est pas encore mesuré.
   */
  readonly windowEnd: number | null;
  readonly last365: PeriodTotals | null;
  readonly last30: PeriodTotals | null;
  readonly last7: PeriodTotals | null;
  /** Consommation attendue sur les 30 derniers jours d'après le meilleur profil (pour situer le rythme actuel). */
  readonly expectedLast30: IndexValues | null;
  /** Index estimés aujourd'hui (selon le meilleur profil). */
  readonly currentIndices: IndexValues | null;
  /** Dernier relevé (index réels). */
  readonly lastIndices: IndexValues | null;
}

export function evScenarioOf(data: AppData, now: number): EvScenario | null {
  const ev = data.house.ev;
  if (ev.mode === 'none') {
    return null;
  }
  const startDay = ev.startDate ? toDayNumber(ev.startDate) : Number.NaN;
  return {
    delta: evDelta(data.house, data.settings),
    // Sans date : une voiture prévue démarre maintenant, une voiture en service est supposée toujours là.
    startDay: Number.isFinite(startDay) ? startDay : ev.mode === 'planned' ? now : 0,
    appliesToHistory: ev.mode === 'planned',
  };
}

function forecastSet(
  consumption: ConsumptionAnalysis,
  averages: MonthAverages,
  reference: ReferenceProfile,
  ev: EvScenario | null,
  scores: ProfileScores,
  now: number,
): ForecastSet {
  const profiles = buildProfiles(
    reference,
    consumption.levels.length > 1 ? consumption : null,
    averages,
    ev,
  );
  const forecasts: Partial<Record<ProfileKey, Forecast>> = {};
  const last = consumption.levels.at(-1);
  if (last !== undefined) {
    const start = {
      day: last.day,
      values: {
        importPeak: last.values.importPeak ?? 0,
        importOff: last.values.importOff ?? 0,
        exportPeak: last.values.exportPeak ?? 0,
        exportOff: last.values.exportOff ?? 0,
      },
    };
    for (const profile of profiles) {
      if (profile.available) {
        forecasts[profile.key] = simulate(profile, {
          start,
          now,
          horizonDays: FORECAST_HORIZON_DAYS,
          ev,
        });
      }
    }
  }
  return { profiles, forecasts, best: forecasts[bestProfile(profiles, scores).key] ?? null };
}

/** Au moins ce nombre de jours avec index de production pour afficher l'autoconsommation d'une période. */
const MIN_PV_DAYS = 14;

/** Totaux des `days` jours qui précèdent `end`. */
export function periodTotals(
  consumption: ConsumptionAnalysis,
  end: number,
  days: number,
  weights: SeriesWeights,
): PeriodTotals | null {
  if (consumption.intervals.length === 0) {
    return null;
  }
  const { values, covered } = totalsBetween(consumption, end - days, end, weights);
  const coveredDays = Math.min(...REGISTER_KEYS.map((k) => covered[k]));
  if (!(coveredDays > 0)) {
    return null;
  }
  const withPv = totalsBetween(consumption, end - days, end, weights, true);
  const pvDays = Math.min(...REGISTER_KEYS.map((k) => withPv.covered[k]), withPv.covered.pv);
  return {
    values,
    derived: derive(values, false),
    pv:
      pvDays >= MIN_PV_DAYS ? { derived: derive(withPv.values, true), coveredDays: pvDays } : null,
    coveredDays,
    days,
  };
}

export function analyze(data: AppData, now: number): FullAnalysis {
  const { settings, house } = data;
  const reference = referenceProfile(house, settings);
  const weights = seriesWeights(reference);
  const consumption = analyzeConsumption(data.readings, weights);
  const averages = monthlyAverages(consumption.months);
  const scenario = evScenarioOf(data, now);
  // Voiture déjà en service : elle fait partie du scénario de base. Voiture prévue : scénario à part.
  const baseEv = house.ev.mode === 'owned' ? scenario : null;
  const result =
    consumption.levels.length >= 3 ? backtest(data.readings, reference, weights, baseEv) : null;
  const scores = result?.scores ?? {};
  const base = forecastSet(consumption, averages, reference, baseEv, scores, now);
  const withEv =
    house.ev.mode === 'planned'
      ? forecastSet(consumption, averages, reference, scenario, scores, now)
      : null;

  const last = consumption.levels.at(-1);
  const lastIndices: IndexValues | null = last
    ? {
        importPeak: last.values.importPeak ?? 0,
        importOff: last.values.importOff ?? 0,
        exportPeak: last.values.exportPeak ?? 0,
        exportOff: last.values.exportOff ?? 0,
      }
    : null;

  const windowEnd = last ? Math.min(now, last.day) : null;
  const rolling = (days: number): PeriodTotals | null =>
    windowEnd === null ? null : periodTotals(consumption, windowEnd, days, weights);
  const expectedLast30: IndexValues | null =
    base.best && windowEnd !== null
      ? (Object.fromEntries(
          REGISTER_KEYS.map((k) => [
            k,
            expectedBetween(base.best!.profile, k, windowEnd - 30, windowEnd, baseEv),
          ]),
        ) as IndexValues)
      : null;

  return {
    reference,
    weights,
    consumption,
    hasReadings: consumption.levels.length > 0,
    hasIntervals: consumption.intervals.length > 0,
    hasPv: consumption.observed.days.pv > 0,
    years: yearRows(consumption.months),
    averages,
    seasons: seasonStats(averages, reference),
    base,
    withEv,
    evScenario: scenario,
    backtest: result,
    windowEnd,
    last365: rolling(365),
    last30: rolling(30),
    last7: rolling(7),
    expectedLast30,
    currentIndices: base.best?.current ?? lastIndices,
    lastIndices,
  };
}
