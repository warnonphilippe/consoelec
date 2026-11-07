import type { MeterLog, MeterLogPoint, MeterProfileDay } from '../models/app-data.model';
import { MS_PER_DAY, toDayNumber } from './time';

/**
 * Profil de soutirage et d'injection au quart d'heure. Pour chaque journée, on garde l'index total de soutirage
 * (HP + HC) et d'injection (HP + HC) à chaque quart d'heure (00:00, 00:15 … 23:45), en Wh : l'énergie d'un quart
 * d'heure est l'écart entre deux index successifs. Garder des index plutôt que des écarts rend les fusions sûres :
 * une même valeur reçue deux fois (lecture en direct puis export HomeWizard) ne compte jamais double.
 *
 * Les index viennent des lectures du lecteur P1 (interpolés à l'heure ronde entre deux lectures) ou de l'export CSV
 * de l'app HomeWizard (lus tels quels). Entre deux lectures éloignées (Mac éteint, app fermée), l'index interpolé est
 * marqué « estimé » : l'énergie totale du trou est exacte, sa répartition dans le temps ne l'est pas.
 *
 * Les heures sont des heures locales repérées comme dans `time.ts` : un jour de changement d'heure garde 96 quarts.
 */

export const QUARTERS_PER_DAY = 96;
export const MINUTES_PER_QUARTER = 15;
export const MINUTES_PER_DAY = 1440;
/** Écart maximal entre deux lectures pour qu'un index interpolé entre elles soit tenu pour mesuré. */
const MEASURED_MAX_GAP_MIN = 15;
/** Détail au quart d'heure gardé ; au-delà, seul l'index de minuit reste (totaux par jour). */
export const PROFILE_DETAIL_DAYS = 400;

/** Index d'un instant : minute locale depuis 1970 (voir `time.ts`), soutirage et injection totaux en Wh. */
export interface IndexSample {
  readonly minute: number;
  readonly importWh: number;
  readonly exportWh: number;
  /** Valeur interpolée sur un trou de lecture. */
  readonly estimated: boolean;
}

/** `AAAA-MM-JJTHH:mm` local → minute depuis 1970 (heure locale comptée comme UTC, voir `time.ts`). */
export const minuteOf = (iso: string): number => Math.round(toDayNumber(iso) * MINUTES_PER_DAY);
export const dateOfDayIndex = (day: number): string => new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
const dayIndexOf = (date: string): number => Math.round(toDayNumber(date));

/** Index totaux (Wh) d'une lecture du journal P1. */
function wh(p: MeterLogPoint): { importWh: number; exportWh: number } {
  return {
    importWh: Math.round((p.importPeak + p.importOff) * 1000),
    exportWh: Math.round((p.exportPeak + p.exportOff) * 1000),
  };
}

/**
 * Index aux quarts d'heure compris entre deux lectures (bornes incluses), interpolés linéairement. Rien si les
 * lectures ne sont pas dans l'ordre ou si un index recule (changement de compteur).
 */
export function samplesBetween(from: MeterLogPoint, to: MeterLogPoint): IndexSample[] {
  const m0 = minuteOf(from.at);
  const m1 = minuteOf(to.at);
  const a = wh(from);
  const b = wh(to);
  if (!(m1 > m0) || b.importWh < a.importWh || b.exportWh < a.exportWh) {
    return [];
  }
  const gapEstimated = m1 - m0 > MEASURED_MAX_GAP_MIN;
  const samples: IndexSample[] = [];
  for (let m = Math.ceil(m0 / MINUTES_PER_QUARTER) * MINUTES_PER_QUARTER; m <= m1; m += MINUTES_PER_QUARTER) {
    const f = (m - m0) / (m1 - m0);
    samples.push({
      minute: m,
      importWh: Math.round(a.importWh + (b.importWh - a.importWh) * f),
      exportWh: Math.round(a.exportWh + (b.exportWh - a.exportWh) * f),
      estimated: gapEstimated && m !== m0 && m !== m1,
    });
  }
  return samples;
}

function emptyDay(date: string): MeterProfileDay {
  return {
    date,
    importWh: Array<number | null>(QUARTERS_PER_DAY).fill(null),
    exportWh: Array<number | null>(QUARTERS_PER_DAY).fill(null),
    estimated: [],
  };
}

/**
 * Ajoute des index au profil. Une valeur mesurée remplace toujours la précédente ; une valeur estimée ne remplace
 * qu'une valeur inconnue ou elle-même estimée. Renvoie le même profil si rien ne change.
 */
export function addSamples(
  profile: readonly MeterProfileDay[],
  samples: readonly IndexSample[],
): MeterProfileDay[] {
  if (samples.length === 0) {
    return profile as MeterProfileDay[];
  }
  const byDate = new Map(profile.map((d) => [d.date, d]));
  const touched = new Map<string, MeterProfileDay>();
  let changed = false;
  for (const s of samples) {
    const date = dateOfDayIndex(Math.floor(s.minute / MINUTES_PER_DAY));
    const q = (s.minute % MINUTES_PER_DAY) / MINUTES_PER_QUARTER;
    let day = touched.get(date);
    if (!day) {
      const current = byDate.get(date);
      day = current
        ? {
            ...current,
            importWh: [...current.importWh],
            exportWh: [...current.exportWh],
            estimated: [...(current.estimated ?? [])],
          }
        : emptyDay(date);
      touched.set(date, day);
    }
    const estimated = new Set(day.estimated);
    const known = day.importWh[q] !== null && day.importWh[q] !== undefined;
    if (s.estimated && known && !estimated.has(q)) {
      continue;
    }
    if (
      known &&
      day.importWh[q] === s.importWh &&
      day.exportWh[q] === s.exportWh &&
      estimated.has(q) === s.estimated
    ) {
      continue;
    }
    day.importWh[q] = s.importWh;
    day.exportWh[q] = s.exportWh;
    if (s.estimated) {
      estimated.add(q);
    } else {
      estimated.delete(q);
    }
    day.estimated = [...estimated].sort((x, y) => x - y);
    changed = true;
  }
  if (!changed) {
    return profile as MeterProfileDay[];
  }
  for (const [date, day] of touched) {
    byDate.set(date, day);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Fusion de deux profils (import de données) : mêmes règles que `addSamples`. */
export function mergeProfiles(
  local: readonly MeterProfileDay[],
  incoming: readonly MeterProfileDay[],
): MeterProfileDay[] {
  return addSamples(local, incoming.flatMap(samplesOfDay));
}

/** Index connus d'une journée. */
export function samplesOfDay(day: MeterProfileDay): IndexSample[] {
  const base = dayIndexOf(day.date) * MINUTES_PER_DAY;
  const estimated = new Set(day.estimated ?? []);
  const samples: IndexSample[] = [];
  for (let q = 0; q < QUARTERS_PER_DAY; q++) {
    const i = day.importWh[q];
    const e = day.exportWh[q];
    if (i !== null && i !== undefined && e !== null && e !== undefined) {
      samples.push({ minute: base + q * MINUTES_PER_QUARTER, importWh: i, exportWh: e, estimated: estimated.has(q) });
    }
  }
  return samples;
}

/** Profil tiré du journal P1 existant (premier lancement avec le profil) : toutes ses lectures, dans l'ordre. */
export function profileFromLog(log: MeterLog): MeterProfileDay[] {
  const points = new Map<string, MeterLogPoint>();
  for (const p of [...log.days, ...log.hours, ...log.minutes]) {
    points.set(p.at, p);
  }
  const sorted = [...points.values()].sort((a, b) => a.at.localeCompare(b.at));
  const samples: IndexSample[] = [];
  for (let i = 1; i < sorted.length; i++) {
    samples.push(...samplesBetween(sorted[i - 1]!, sorted[i]!));
  }
  return addSamples([], samples);
}

/**
 * Allège le profil : au-delà de `PROFILE_DETAIL_DAYS` jours avant la journée la plus récente, seul l'index de minuit
 * est gardé (il suffit aux totaux par jour).
 */
export function pruneProfile(profile: readonly MeterProfileDay[]): MeterProfileDay[] {
  const last = profile.at(-1);
  if (!last) {
    return [];
  }
  const cutoff = dayIndexOf(last.date) - PROFILE_DETAIL_DAYS;
  return profile.map((d) => {
    if (dayIndexOf(d.date) >= cutoff || d.importWh.slice(1).every((v) => v === null)) {
      return d;
    }
    const day = emptyDay(d.date);
    day.importWh[0] = d.importWh[0] ?? null;
    day.exportWh[0] = d.exportWh[0] ?? null;
    day.estimated = (d.estimated ?? []).filter((q) => q === 0);
    return day;
  });
}

// --- Séries pour les graphiques -------------------------------------------------------------------------------

/** Énergie d'un quart d'heure (début à `minute`). */
export interface QuarterEnergy {
  /** Début du quart d'heure, `AAAA-MM-JJTHH:mm` local. */
  readonly at: string;
  readonly importWh: number;
  readonly exportWh: number;
  /** Au moins un des deux index est estimé : la répartition dans le temps n'est pas mesurée. */
  readonly estimated: boolean;
}

export const pad = (n: number): string => String(n).padStart(2, '0');
const atOf = (date: string, q: number): string =>
  `${date}T${pad(Math.floor((q * MINUTES_PER_QUARTER) / 60))}:${pad((q * MINUTES_PER_QUARTER) % 60)}`;

/** Index d'un quart d'heure, en passant au lendemain pour le 96e. */
function indexAt(
  byDate: ReadonlyMap<string, MeterProfileDay>,
  date: string,
  q: number,
): { importWh: number; exportWh: number; estimated: boolean } | null {
  const d = q >= QUARTERS_PER_DAY ? dateOfDayIndex(dayIndexOf(date) + 1) : date;
  const qq = q % QUARTERS_PER_DAY;
  const day = byDate.get(d);
  const i = day?.importWh[qq];
  const e = day?.exportWh[qq];
  if (day === undefined || i === null || i === undefined || e === null || e === undefined) {
    return null;
  }
  return { importWh: i, exportWh: e, estimated: (day.estimated ?? []).includes(qq) };
}

/** Soutirage et injection de chaque quart d'heure connu d'une journée. */
export function dayQuarters(profile: readonly MeterProfileDay[], date: string): QuarterEnergy[] {
  const byDate = new Map(profile.map((d) => [d.date, d]));
  const quarters: QuarterEnergy[] = [];
  for (let q = 0; q < QUARTERS_PER_DAY; q++) {
    const a = indexAt(byDate, date, q);
    const b = indexAt(byDate, date, q + 1);
    if (a === null || b === null) {
      continue;
    }
    const importWh = b.importWh - a.importWh;
    const exportWh = b.exportWh - a.exportWh;
    if (importWh < 0 || exportWh < 0) {
      continue;
    }
    quarters.push({ at: atOf(date, q), importWh, exportWh, estimated: a.estimated || b.estimated });
  }
  return quarters;
}

/** Totaux d'une journée. */
export interface DayEnergy {
  /** `AAAA-MM-JJ`. */
  readonly date: string;
  readonly importKwh: number;
  readonly exportKwh: number;
  /** Une partie de la journée est répartie sur un trou de lecture, ou le total vient de deux lectures éloignées. */
  readonly estimated: boolean;
  /** La journée n'est pas entièrement couverte (début ou fin manquants) : total partiel. */
  readonly partial: boolean;
}

/**
 * Totaux par jour du `from` au `to` inclus (`AAAA-MM-JJ`). Un jour est complet quand les index de ses deux minuits
 * sont connus ; sinon le total couvre les quarts d'heure connus et il est dit partiel. Les jours sans aucun index sont
 * omis.
 */
export function dailyEnergy(profile: readonly MeterProfileDay[], from: string, to: string): DayEnergy[] {
  const byDate = new Map(profile.map((d) => [d.date, d]));
  const days: DayEnergy[] = [];
  for (let n = dayIndexOf(from); n <= dayIndexOf(to); n++) {
    const date = dateOfDayIndex(n);
    const start = indexAt(byDate, date, 0);
    const end = indexAt(byDate, date, QUARTERS_PER_DAY);
    if (start !== null && end !== null && end.importWh >= start.importWh && end.exportWh >= start.exportWh) {
      const quarters = dayQuarters(profile, date);
      days.push({
        date,
        importKwh: (end.importWh - start.importWh) / 1000,
        exportKwh: (end.exportWh - start.exportWh) / 1000,
        estimated: start.estimated || end.estimated || quarters.some((q) => q.estimated),
        partial: false,
      });
      continue;
    }
    const quarters = dayQuarters(profile, date);
    if (quarters.length === 0) {
      continue;
    }
    days.push({
      date,
      importKwh: quarters.reduce((s, q) => s + q.importWh, 0) / 1000,
      exportKwh: quarters.reduce((s, q) => s + q.exportWh, 0) / 1000,
      estimated: quarters.some((q) => q.estimated),
      partial: true,
    });
  }
  return days;
}
