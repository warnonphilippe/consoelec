import {
  type MeterLog,
  type MeterLogPoint,
  type MeterReading,
  type PvDay,
} from '../models/app-data.model';
import { solarFractionAt } from './production';
import { toDayNumber, toLocalIso, yearMonthOf } from './time';

/** Les minutes du journal couvrent la dernière heure. */
const MINUTES_KEPT_MS = 60 * 60 * 1000;

/**
 * Part de la production d'une journée au-delà de laquelle l'index de l'onduleur, lu à un autre moment que le compteur,
 * n'est plus repris comme index de production d'un relevé tiré du journal.
 */
const PV_MATCH_MAX_FRACTION = 0.02;

export const EMPTY_METER_LOG: MeterLog = { minutes: [], hours: [], days: [] };

const day = (p: MeterLogPoint): string => p.at.slice(0, 10);
const hour = (p: MeterLogPoint): string => p.at.slice(0, 13);
const byAt = (a: MeterLogPoint, b: MeterLogPoint): number => a.at.localeCompare(b.at);

/** Heure de la lecture la plus récente du journal, ou `null` s'il est vide. */
export function lastLogAt(log: MeterLog): string | null {
  const ats = [log.minutes.at(-1)?.at, log.hours.at(-1)?.at, log.days.at(-1)?.at].filter(
    (a): a is string => a !== undefined,
  );
  return ats.length === 0 ? null : ats.reduce((a, b) => (a > b ? a : b));
}

/**
 * Ajoute une lecture au journal en le gardant compact : les minutes de la dernière heure, la dernière lecture de
 * chaque heure du jour de la lecture, la dernière lecture de chaque jour. Une lecture plus ancienne que la dernière
 * connue est ignorée ; une lecture de la même minute remplace la précédente.
 */
export function appendMeterLog(log: MeterLog, point: MeterLogPoint, nowMs: number): MeterLog {
  const last = lastLogAt(log);
  if (last !== null && point.at < last) {
    return log;
  }
  const cutoff = toLocalIso(new Date(nowMs - MINUTES_KEPT_MS));
  return {
    minutes: [...log.minutes.filter((p) => p.at !== point.at && p.at >= cutoff), point],
    hours: [...log.hours.filter((p) => day(p) === day(point) && hour(p) !== hour(point)), point],
    days: [...log.days.filter((p) => day(p) !== day(point)), point].sort(byAt),
  };
}

/**
 * Relevés quotidiens tirés du journal (dernière lecture de chaque jour, le jour en cours compris), pour l'analyse.
 * Ils ne sont jamais enregistrés dans les relevés encodés. L'index de production est celui de l'onduleur lu le même
 * jour (`pvDaily`) quand le soleil n'a presque rien produit entre les deux lectures (lectures proches, ou dernière
 * lecture de l'onduleur après le coucher du soleil) ; sinon il reste inconnu.
 */
export function meterLogReadings(log: MeterLog, pvDaily: readonly PvDay[]): MeterReading[] {
  const pvByDay = new Map(pvDaily.map((d) => [d.date, d]));
  return log.days.map((p) => ({
    id: `p1-${day(p)}`,
    date: p.at,
    importPeak: p.importPeak,
    importOff: p.importOff,
    exportPeak: p.exportPeak,
    exportOff: p.exportOff,
    pvTotal: pvTotalAt(p.at, pvByDay.get(day(p))),
    meterChange: false,
    source: 'auto',
    note: '',
  }));
}

/** Index de l'onduleur valable à l'instant `at`, s'il a été lu le même jour sans production notable entre-temps. */
function pvTotalAt(at: string, pv: PvDay | undefined): number | null {
  if (pv === undefined || !Number.isFinite(pv.totalKwh)) {
    return null;
  }
  const meter = toDayNumber(at);
  const inverter = toDayNumber(pv.at);
  if (!Number.isFinite(meter) || !Number.isFinite(inverter)) {
    return null;
  }
  const start = Math.floor(meter);
  const { month } = yearMonthOf(start);
  const produced = Math.abs(
    solarFractionAt(month, (meter - start) * 24) - solarFractionAt(month, (inverter - start) * 24),
  );
  return produced < PV_MATCH_MAX_FRACTION ? pv.totalKwh : null;
}

/**
 * Lectures plus fines que le relevé quotidien, pour le graphique des index : la dernière de chaque heure du jour en
 * cours et chaque minute de la dernière heure.
 */
export function recentPoints(log: MeterLog, nowMs: number): MeterLogPoint[] {
  const today = toLocalIso(new Date(nowMs)).slice(0, 10);
  const cutoff = toLocalIso(new Date(nowMs - MINUTES_KEPT_MS));
  const merged = new Map<string, MeterLogPoint>();
  for (const p of [
    ...log.hours.filter((p) => day(p) === today),
    ...log.minutes.filter((p) => p.at >= cutoff),
  ]) {
    merged.set(p.at, p);
  }
  return [...merged.values()].sort(byAt);
}

/** Fusion de deux journaux (import) : le local est gardé ; pour chaque jour, la lecture la plus tardive l'emporte. */
export function mergeMeterLogs(
  local: MeterLog,
  incoming: MeterLog,
): { log: MeterLog; added: number } {
  const days = new Map(local.days.map((p) => [day(p), p]));
  let added = 0;
  for (const p of incoming.days) {
    const existing = days.get(day(p));
    if (!existing || existing.at < p.at) {
      days.set(day(p), p);
      added++;
    }
  }
  return { log: { ...local, days: [...days.values()].sort(byAt) }, added };
}

/** Minutes écoulées entre deux heures locales `AAAA-MM-JJTHH:mm`. */
const minutesBetween = (from: string, to: string): number =>
  Math.round((toDayNumber(to) - toDayNumber(from)) * 1440);

/** Une lecture plus ancienne n'est plus « en direct » : pas de moyenne récente. */
const RECENT_MAX_AGE_MIN = 10;

export interface RecentPower {
  /** Soutirage moyen (W), heures pleines et creuses confondues. */
  readonly importW: number;
  /** Injection moyenne (W), heures pleines et creuses confondues. */
  readonly exportW: number;
  /** Lectures entre lesquelles la moyenne est prise. */
  readonly from: string;
  readonly to: string;
}

/**
 * Puissances moyennes de soutirage et d'injection sur les `minutes` dernières minutes, tirées de l'écart des index
 * lus chaque minute (le compteur les donne au Wh près : ±12 W sur 5 minutes). La moyenne part de la lecture la plus
 * récente prise au moins `minutes` minutes avant la dernière, sur la durée réellement écoulée.
 * Renvoie `null` sans lecture récente ou sans lecture assez ancienne.
 */
export function recentAveragePower(log: MeterLog, nowMs: number, minutes = 5): RecentPower | null {
  const to = log.minutes.at(-1);
  if (to === undefined) {
    return null;
  }
  if (minutesBetween(to.at, toLocalIso(new Date(nowMs))) > RECENT_MAX_AGE_MIN) {
    return null;
  }
  const from = [...log.minutes].reverse().find((p) => minutesBetween(p.at, to.at) >= minutes);
  if (from === undefined) {
    return null;
  }
  const hours = minutesBetween(from.at, to.at) / 60;
  const watts = (kwh: number): number => Math.max(0, Math.round((kwh / hours) * 1000));
  return {
    importW: watts(to.importPeak + to.importOff - from.importPeak - from.importOff),
    exportW: watts(to.exportPeak + to.exportOff - from.exportPeak - from.exportOff),
    from: from.at,
    to: to.at,
  };
}
