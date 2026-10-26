import type { MeterReading, PvDay } from '../models/app-data.model';
import type { ReferenceProfile } from './reference';
import { smoothMonthlyProfile, type DailyProfile } from './smooth';
import { DAYLIGHT_HOURS, sunShape } from './solar';
import { daysInMonth, toDayNumber, yearMonthOf } from './time';

/**
 * Historique de la production photovoltaïque, jour par jour, à partir de l'index total de l'onduleur : lectures
 * enregistrées par ConsoElec (`pvDaily`, une par jour) et index de production notés dans les relevés.
 *
 * Chaque lecture fournit des points (instant, index) ; entre deux points, l'énergie produite est répartie selon la
 * production attendue (saison et heure du jour). Un jour lu jusqu'au coucher du soleil est donc exact, un jour sans
 * lecture est estimé à partir des index qui l'encadrent, et rien n'est extrapolé hors des lectures.
 */

export type ProductionStatus =
  /** Journée lue par l'onduleur, complète. */
  | 'measured'
  /** Journée sans lecture complète : déduite des index qui l'encadrent. */
  | 'estimated'
  /** Journée seulement en partie couverte par les lectures (début ou fin de l'historique). */
  | 'partial'
  /** Aujourd'hui, en cours. */
  | 'today';

export interface ProductionDay {
  /** Numéro du jour (minuit). */
  readonly day: number;
  readonly kwh: number;
  /** Production attendue ce jour-là selon le modèle de référence (kWh). */
  readonly expected: number;
  readonly status: ProductionStatus;
}

export interface ProductionMonth {
  readonly year: number;
  /** 0-11. */
  readonly month: number;
  /** Production des jours couverts (kWh). */
  readonly kwh: number;
  /** Production attendue sur le mois entier (kWh). */
  readonly expected: number;
  /** Production attendue sur les seuls jours couverts : base de comparaison d'un mois incomplet (kWh). */
  readonly expectedCovered: number;
  readonly days: number;
  readonly complete: boolean;
}

interface Anchor {
  readonly t: number;
  readonly total: number;
}

/** Part de la production d'une journée déjà faite à l'heure `hour` (0-24), selon la forme d'une journée du mois. */
export function solarFractionAt(month: number, hour: number): number {
  const shape = sunShape(month);
  const total = shape.reduce((a, b) => a + b, 0);
  if (!(total > 0) || hour <= 0) {
    return hour <= 0 ? 0 : hour / 24;
  }
  if (hour >= 24) {
    return 1;
  }
  const whole = Math.floor(hour);
  let done = 0;
  for (let h = 0; h < whole; h++) {
    done += shape[h]!;
  }
  done += shape[whole]! * (hour - whole);
  return done / total;
}

/** Production attendue cumulée de minuit du jour `day` (entier) à l'instant `t` de ce même jour. */
function expectedWithin(expected: DailyProfile, day: number, t: number): number {
  const { month } = yearMonthOf(day);
  return expected(day) * solarFractionAt(month, (t - day) * 24);
}

function anchorsOf(pvDaily: readonly PvDay[], readings: readonly MeterReading[]): Anchor[] {
  const anchors: Anchor[] = [];
  for (const d of pvDaily) {
    const start = toDayNumber(d.date);
    const at = toDayNumber(d.at);
    if (Number.isFinite(start) && Number.isFinite(d.totalKwh) && Number.isFinite(d.dayKwh)) {
      anchors.push({ t: start, total: d.totalKwh - d.dayKwh });
      if (Number.isFinite(at) && at > start) {
        anchors.push({ t: at, total: d.totalKwh });
      }
    }
  }
  for (const r of readings) {
    const t = toDayNumber(r.date);
    if (r.pvTotal !== null && r.pvTotal !== undefined && Number.isFinite(t)) {
      anchors.push({ t, total: r.pvTotal });
    }
  }
  return anchors.sort((a, b) => a.t - b.t);
}

/**
 * Production jour par jour, du premier au dernier index connu. `expected` donne la production attendue par jour
 * (kWh) ; `now` est l'instant présent (numéro de jour fractionnaire).
 */
export function productionDays(
  pvDaily: readonly PvDay[],
  readings: readonly MeterReading[],
  expected: DailyProfile,
  now: number,
): ProductionDay[] {
  const anchors = anchorsOf(pvDaily, readings);
  if (anchors.length < 2) {
    return [];
  }
  const firstDay = Math.floor(anchors[0]!.t);
  const lastDay = Math.floor(anchors[anchors.length - 1]!.t);
  const today = Math.floor(now);
  const count = lastDay - firstDay + 1;
  const kwh = new Array<number>(count).fill(0);
  const covered = new Array<number>(count).fill(0);
  const exact = new Array<boolean>(count).fill(true);
  const pvDays = new Set(pvDaily.map((d) => Math.floor(toDayNumber(d.date))));

  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i - 1]!;
    const b = anchors[i]!;
    const energy = b.total - a.total;
    // Index qui recule (onduleur remplacé, saisie erronée) : on ne répartit rien sur cet intervalle.
    if (!(b.t > a.t) || energy < 0) {
      continue;
    }
    // Énergie attendue sur chaque jour touché par l'intervalle [a, b].
    const slices: { day: number; weight: number }[] = [];
    for (let day = Math.floor(a.t); day < b.t; day++) {
      const from = Math.max(a.t, day);
      const to = Math.min(b.t, day + 1);
      slices.push({
        day,
        weight: expectedWithin(expected, day, to) - expectedWithin(expected, day, from),
      });
    }
    const total = slices.reduce((s, x) => s + x.weight, 0);
    // Un intervalle entier dans une même journée est une mesure exacte ; sur plusieurs jours, c'est une estimation.
    const sameDay = slices.length <= 1;
    for (const { day, weight } of slices) {
      const share = total > 0 ? weight / total : 1 / slices.length;
      const idx = day - firstDay;
      kwh[idx]! += energy * share;
      covered[idx]! += weight;
      if (!sameDay && energy * share > 0.05) {
        exact[idx] = false;
      }
    }
  }

  const days: ProductionDay[] = [];
  for (let idx = 0; idx < count; idx++) {
    const day = firstDay + idx;
    const exp = expected(day);
    const coverage = exp > 0 ? covered[idx]! / exp : 1;
    const status: ProductionStatus =
      day === today
        ? 'today'
        : coverage < 0.95
          ? 'partial'
          : pvDays.has(day) && exact[idx]
            ? 'measured'
            : 'estimated';
    days.push({ day, kwh: Math.max(0, kwh[idx]!), expected: exp, status });
  }
  return days;
}

/** Production attendue par jour (kWh), lissée à partir des totaux mensuels du modèle de référence. */
export function expectedDailyProduction(reference: ReferenceProfile): DailyProfile {
  return smoothMonthlyProfile(reference.production);
}

/** Totaux mensuels de l'historique journalier ; un mois est complet quand tous ses jours sont couverts. */
export function productionMonths(
  days: readonly ProductionDay[],
  expected: DailyProfile,
): ProductionMonth[] {
  const months = new Map<string, { year: number; month: number; kwh: number; covered: number; days: number }>();
  for (const d of days) {
    const { year, month } = yearMonthOf(d.day);
    const key = `${year}-${month}`;
    const m = months.get(key) ?? { year, month, kwh: 0, covered: 0, days: 0 };
    m.kwh += d.kwh;
    if (d.status !== 'partial' && d.status !== 'today') {
      m.covered += d.expected;
      m.days += 1;
    }
    months.set(key, m);
  }
  return [...months.values()].map((m) => {
    const length = daysInMonth(m.year, m.month);
    const first = toDayNumber(`${m.year}-${String(m.month + 1).padStart(2, '0')}-01`);
    let full = 0;
    for (let i = 0; i < length; i++) {
      full += expected(first + i);
    }
    return {
      year: m.year,
      month: m.month,
      kwh: m.kwh,
      expected: full,
      expectedCovered: m.covered,
      days: m.days,
      complete: m.days === length,
    };
  });
}

/**
 * Production maximale vraisemblable d'une journée : l'onduleur à pleine puissance du lever au coucher du soleil.
 * Au-delà, la valeur vient d'un journal irrégulier (mise en service, horloge déréglée) plutôt que du soleil.
 */
export function maxPlausibleDayKwh(day: number, inverterKw: number): number {
  return inverterKw * DAYLIGHT_HOURS[yearMonthOf(day).month]!;
}

export interface ProductionSummary {
  /** Les 7 et 30 derniers jours complets (hors aujourd'hui), avec l'attendu correspondant. */
  readonly last7: { kwh: number; expected: number; days: number } | null;
  readonly last30: { kwh: number; expected: number; days: number } | null;
  /** Meilleure journée complète, hors valeurs invraisemblables. */
  readonly best: ProductionDay | null;
  /** Production totale sur l'historique (kWh). */
  readonly total: number;
  readonly since: number | null;
}

export function productionSummary(
  days: readonly ProductionDay[],
  now: number,
  inverterKw = Infinity,
): ProductionSummary {
  const today = Math.floor(now);
  const window = (n: number) => {
    const inWindow = days.filter(
      (d) => d.day < today && d.day >= today - n && d.status !== 'partial',
    );
    return inWindow.length === 0
      ? null
      : {
          kwh: inWindow.reduce((s, d) => s + d.kwh, 0),
          expected: inWindow.reduce((s, d) => s + d.expected, 0),
          days: inWindow.length,
        };
  };
  const full = days.filter(
    (d) =>
      (d.status === 'measured' || d.status === 'estimated') &&
      d.kwh <= maxPlausibleDayKwh(d.day, inverterKw),
  );
  const best = full.reduce<ProductionDay | null>((b, d) => (b === null || d.kwh > b.kwh ? d : b), null);
  return {
    last7: window(7),
    last30: window(30),
    best,
    total: days.reduce((s, d) => s + d.kwh, 0),
    since: days[0]?.day ?? null,
  };
}
