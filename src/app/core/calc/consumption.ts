import { REGISTER_KEYS, type MeterReading, type RegisterKey } from '../models/app-data.model';
import { forEachDaySlice } from './degree-days';
import type { SeriesWeights } from './reference';
import { daysInMonth, monthKey, toDayNumber, yearMonthOf } from './time';

/** Série suivie : les quatre registres du compteur + la production photovoltaïque totale (optionnelle). */
export type SeriesKey = RegisterKey | 'pv';
export const SERIES_KEYS: readonly SeriesKey[] = [...REGISTER_KEYS, 'pv'];

export type NullableValues = Record<SeriesKey, number | null>;
export type Values = Record<SeriesKey, number>;

export function emptyValues(): Values {
  return { importPeak: 0, importOff: 0, exportPeak: 0, exportOff: 0, pv: 0 };
}

export interface Level {
  readonly reading: MeterReading;
  /** Numéro de jour (fractionnaire) du relevé. */
  readonly day: number;
  readonly values: NullableValues;
}

export type AnomalyKind =
  /** Un index a diminué depuis le relevé précédent (faute de frappe, lecture erronée, compteur remplacé). */
  | 'decrease'
  /** Consommation ou injection de plus de 100 kWh par jour : très improbable pour une maison. */
  | 'spike'
  /** Plus de deux mois sans relevé : la répartition par mois est approximative. */
  | 'long'
  /** Premier relevé d'un nouveau compteur : l'intervalle depuis le relevé précédent est ignoré. */
  | 'meter-change'
  /** Deux relevés à la même minute. */
  | 'same-time';

export interface Interval {
  readonly from: Level;
  readonly to: Level;
  readonly days: number;
  /** Variation de chaque index (kWh) ; `null` si inutilisable (index en baisse, production absente). */
  readonly delta: NullableValues;
  /** Variation moyenne par jour. */
  readonly perDay: NullableValues;
  readonly anomalies: AnomalyKind[];
}

export interface MonthBucket {
  readonly key: string;
  readonly year: number;
  /** 0-11 */
  readonly month: number;
  /** kWh de chaque série attribués à ce mois. */
  readonly values: Values;
  /** Nombre de jours du mois couverts par des relevés valides, par série. */
  readonly covered: Values;
  /** Les quatre registres couvrent tout le mois. */
  readonly complete: boolean;
  /** La production totale couvre tout le mois. */
  readonly pvComplete: boolean;
}

export interface Observed {
  /** kWh observés. */
  readonly amount: Values;
  /** Nombre de jours effectivement couverts, par série. */
  readonly days: Values;
}

export interface ConsumptionAnalysis {
  readonly levels: Level[];
  readonly intervals: Interval[];
  readonly months: MonthBucket[];
  readonly observed: Observed;
  /** Intervalles à problème. */
  readonly anomalyCount: number;
}

const SPIKE_KWH_PER_DAY = 100;
const LONG_GAP_DAYS = 62;
const EPS = 1e-6;

export function levelsOf(readings: MeterReading[]): Level[] {
  return readings
    .map((reading) => ({
      reading,
      day: toDayNumber(reading.date),
      values: {
        importPeak: reading.importPeak,
        importOff: reading.importOff,
        exportPeak: reading.exportPeak,
        exportOff: reading.exportOff,
        pv: reading.pvTotal,
      } satisfies NullableValues,
    }))
    .filter((l) => Number.isFinite(l.day))
    .sort((a, b) => a.day - b.day);
}

export function buildIntervals(levels: Level[]): Interval[] {
  const intervals: Interval[] = [];
  for (let i = 1; i < levels.length; i++) {
    const from = levels[i - 1]!;
    const to = levels[i]!;
    const days = to.day - from.day;
    const anomalies: AnomalyKind[] = [];
    const delta = {} as NullableValues;
    const perDay = {} as NullableValues;
    if (days < 1 / 1440 - EPS) {
      anomalies.push('same-time');
    }
    const replaced = to.reading.meterChange;
    if (replaced) {
      anomalies.push('meter-change');
    }
    for (const key of SERIES_KEYS) {
      const a = from.values[key];
      const b = to.values[key];
      let d: number | null = null;
      if (!replaced && a !== null && b !== null && days > 0) {
        if (b + EPS < a) {
          if (!anomalies.includes('decrease') && key !== 'pv') {
            anomalies.push('decrease');
          }
        } else {
          d = Math.max(0, b - a);
        }
      }
      delta[key] = d;
      perDay[key] = d !== null && days > 0 ? d / days : null;
    }
    if (days > LONG_GAP_DAYS) {
      anomalies.push('long');
    }
    const importDaily = (perDay.importPeak ?? 0) + (perDay.importOff ?? 0);
    const exportDaily = (perDay.exportPeak ?? 0) + (perDay.exportOff ?? 0);
    if (importDaily > SPIKE_KWH_PER_DAY || exportDaily > SPIKE_KWH_PER_DAY) {
      anomalies.push('spike');
    }
    intervals.push({ from, to, days, delta, perDay, anomalies });
  }
  return intervals;
}

/** Intervalle utilisable pour une série : durée positive et variation valide, hors pic aberrant. */
function usable(interval: Interval, key: SeriesKey): boolean {
  return interval.delta[key] !== null && interval.days > 0 && !interval.anomalies.includes('spike');
}

/** Somme des poids saisonniers de la série sur [from, to]. */
function weightBetween(key: SeriesKey, from: number, to: number, weights: SeriesWeights): number {
  let total = 0;
  forEachDaySlice(from, to, (day, fraction) => {
    total += fraction * weights[key](day);
  });
  return total;
}

/**
 * Quantité (kWh) attribuée à la période [from, to] par un intervalle, répartie jour par jour
 * selon le poids saisonnier de la série ; `covered` = jours couverts.
 */
export function shareOfInterval(
  interval: Interval,
  key: SeriesKey,
  from: number,
  to: number,
  weights: SeriesWeights,
): { amount: number; covered: number } {
  const delta = interval.delta[key];
  const a = Math.max(from, interval.from.day);
  const b = Math.min(to, interval.to.day);
  if (delta === null || !(b > a)) {
    return { amount: 0, covered: 0 };
  }
  const total = weightBetween(key, interval.from.day, interval.to.day, weights);
  const part = weightBetween(key, a, b, weights);
  const ratio = total > 0 ? part / total : (b - a) / interval.days;
  return { amount: delta * ratio, covered: b - a };
}

/**
 * Analyse complète des relevés : intervalles, anomalies, consommation attribuée mois par mois
 * (répartition journalière saisonnière) et totaux observés.
 * `weights` donne le poids saisonnier de chaque jour pour chaque série (voir `seriesWeights`).
 */
export function analyzeConsumption(
  readings: MeterReading[],
  weights: SeriesWeights,
): ConsumptionAnalysis {
  const levels = levelsOf(readings);
  const intervals = buildIntervals(levels);
  const buckets = new Map<
    string,
    { year: number; month: number; values: Values; covered: Values }
  >();
  const observed: { amount: Values; days: Values } = { amount: emptyValues(), days: emptyValues() };

  for (const interval of intervals) {
    for (const key of SERIES_KEYS) {
      if (!usable(interval, key)) {
        continue;
      }
      const delta = interval.delta[key]!;
      const total = weightBetween(key, interval.from.day, interval.to.day, weights);
      observed.amount[key] += delta;
      observed.days[key] += interval.days;
      forEachDaySlice(interval.from.day, interval.to.day, (day, fraction) => {
        const weight = fraction * weights[key](day);
        const amount = total > 0 ? (delta * weight) / total : (delta * fraction) / interval.days;
        const { year, month } = yearMonthOf(day);
        const id = monthKey(year, month);
        let bucket = buckets.get(id);
        if (!bucket) {
          bucket = { year, month, values: emptyValues(), covered: emptyValues() };
          buckets.set(id, bucket);
        }
        bucket.values[key] += amount;
        bucket.covered[key] += fraction;
      });
    }
  }

  const months = [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, b]): MonthBucket => {
      const length = daysInMonth(b.year, b.month);
      const full = (k: SeriesKey): boolean => b.covered[k] >= length - 0.01;
      return {
        key,
        year: b.year,
        month: b.month,
        values: b.values,
        covered: b.covered,
        complete: REGISTER_KEYS.every(full),
        pvComplete: full('pv'),
      };
    });

  return {
    levels,
    intervals,
    months,
    observed,
    anomalyCount: intervals.filter((i) =>
      i.anomalies.some((a) => a !== 'long' && a !== 'meter-change'),
    ).length,
  };
}

/**
 * Totaux de chaque série sur [from, to] d'après les relevés, avec les jours couverts.
 * Avec `onlyWithPv`, seuls les intervalles dont l'index de production est connu sont retenus : les quatre registres
 * et la production portent alors sur exactement les mêmes jours (indispensable pour l'autoconsommation).
 */
export function totalsBetween(
  analysis: ConsumptionAnalysis,
  from: number,
  to: number,
  weights: SeriesWeights,
  onlyWithPv = false,
): { values: Values; covered: Values } {
  const values = emptyValues();
  const covered = emptyValues();
  for (const interval of analysis.intervals) {
    if (onlyWithPv && !usable(interval, 'pv')) {
      continue;
    }
    for (const key of SERIES_KEYS) {
      if (usable(interval, key)) {
        const share = shareOfInterval(interval, key, from, to, weights);
        values[key] += share.amount;
        covered[key] += share.covered;
      }
    }
  }
  return { values, covered };
}
