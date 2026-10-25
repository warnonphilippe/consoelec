import type { MeterReading } from '../models/app-data.model';
import { analyzeConsumption } from './consumption';
import {
  buildProfiles,
  expectedBetween,
  type EvScenario,
  type ProfileKey,
  type ProfileScores,
} from './forecast';
import type { ReferenceProfile, SeriesWeights } from './reference';
import { monthlyAverages } from './stats';
import { daysInMonth, toDayNumber } from './time';

export interface BacktestMonth {
  readonly key: string;
  readonly actual: { readonly import: number; readonly export: number };
  readonly predicted: Partial<
    Record<ProfileKey, { readonly import: number; readonly export: number }>
  >;
}

export interface BacktestResult {
  /** Mois complets qui ont pu être « prévus » avec les seuls relevés antérieurs. */
  readonly months: BacktestMonth[];
  /** Erreur moyenne par profil (voir `profileError`) et nombre de mois testés. */
  readonly scores: ProfileScores;
}

/** Il faut au moins ce nombre de jours de relevés avant un mois pour tenter de le prévoir. */
const MIN_PRIOR_DAYS = 14;

/** Écart absolu total rapporté au total mesuré : robuste aux mois où l'injection est presque nulle. */
function wape(pairs: { predicted: number; actual: number }[]): number {
  const actual = pairs.reduce((s, p) => s + p.actual, 0);
  const error = pairs.reduce((s, p) => s + Math.abs(p.predicted - p.actual), 0);
  return actual > 0 ? error / actual : Number.NaN;
}

/**
 * Mesure la fiabilité réelle des prévisions : pour chaque mois complet déjà mesuré, prévoit ce mois avec les seuls
 * relevés qui le précèdent (comme on l'aurait fait à l'époque), puis compare au résultat observé.
 * L'erreur d'un profil est la moyenne de l'erreur relative sur le soutirage et sur l'injection.
 */
export function backtest(
  readings: MeterReading[],
  reference: ReferenceProfile,
  weights: SeriesWeights,
  ev: EvScenario | null,
): BacktestResult {
  const full = analyzeConsumption(readings, weights);
  const levels = full.levels;
  const months: BacktestMonth[] = [];

  for (const bucket of full.months) {
    if (!bucket.complete) {
      continue;
    }
    const start = toDayNumber(`${bucket.key}-01`);
    const prior = levels.filter((l) => l.day <= start);
    if (prior.length < 2 || start - prior[0]!.day < MIN_PRIOR_DAYS) {
      continue;
    }
    const priorAnalysis = analyzeConsumption(
      prior.map((l) => l.reading),
      weights,
    );
    const profiles = buildProfiles(
      reference,
      priorAnalysis,
      monthlyAverages(priorAnalysis.months),
      ev,
    );
    const end = start + daysInMonth(bucket.year, bucket.month);
    const predicted: BacktestMonth['predicted'] = {};
    for (const profile of profiles) {
      if (profile.available) {
        const sumOf = (keys: ('importPeak' | 'importOff' | 'exportPeak' | 'exportOff')[]): number =>
          keys.reduce((s, k) => s + expectedBetween(profile, k, start, end, ev), 0);
        predicted[profile.key] = {
          import: sumOf(['importPeak', 'importOff']),
          export: sumOf(['exportPeak', 'exportOff']),
        };
      }
    }
    months.push({
      key: bucket.key,
      actual: {
        import: bucket.values.importPeak + bucket.values.importOff,
        export: bucket.values.exportPeak + bucket.values.exportOff,
      },
      predicted,
    });
  }

  const scores: ProfileScores = {};
  for (const key of ['reference', 'adjusted', 'history'] as const) {
    const tested = months.filter((m) => m.predicted[key] !== undefined);
    if (tested.length === 0) {
      continue;
    }
    const importError = wape(
      tested.map((m) => ({ predicted: m.predicted[key]!.import, actual: m.actual.import })),
    );
    const exportError = wape(
      tested.map((m) => ({ predicted: m.predicted[key]!.export, actual: m.actual.export })),
    );
    const error = [importError, exportError].filter(Number.isFinite);
    if (error.length > 0) {
      scores[key] = {
        error: error.reduce((a, b) => a + b, 0) / error.length,
        samples: tested.length,
      };
    }
  }
  return { months, scores };
}
