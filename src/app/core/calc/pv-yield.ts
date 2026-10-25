import type { PvDay } from '../models/app-data.model';
import type { ReferenceProfile } from './reference';
import { smoothMonthlyProfile } from './smooth';
import { forEachDaySlice } from './degree-days';
import { toDayNumber } from './time';

/** Il faut au moins ce nombre de jours entre deux lectures de l'onduleur pour estimer le rendement. */
export const MIN_YIELD_DAYS = 14;

export interface MeasuredYield {
  /** Rendement estimé avant écrêtage (kWh/kWc/an), comparable au réglage. */
  readonly kwhPerKwp: number;
  /** Production annuelle estimée après écrêtage (kWh). */
  readonly annualKwh: number;
  /** Production réellement mesurée sur la période (kWh). */
  readonly measuredKwh: number;
  readonly days: number;
}

/**
 * Rendement mesuré à partir de l'index total de l'onduleur entre la première et la dernière lecture enregistrées
 * (exact même si les journées ont été lues incomplètes) : la production mesurée est rapportée à la part de l'année
 * qu'elle représente selon le profil solaire, puis à la puissance crête, en réintégrant l'écrêtage du modèle.
 */
export function measuredYield(
  pvDaily: readonly PvDay[],
  reference: ReferenceProfile,
  kwp: number,
): MeasuredYield | null {
  if (pvDaily.length < 2 || kwp <= 0) {
    return null;
  }
  const first = pvDaily[0]!;
  const last = pvDaily[pvDaily.length - 1]!;
  const from = toDayNumber(first.at);
  const to = toDayNumber(last.at);
  const measuredKwh = last.totalKwh - first.totalKwh;
  if (!(to - from >= MIN_YIELD_DAYS) || !(measuredKwh > 0)) {
    return null;
  }
  const annual = reference.production.reduce((a, b) => a + b, 0);
  if (!(annual > 0)) {
    return null;
  }
  const daily = smoothMonthlyProfile(reference.production.map((v) => v / annual));
  let share = 0;
  forEachDaySlice(from, to, (day, fraction) => {
    share += fraction * daily(day);
  });
  if (!(share > 0)) {
    return null;
  }
  const annualKwh = measuredKwh / share;
  const potential = reference.annual.production + reference.annual.clipped;
  const clipLoss = potential > 0 ? reference.annual.clipped / potential : 0;
  return { kwhPerKwp: annualKwh / (1 - clipLoss) / kwp, annualKwh, measuredKwh, days: to - from };
}
