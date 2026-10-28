import {
  REGISTER_KEYS,
  type MeterLog,
  type MeterLogPoint,
  type MeterReading,
  type PvDay,
  type RegisterKey,
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

export type RegisterValues = Record<RegisterKey, number>;

export interface TodayCurve {
  /** Début de la courbe : minuit, ou la première lecture du jour si celle de la veille au soir manque. */
  readonly start: string;
  /** `true` quand la courbe part d'une lecture prise après 23 h la veille. */
  readonly fromMidnight: boolean;
  /** kWh cumulés depuis le début, à chaque lecture (heures du jour puis minutes de la dernière heure). */
  readonly points: readonly { at: string; values: RegisterValues }[];
  /** Total du jour à la dernière lecture (kWh). */
  readonly totals: RegisterValues;
  /** Heure de la dernière lecture. */
  readonly lastAt: string;
}

/**
 * Courbe du jour en cours : pour chaque registre, les kWh comptés depuis minuit (la dernière lecture de la veille,
 * si elle a été prise après 23 h, sert de point de départ), sinon depuis la première lecture du jour.
 * Renvoie `null` sans lecture aujourd'hui.
 */
export function todayCurve(log: MeterLog, nowMs: number): TodayCurve | null {
  const today = toLocalIso(new Date(nowMs)).slice(0, 10);
  const merged = new Map<string, MeterLogPoint>();
  for (const p of [...log.hours, ...log.minutes, ...log.days]) {
    if (day(p) === today) {
      merged.set(p.at, p);
    }
  }
  const points = [...merged.values()].sort(byAt);
  const first = points[0];
  const last = points.at(-1);
  if (first === undefined || last === undefined) {
    return null;
  }
  const eve = log.days.filter((p) => day(p) < today).at(-1);
  const yesterday = toLocalIso(new Date(nowMs - 86_400_000)).slice(0, 10);
  const fromMidnight = eve !== undefined && day(eve) === yesterday && eve.at.slice(11) >= '23:00';
  const base = fromMidnight ? eve : first;
  const since = (p: MeterLogPoint): RegisterValues =>
    Object.fromEntries(
      REGISTER_KEYS.map((k) => [k, Math.max(0, Math.round((p[k] - base[k]) * 1000) / 1000)]),
    ) as RegisterValues;
  const curve = points.map((p) => ({ at: p.at, values: since(p) }));
  if (fromMidnight) {
    curve.unshift({ at: `${today}T00:00`, values: since(base) });
  }
  return {
    start: fromMidnight ? `${today}T00:00` : first.at,
    fromMidnight,
    points: curve,
    totals: since(last),
    lastAt: last.at,
  };
}
