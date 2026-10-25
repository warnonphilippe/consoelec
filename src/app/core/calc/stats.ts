import { REGISTER_KEYS, type RegisterKey } from '../models/app-data.model';
import type { MonthBucket, Values } from './consumption';
import type { ReferenceProfile } from './reference';

/** Indicateurs calculés à partir des index du compteur (et de la production totale si elle est connue). */
export interface Derived {
  /** Soutirage total (kWh). */
  readonly import: number;
  /** Injection totale (kWh). */
  readonly export: number;
  /** Soutirage − injection : positif = la maison a pris plus qu'elle n'a rendu. */
  readonly net: number;
  /** Part du soutirage faite en heures creuses (0-100). */
  readonly offPeakPct: number | null;
  readonly production: number | null;
  readonly selfConsumed: number | null;
  /** Consommation réelle de la maison = soutirage + autoconsommation. */
  readonly houseConsumption: number | null;
  /** Part de la production consommée sur place (0-100). */
  readonly selfConsumptionPct: number | null;
  /** Part de la consommation couverte par le solaire (0-100). */
  readonly autarkyPct: number | null;
}

export function derive(values: Values, withPv: boolean): Derived {
  const imp = values.importPeak + values.importOff;
  const exp = values.exportPeak + values.exportOff;
  const production = withPv ? values.pv : null;
  const self = production !== null ? Math.max(0, production - exp) : null;
  const house = self !== null ? imp + self : null;
  return {
    import: imp,
    export: exp,
    net: imp - exp,
    offPeakPct: imp > 0 ? (values.importOff / imp) * 100 : null,
    production,
    selfConsumed: self,
    houseConsumption: house,
    selfConsumptionPct:
      production !== null && production > 0 && self !== null ? (self / production) * 100 : null,
    autarkyPct: house !== null && house > 0 && self !== null ? (self / house) * 100 : null,
  };
}

export interface YearRow {
  readonly year: number;
  readonly months: (MonthBucket | null)[];
  readonly totals: Values;
  /** Les douze mois sont entièrement couverts. */
  readonly complete: boolean;
  /** Tous les mois présents sont couverts à la fois par les registres et par l'index de production. */
  readonly pvConsistent: boolean;
}

export function yearRows(months: MonthBucket[]): YearRow[] {
  const byYear = new Map<number, (MonthBucket | null)[]>();
  for (const bucket of months) {
    const row = byYear.get(bucket.year) ?? Array.from({ length: 12 }, () => null);
    row[bucket.month] = bucket;
    byYear.set(bucket.year, row);
  }
  return [...byYear.entries()]
    .sort(([a], [b]) => a - b)
    .map(([year, cells]) => {
      const totals: Values = { importPeak: 0, importOff: 0, exportPeak: 0, exportOff: 0, pv: 0 };
      for (const cell of cells) {
        if (cell) {
          for (const key of [...REGISTER_KEYS, 'pv'] as const) {
            totals[key] += cell.values[key];
          }
        }
      }
      const present = cells.filter((c): c is MonthBucket => c !== null);
      return {
        year,
        months: cells,
        totals,
        complete: cells.every((c) => c?.complete === true),
        pvConsistent: present.length > 0 && present.every((c) => c.complete && c.pvComplete),
      };
    });
}

export interface MonthAverages {
  /** Moyenne des mois complets pour chaque registre (kWh), `null` si aucun mois complet. */
  readonly registers: Record<RegisterKey, (number | null)[]>;
  /** Nombre de mois complets pris en compte, par mois du calendrier. */
  readonly counts: number[];
}

export function monthlyAverages(months: MonthBucket[]): MonthAverages {
  const registers = Object.fromEntries(
    REGISTER_KEYS.map((k) => [k, Array.from({ length: 12 }, (): number | null => null)]),
  ) as Record<RegisterKey, (number | null)[]>;
  const counts = Array.from({ length: 12 }, () => 0);
  for (let m = 0; m < 12; m++) {
    const complete = months.filter((b) => b.month === m && b.complete);
    counts[m] = complete.length;
    if (complete.length > 0) {
      for (const key of REGISTER_KEYS) {
        registers[key][m] = complete.reduce((s, b) => s + b.values[key], 0) / complete.length;
      }
    }
  }
  return { registers, counts };
}

export type SeasonKey = 'winter' | 'spring' | 'summer' | 'autumn';

export const SEASONS: readonly { key: SeasonKey; label: string; months: readonly number[] }[] = [
  { key: 'winter', label: 'Hiver', months: [11, 0, 1] },
  { key: 'spring', label: 'Printemps', months: [2, 3, 4] },
  { key: 'summer', label: 'Été', months: [5, 6, 7] },
  { key: 'autumn', label: 'Automne', months: [8, 9, 10] },
];

export function seasonOfMonth(month: number): SeasonKey {
  return SEASONS.find((s) => s.months.includes(month))!.key;
}

export interface SeasonAggregate {
  /** Moyenne par mois de la saison (sur les mois disponibles). */
  readonly averageMonthly: number | null;
  /** Total de la saison si les trois mois ont une moyenne. */
  readonly averageTotal: number | null;
  readonly referenceTotal: number;
}

export interface SeasonStat {
  readonly key: SeasonKey;
  readonly label: string;
  readonly months: readonly number[];
  readonly import: SeasonAggregate;
  readonly export: SeasonAggregate;
}

export function seasonStats(averages: MonthAverages, reference: ReferenceProfile): SeasonStat[] {
  const monthly = (kind: 'import' | 'export', m: number): number | null => {
    const keys: RegisterKey[] =
      kind === 'import' ? ['importPeak', 'importOff'] : ['exportPeak', 'exportOff'];
    const parts = keys.map((k) => averages.registers[k][m]);
    return parts.every((p) => p !== null) ? parts.reduce((s, p) => s + p!, 0) : null;
  };
  const refMonthly = (kind: 'import' | 'export', m: number): number =>
    kind === 'import'
      ? reference.registers.importPeak[m]! + reference.registers.importOff[m]!
      : reference.registers.exportPeak[m]! + reference.registers.exportOff[m]!;

  const aggregate = (kind: 'import' | 'export', months: readonly number[]): SeasonAggregate => {
    const values = months.map((m) => monthly(kind, m)).filter((v): v is number => v !== null);
    return {
      averageMonthly: values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null,
      averageTotal: values.length === months.length ? values.reduce((a, b) => a + b, 0) : null,
      referenceTotal: months.reduce((s, m) => s + refMonthly(kind, m), 0),
    };
  };
  return SEASONS.map((s) => ({
    key: s.key,
    label: s.label,
    months: s.months,
    import: aggregate('import', s.months),
    export: aggregate('export', s.months),
  }));
}
