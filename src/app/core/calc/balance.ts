import { totalsBetween, type ConsumptionAnalysis } from './consumption';
import { expectedBetween, type Forecast, type ForecastPoint, type IndexValues } from './forecast';
import type { SeriesWeights } from './reference';
import { MS_PER_DAY, toDayNumber, yearMonthOf } from './time';

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
  /**
   * Plus haut point de chaque courbe limite sur l'année (le solde à ne pas dépasser à la fin de l'hiver), et sa date ;
   * `null` sans prévision. Une période dont la limite ne monte jamais au-dessus de zéro a un plafond `null`.
   */
  readonly ceiling: BalanceCeiling | null;
  /**
   * Marge avant de dépasser la limite, au dernier relevé (ou au début de l'année si elle est encore à venir) :
   * ce qu'on peut encore consommer en plus de l'attendu sans finir l'année au-dessus de zéro. `null` sans prévision
   * ou pour une année terminée.
   */
  readonly margin: BalanceMargin | null;
}

export interface BalanceCeiling {
  readonly hp: number | null;
  readonly hpDay: number | null;
  readonly hc: number | null;
  readonly hcDay: number | null;
}

/** Point d'une courbe limite : `null` pour une période sans plafond au-dessus de zéro cette année-là. */
export interface LimitPoint {
  readonly day: number;
  readonly hp: number | null;
  readonly hc: number | null;
  readonly kind?: BalancePoint['kind'];
}

export interface BalanceMargin {
  /** Jour à partir duquel la marge se compte. */
  readonly day: number;
  readonly hp: number;
  readonly hc: number;
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
  /**
   * Courbes limites : le solde le plus haut qu'on peut avoir à chaque instant et quand même finir l'année de
   * facturation à zéro, si la suite de l'année suit le profil de la prévision (injection attendue − soutirage attendu
   * d'ici la fin de l'année). Pendant l'hiver, une droite de zéro (facturation) au plafond (bascule de la prévision),
   * puis la limite exacte jusqu'à zéro en fin d'année (voir `winterBudget`) ; `null` pour une période sans plafond
   * au-dessus de zéro cette année-là.
   */
  readonly limit: LimitPoint[];
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
    return { history: [], forecast: [], limit: [], years: [] };
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

  // Année en cours et suivante : soldes à leur fin, et courbe limite de chacune.
  const years: BillingYear[] = [];
  const limit: LimitPoint[] = [];
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
    const yearLimit = forecast ? limitCurve(forecast, limitDays(from, end, last, history), end) : [];
    let ceiling: BalanceCeiling | null = null;
    let margin: BalanceMargin | null = null;
    if (yearLimit.length > 0) {
      if (last < end) {
        const day = Math.max(from, last);
        const allowed = remainingNet(forecast!, day, end);
        const hp = measuredYear && last > from ? measuredYear.importPeak - measuredYear.exportPeak : 0;
        const hc = measuredYear && last > from ? measuredYear.importOff - measuredYear.exportOff : 0;
        margin = { day, hp: allowed.hp - hp, hc: allowed.hc - hc };
      }
      const hp = winterBudget(yearLimit, 'hp');
      const hc = winterBudget(yearLimit, 'hc');
      ceiling = { hp: hp.ceiling, hpDay: hp.ceilingDay, hc: hc.ceiling, hcDay: hc.ceilingDay };
      const points = yearLimit.map((p, i): LimitPoint => ({ ...p, hp: hp.values[i]!, hc: hc.values[i]! }));
      limit.push({ ...points[0]!, kind: limit.length > 0 ? 'yearStart' : undefined }, ...points.slice(1));
    }
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
      ceiling,
      margin,
    });
    start = end;
  }
  return { history, forecast: projected, limit, years };
}

/** Injection attendue − soutirage attendu entre `from` et `to`, par période (le solde qu'on peut encore « rattraper »). */
function remainingNet(forecast: Forecast, from: number, to: number): { hp: number; hc: number } {
  const e = (key: keyof IndexValues) => expectedBetween(forecast.profile, key, from, to, forecast.ev);
  return { hp: e('exportPeak') - e('importPeak'), hc: e('exportOff') - e('importOff') };
}

/**
 * Jours où calculer la limite d'une année [`from`, `end`] : chaque semaine, aux mêmes jours que la prévision (qui
 * avance de 7 jours depuis le dernier relevé), et aux relevés, pour que l'infobulle montre solde et limite ensemble.
 */
function limitDays(from: number, end: number, last: number, history: readonly BalancePoint[]): number[] {
  const days = new Set([from, end]);
  for (let day = last - 7 * Math.floor((last - from) / 7); day < end; day += 7) {
    if (day > from) {
      days.add(day);
    }
  }
  for (const p of history) {
    if (p.day > from && p.day < end) {
      days.add(p.day);
    }
  }
  return [...days].sort((a, b) => a - b);
}

/**
 * Courbe limite d'une année de facturation aux jours donnés (le dernier est la fin de l'année, où elle vaut zéro),
 * calculée en remontant depuis la fin ; le dernier point est marqué `yearEnd`.
 */
function limitCurve(forecast: Forecast, days: readonly number[], end: number): BalancePoint[] {
  const points: BalancePoint[] = [{ day: end, hp: 0, hc: 0, kind: 'yearEnd' }];
  let hp = 0;
  let hc = 0;
  for (let i = days.length - 2; i >= 0; i--) {
    const net = remainingNet(forecast, days[i]!, days[i + 1]!);
    hp += net.hp;
    hc += net.hc;
    points.push({ day: days[i]!, hp, hc });
  }
  return points.reverse();
}

/**
 * Limite d'une période sur une année, à partir de la limite exacte (ce que la suite de l'année peut encore effacer) :
 * - le **plafond** est son point le plus haut, le jour où la prévision bascule (fin d'hiver), car avant elle monte
 *   et après elle descend ;
 * - pendant l'hiver, la limite est une droite qui part de zéro à la facturation et monte jusqu'au plafond : le
 *   total à ne pas dépasser, réparti sur l'hiver, pour que le printemps et l'été fassent redescendre le solde à zéro ;
 * - après le plafond, elle suit la limite exacte jusqu'à zéro en fin d'année.
 * Sans plafond au-dessus de zéro (l'été prévu ne fait pas redescendre le solde), pas de limite : valeurs `null`.
 */
export function winterBudget(
  exact: readonly BalancePoint[],
  key: 'hp' | 'hc',
): { values: (number | null)[]; ceiling: number | null; ceilingDay: number | null } {
  const top = exact.reduce((a, b) => (b[key] > a[key] ? b : a), exact[0]!);
  if (top[key] <= 0) {
    return { values: exact.map(() => null), ceiling: null, ceilingDay: null };
  }
  const from = exact[0]!.day;
  const values = exact.map((p) =>
    p.day >= top.day || top.day <= from ? p[key] : (top[key] * (p.day - from)) / (top.day - from),
  );
  return { values, ceiling: top[key], ceilingDay: top.day };
}

export interface HeaterAllowance {
  /** Heures de radiateur que la marge permet d'ici la fin de l'année de facturation. */
  readonly hours: number;
  /** Semaines de chauffe restantes (au moins une). */
  readonly weeks: number;
  readonly hoursPerWeek: number;
  /** Fin de la période sur laquelle les heures sont réparties (fin de la saison de chauffe ou de l'année). */
  readonly until: number;
}

/**
 * Dosage d'un radiateur électrique : la marge (kWh) d'une période tarifaire en heures de fonctionnement à `powerKw`,
 * réparties sur les semaines qui restent jusqu'à la fin de la saison de chauffe (`seasonEndMonth`, 1-12, inclus), sans
 * dépasser la fin de l'année de facturation. Sans marge, aucune heure.
 */
export function heaterAllowance(
  marginKwh: number,
  powerKw: number,
  from: number,
  yearEnd: number,
  seasonEndMonth: number,
): HeaterAllowance {
  // Premier jour du mois qui suit la fin de la saison, après `from` (Date.UTC fait passer le mois 12 à janvier).
  const afterSeasonOf = (year: number) => Date.UTC(year, seasonEndMonth, 1) / MS_PER_DAY;
  const { year } = yearMonthOf(from);
  const afterSeason = afterSeasonOf(year) > from ? afterSeasonOf(year) : afterSeasonOf(year + 1);
  const until = Math.min(afterSeason, yearEnd);
  const hours = powerKw > 0 ? Math.max(0, marginKwh) / powerKw : 0;
  const weeks = Math.max(1, (until - from) / 7);
  return { hours, weeks, hoursPerWeek: hours / weeks, until };
}
