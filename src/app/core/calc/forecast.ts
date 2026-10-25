import { REGISTER_KEYS, type RegisterKey } from '../models/app-data.model';
import type { ConsumptionAnalysis } from './consumption';
import { forEachDaySlice } from './degree-days';
import type { MonthAverages } from './stats';
import type { MonthlyByRegister, ReferenceProfile } from './reference';
import { smoothMonthlyProfile, type DailyProfile } from './smooth';
import { daysInMonth, toDayNumber } from './time';

export type ProfileKey = 'reference' | 'adjusted' | 'history';

export interface ForecastProfile {
  readonly key: ProfileKey;
  readonly label: string;
  /** Valeurs attendues pour chaque mois de l'année et chaque registre (kWh). */
  readonly monthly: MonthlyByRegister;
  readonly available: boolean;
  /** Pourquoi le profil n'est pas (encore) disponible, ou comment il a été obtenu. */
  readonly note: string;
  /** Coefficient de recalage appliqué à la référence, par registre (profil « ajusté »). */
  readonly ratios?: Record<RegisterKey, number>;
  /** Confiance du recalage (0-1) : part de l'écart observé reprise dans la statistique ajustée. */
  readonly confidence?: number;
}

/** Effet d'une voiture électrique à partir d'une date (kWh/mois par registre, négatif = injection en moins). */
export interface EvScenario {
  readonly delta: MonthlyByRegister;
  /** Numéro de jour de la mise en service. */
  readonly startDay: number;
  /** Ajouter la voiture au profil « historique » : oui si elle n'est que prévue ; en service, l'historique l'intègre déjà. */
  readonly appliesToHistory: boolean;
}

export type IndexValues = Record<RegisterKey, number>;

export interface ForecastPoint {
  readonly day: number;
  readonly values: IndexValues;
}

export interface Forecast {
  readonly profile: ForecastProfile;
  readonly points: ForecastPoint[];
  /** Index estimés à l'instant présent. */
  readonly current: IndexValues;
  /** Consommation prévue sur les 12 prochains mois (kWh par registre). */
  readonly next12: IndexValues;
  /** Prévisions mensuelles complètes depuis le mois du dernier relevé, sur 36 mois (kWh par registre). */
  readonly months: ForecastMonth[];
}

export interface ForecastMonth {
  readonly key: string;
  readonly year: number;
  readonly month: number;
  readonly values: IndexValues;
}

/** Couverture minimale (en jours) pour recaler le profil statistique. */
const MIN_ADJUST_DAYS = 10;

/**
 * Prudence du recalage : le coefficient observé est ramené vers 1 tant que les relevés couvrent peu de jours.
 * Avec `d` jours observés, la confiance vaut d / (d + 60) : 33 % à un mois, 75 % à six mois, 86 % à un an.
 */
const SHRINK_DAYS = 60;

/** Nombre de mois du calendrier à connaître pour utiliser l'historique de la maison. */
export const HISTORY_MIN_MONTHS = 9;

const dailyProfiles = new WeakMap<number[], DailyProfile>();

function dailyOf(monthly: number[]): DailyProfile {
  let daily = dailyProfiles.get(monthly);
  if (!daily) {
    daily = smoothMonthlyProfile(monthly);
    dailyProfiles.set(monthly, daily);
  }
  return daily;
}

/** Consommation attendue (kWh) un jour donné pour un registre : profil mensuel lissé + voiture éventuelle. */
export function dailyRate(
  profile: ForecastProfile,
  key: RegisterKey,
  day: number,
  ev: EvScenario | null,
): number {
  let rate = dailyOf(profile.monthly[key])(day);
  if (ev !== null && day >= ev.startDay && (profile.key !== 'history' || ev.appliesToHistory)) {
    rate += dailyOf(ev.delta[key])(day);
  }
  return Math.max(0, rate);
}

/** Quantité attendue (kWh) entre deux numéros de jour pour un registre. */
export function expectedBetween(
  profile: ForecastProfile,
  key: RegisterKey,
  from: number,
  to: number,
  ev: EvScenario | null,
): number {
  let total = 0;
  forEachDaySlice(from, to, (day, fraction) => {
    total += dailyRate(profile, key, day, ev) * fraction;
  });
  return total;
}

export function buildProfiles(
  reference: ReferenceProfile,
  analysis: ConsumptionAnalysis | null,
  averages: MonthAverages,
  ev: EvScenario | null,
): ForecastProfile[] {
  const referenceProfile: ForecastProfile = {
    key: 'reference',
    label: 'Statistique belge',
    monthly: reference.registers,
    available: true,
    note: 'Profil d’une maison belge type avec vos réglages (panneaux, onduleur, présence, heures creuses).',
  };
  const profiles: ForecastProfile[] = [referenceProfile];

  const enough =
    analysis !== null && REGISTER_KEYS.every((k) => analysis.observed.days[k] >= MIN_ADJUST_DAYS);
  let adjusted: ForecastProfile;
  if (analysis !== null && enough) {
    const ratios = {} as Record<RegisterKey, number>;
    const confidence = {} as Record<RegisterKey, number>;
    for (const key of REGISTER_KEYS) {
      let expected = 0;
      for (const interval of analysis.intervals) {
        if (
          interval.delta[key] !== null &&
          interval.days > 0 &&
          !interval.anomalies.includes('spike')
        ) {
          expected += expectedBetween(
            referenceProfile,
            key,
            interval.from.day,
            interval.to.day,
            ev,
          );
        }
      }
      const days = analysis.observed.days[key];
      const weight = days / (days + SHRINK_DAYS);
      const raw = expected > 1e-9 ? analysis.observed.amount[key] / expected : 1;
      ratios[key] = clamp(1 + weight * (raw - 1), 0, 4);
      confidence[key] = weight;
    }
    const monthly = Object.fromEntries(
      REGISTER_KEYS.map((k) => [k, reference.registers[k].map((v) => v * ratios[k])]),
    ) as MonthlyByRegister;
    const mean = REGISTER_KEYS.reduce((s, k) => s + confidence[k], 0) / REGISTER_KEYS.length;
    adjusted = {
      key: 'adjusted',
      label: 'Statistique ajustée',
      monthly,
      available: true,
      ratios,
      confidence: mean,
      note: `Profil belge recalé sur vos relevés, registre par registre (confiance ${Math.round(mean * 100)} % : elle augmente avec la durée couverte).`,
    };
  } else {
    adjusted = {
      key: 'adjusted',
      label: 'Statistique ajustée',
      monthly: reference.registers,
      available: false,
      note: 'Encodez au moins deux relevés espacés de quelques semaines pour recaler le profil.',
    };
  }
  profiles.push(adjusted);

  // Historique : les mois mesurés ; les mois qui manquent sont complétés par la statistique ajustée.
  const known = averages.counts.filter((c) => c > 0).length;
  const history = Object.fromEntries(
    REGISTER_KEYS.map((k) => [
      k,
      averages.registers[k].map((v, m) => v ?? adjusted.monthly[k][m]!),
    ]),
  ) as MonthlyByRegister;
  const available = known >= HISTORY_MIN_MONTHS;
  profiles.push({
    key: 'history',
    label: 'Historique de la maison',
    monthly: history,
    available,
    note: !available
      ? `Pas encore assez de données : ${known} mois complet${known > 1 ? 's' : ''} sur ${HISTORY_MIN_MONTHS} nécessaires.`
      : known === 12
        ? 'Moyenne réelle de chaque mois sur les années précédentes.'
        : `Moyenne réelle de ${known} mois sur 12 ; les ${12 - known} autres sont complétés par la statistique ajustée.`,
  });
  return profiles;
}

/** Erreur moyenne observée sur les mois passés (voir `backtest`), par profil. */
export type ProfileScores = Partial<
  Record<ProfileKey, { readonly error: number; readonly samples: number }>
>;

/** Nombre minimal de mois testés pour que l'erreur observée décide du meilleur profil. */
const MIN_SCORE_SAMPLES = 3;

/**
 * Meilleur profil disponible : celui dont l'erreur sur les mois passés est la plus faible (si assez de mois ont pu
 * être testés), sinon historique, puis statistique ajustée, puis référence.
 */
export function bestProfile(
  profiles: ForecastProfile[],
  scores: ProfileScores = {},
): ForecastProfile {
  const scored = profiles
    .filter((p) => p.available && (scores[p.key]?.samples ?? 0) >= MIN_SCORE_SAMPLES)
    .sort((a, b) => scores[a.key]!.error - scores[b.key]!.error);
  if (scored.length >= 2) {
    return scored[0]!;
  }
  for (const key of ['history', 'adjusted', 'reference'] as const) {
    const profile = profiles.find((p) => p.key === key && p.available);
    if (profile) {
      return profile;
    }
  }
  return profiles[0]!;
}

export interface ForecastOptions {
  /** Index au dernier relevé et numéro de jour de ce relevé. */
  readonly start: ForecastPoint;
  readonly now: number;
  readonly horizonDays: number;
  readonly ev: EvScenario | null;
}

const copy = (values: IndexValues): IndexValues => ({ ...values });
const zero = (): IndexValues => ({ importPeak: 0, importOff: 0, exportPeak: 0, exportOff: 0 });

/** Projette les quatre index du compteur, jour par jour, du dernier relevé jusqu'à `now + horizon`. */
export function simulate(profile: ForecastProfile, options: ForecastOptions): Forecast {
  const { ev } = options;
  const end = options.now + options.horizonDays;
  const points: ForecastPoint[] = [{ day: options.start.day, values: copy(options.start.values) }];
  const level = copy(options.start.values);
  let current = copy(options.start.values);

  forEachDaySlice(options.start.day, end, (day, fraction) => {
    const sliceStart = Math.max(options.start.day, day);
    const rates = {} as IndexValues;
    for (const key of REGISTER_KEYS) {
      rates[key] = dailyRate(profile, key, day, ev);
      level[key] += rates[key] * fraction;
    }
    if (options.now >= sliceStart && options.now < sliceStart + fraction) {
      const rest = sliceStart + fraction - options.now;
      current = copy(level);
      for (const key of REGISTER_KEYS) {
        current[key] -= rates[key] * rest;
      }
    }
    points.push({ day: sliceStart + fraction, values: copy(level) });
  });
  if (options.now <= options.start.day) {
    current = copy(options.start.values);
  }

  const next12 = zero();
  for (const key of REGISTER_KEYS) {
    next12[key] = expectedBetween(profile, key, options.now, options.now + 365, ev);
  }

  // Les mois sont prévus depuis le mois du dernier relevé : aucun trou même si le dernier relevé est ancien.
  const first = new Date(Date.UTC(1970, 0, 1) + Math.floor(options.start.day) * 86_400_000);
  const months: ForecastMonth[] = [];
  for (let i = 0; i < 36; i++) {
    const date = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + i, 1));
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();
    const from = toDayNumber(`${year}-${String(month + 1).padStart(2, '0')}-01`);
    const values = zero();
    for (const key of REGISTER_KEYS) {
      values[key] = expectedBetween(profile, key, from, from + daysInMonth(year, month), ev);
    }
    months.push({ key: `${year}-${String(month + 1).padStart(2, '0')}`, year, month, values });
  }
  return { profile, points, current, next12, months };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
