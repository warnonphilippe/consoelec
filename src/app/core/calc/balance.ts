import { totalsBetween, type ConsumptionAnalysis } from './consumption';
import type { Forecast, ForecastPoint, IndexValues } from './forecast';
import type { SeriesWeights } from './reference';
import { toDayNumber, yearMonthOf } from './time';

/**
 * Soldes de facturation d'un compteur intelligent wallon en régime de compensation : sur l'année de facturation, le
 * fournisseur compense soutirage et injection **par période tarifaire**. Solde heures pleines = soutiré HP − injecté
 * HP ; solde heures creuses = soutiré HC − injecté HC. Un solde positif est facturé ; un solde négatif en fin d'année
 * est un surplus non remboursé. Les soldes repartent de zéro à chaque début d'année de facturation.
 */

export interface BalancePoint {
  readonly day: number;
  /** Solde heures pleines (kWh). */
  readonly hp: number;
  /** Solde heures creuses (kWh). */
  readonly hc: number;
  /** `yearEnd` : solde facturé à la fin d'une année ; `yearStart` : départ à zéro de l'année suivante. */
  readonly kind?: 'yearEnd' | 'yearStart';
}

export interface BillingYear {
  readonly start: number;
  /** Début de l'année suivante (exclu). */
  readonly end: number;
  /** Soldes à la fin de l'année (mesurés ou prévus). */
  readonly hp: number;
  readonly hc: number;
  /** Une partie de l'année vient de la prévision. */
  readonly forecast: boolean;
  /** Premier jour couvert par les relevés, s'il est postérieur au début de l'année (année incomplète). */
  readonly coveredFrom: number | null;
  /**
   * Changement de compteur pendant l'année : l'ancien compteur a été soldé à cette date (facture de clôture), l'année
   * ne se compte qu'à partir d'elle. `null` sans changement.
   */
  readonly settledFrom: number | null;
  /** Mesuré du début de l'année au dernier relevé (s'il tombe dans l'année) : soutirages, injections et soldes. */
  readonly toDate: YearToDate | null;
}

export interface YearToDate {
  /** Dernier relevé pris en compte. */
  readonly day: number;
  readonly importPeak: number;
  readonly importOff: number;
  readonly exportPeak: number;
  readonly exportOff: number;
  readonly hp: number;
  readonly hc: number;
}

export interface BillingPrices {
  /** Prix moyen du kWh en heures pleines (€). */
  readonly hp: number;
  /** Prix moyen du kWh en heures creuses (€). */
  readonly hc: number;
}

export interface BillingCost {
  /** Coût des soldes positifs (€) ; un solde négatif ne coûte rien. */
  readonly hp: number;
  readonly hc: number;
  readonly total: number;
  /** Surplus non remboursé (kWh) : soldes négatifs. */
  readonly surplusKwh: number;
}

/** Coût estimé de soldes HP / HC au prix moyen du kWh : seuls les soldes positifs se paient. */
export function billingCost(hp: number, hc: number, prices: BillingPrices): BillingCost {
  const costHp = Math.max(0, hp) * prices.hp;
  const costHc = Math.max(0, hc) * prices.hc;
  return {
    hp: costHp,
    hc: costHc,
    total: costHp + costHc,
    surplusKwh: Math.max(0, -hp) + Math.max(0, -hc),
  };
}

export interface BalanceSeries {
  readonly history: BalancePoint[];
  readonly forecast: BalancePoint[];
  /** Année de facturation en cours et suivante. */
  readonly years: BillingYear[];
}

/** Début (`MM-JJ`) de l'année de facturation qui contient `day`. */
export function billingYearStart(day: number, billingStart: string): number {
  const { year } = yearMonthOf(Math.floor(day));
  const thisYear = toDayNumber(`${year}-${billingStart}`);
  return thisYear <= day ? thisYear : toDayNumber(`${year - 1}-${billingStart}`);
}

function nextBillingStart(day: number, billingStart: string): number {
  const start = billingYearStart(day, billingStart);
  const { year } = yearMonthOf(start);
  return toDayNumber(`${year + 1}-${billingStart}`);
}

/** Index prévus à un instant donné, par interpolation linéaire entre les points de la prévision. */
function forecastAt(points: readonly ForecastPoint[], day: number): IndexValues {
  const first = points[0]!;
  if (day <= first.day) {
    return first.values;
  }
  for (let i = 1; i < points.length; i++) {
    const b = points[i]!;
    if (b.day >= day) {
      const a = points[i - 1]!;
      const f = b.day > a.day ? (day - a.day) / (b.day - a.day) : 1;
      const lerp = (k: keyof IndexValues) => a.values[k] + (b.values[k] - a.values[k]) * f;
      return {
        importPeak: lerp('importPeak'),
        importOff: lerp('importOff'),
        exportPeak: lerp('exportPeak'),
        exportOff: lerp('exportOff'),
      };
    }
  }
  return points[points.length - 1]!.values;
}

const fromDeltas = (day: number, d: IndexValues): BalancePoint => ({
  day,
  hp: d.importPeak - d.exportPeak,
  hc: d.importOff - d.exportOff,
});

const delta = (a: IndexValues, b: IndexValues): IndexValues => ({
  importPeak: b.importPeak - a.importPeak,
  importOff: b.importOff - a.importOff,
  exportPeak: b.exportPeak - a.exportPeak,
  exportOff: b.exportOff - a.exportOff,
});

/**
 * Soldes HP / HC au fil du temps : aux relevés (répartition saisonnière entre deux relevés, intervalle d'un changement
 * de compteur ignoré), puis prévus jusqu'à `until` ; à chaque début d'année, un point de fin d'année suivi d'un point
 * à zéro. `now` situe l'année de facturation en cours.
 */
export function balanceSeries(
  consumption: ConsumptionAnalysis,
  weights: SeriesWeights,
  forecast: Forecast | null,
  billingStart: string,
  until: number,
  now: number,
): BalanceSeries {
  const levels = consumption.levels;
  if (levels.length < 2) {
    return { history: [], forecast: [], years: [] };
  }
  const first = levels[0]!.day;
  const last = levels[levels.length - 1]!.day;
  // Un changement de compteur solde l'ancien (facture de clôture) : la période de facturation repart de là.
  const changes = levels.filter((l) => l.reading.meterChange).map((l) => l.day);
  const periodStart = (day: number): number => {
    const yearStart = billingYearStart(day, billingStart);
    const change = changes.filter((c) => c > yearStart && c <= day).at(-1);
    return change ?? yearStart;
  };
  const measured = (day: number): BalancePoint => {
    const { values } = totalsBetween(consumption, periodStart(day), day, weights);
    return fromDeltas(day, values);
  };
  const endOfYear = (start: number, end: number): BalancePoint => {
    const { values } = totalsBetween(consumption, start, end, weights);
    return fromDeltas(end, values);
  };

  // Historique : chaque relevé, et chaque passage d'année entre le premier et le dernier relevé.
  const history: BalancePoint[] = [];
  let boundary = nextBillingStart(first, billingStart);
  for (const level of levels) {
    while (boundary <= level.day) {
      history.push({ ...endOfYear(periodStart(boundary - 1e-6), boundary), kind: 'yearEnd' });
      history.push({ day: boundary, hp: 0, hc: 0, kind: 'yearStart' });
      boundary = nextBillingStart(boundary, billingStart);
    }
    // Changement de compteur après d'autres relevés : solde de clôture de l'ancien, puis départ à zéro.
    if (level.reading.meterChange && level.day > first && level.day !== history.at(-1)?.day) {
      history.push({ ...endOfYear(periodStart(level.day - 1e-6), level.day), kind: 'yearEnd' });
      history.push({ day: level.day, hp: 0, hc: 0, kind: 'yearStart' });
    }
    if (level.day !== history.at(-1)?.day) {
      history.push(measured(level.day));
    }
  }

  // Prévision : solde au dernier relevé + évolution prévue des index, remis à zéro à chaque début d'année.
  const projected: BalancePoint[] = [];
  const points = forecast?.points ?? [];
  const atLast = history[history.length - 1]!;
  const project = (day: number): BalancePoint => {
    const start = periodStart(day);
    if (start <= last) {
      const d = fromDeltas(day, delta(forecastAt(points, last), forecastAt(points, day)));
      return { day, hp: atLast.hp + d.hp, hc: atLast.hc + d.hc };
    }
    return fromDeltas(day, delta(forecastAt(points, start), forecastAt(points, day)));
  };
  if (points.length > 0 && until > last) {
    projected.push(atLast);
    let next = nextBillingStart(last, billingStart);
    const step = 7;
    for (let day = last + step; day < until + step; day += step) {
      const target = Math.min(day, until);
      while (next <= target) {
        projected.push({ ...project(next - 1e-6), day: next, kind: 'yearEnd' });
        projected.push({ day: next, hp: 0, hc: 0, kind: 'yearStart' });
        next = nextBillingStart(next, billingStart);
      }
      projected.push(project(target));
    }
  }

  // Année en cours et suivante : soldes à leur fin.
  const years: BillingYear[] = [];
  let start = billingYearStart(now, billingStart);
  for (let i = 0; i < 2; i++) {
    const end = nextBillingStart(start, billingStart);
    const usesForecast = end > last;
    if (usesForecast && points.length === 0) {
      break;
    }
    const from = periodStart(end - 1e-6);
    const value = usesForecast ? project(end - 1e-6) : endOfYear(from, end);
    const toDateDay = Math.min(last, end);
    const measuredYear = toDateDay > from ? totalsBetween(consumption, from, toDateDay, weights).values : null;
    years.push({
      start,
      end,
      hp: value.hp,
      hc: value.hc,
      forecast: usesForecast,
      coveredFrom: first > from ? first : null,
      settledFrom: from > start ? from : null,
      toDate:
        measuredYear === null
          ? null
          : {
              day: toDateDay,
              importPeak: measuredYear.importPeak,
              importOff: measuredYear.importOff,
              exportPeak: measuredYear.exportPeak,
              exportOff: measuredYear.exportOff,
              hp: measuredYear.importPeak - measuredYear.exportPeak,
              hc: measuredYear.importOff - measuredYear.exportOff,
            },
    });
    start = end;
  }
  return { history, forecast: projected, years };
}
