import type { MonthBucket } from '../../core/calc/consumption';
import type { ReferenceProfile } from '../../core/calc/reference';
import { derive } from '../../core/calc/stats';

export type MetricKey = 'import' | 'export' | 'net' | 'production' | 'house';

export interface Metric {
  readonly key: MetricKey;
  readonly label: string;
  /** Nécessite l'index de production totale. */
  readonly needsPv: boolean;
}

export const METRICS: readonly Metric[] = [
  { key: 'import', label: 'Soutirage', needsPv: false },
  { key: 'export', label: 'Injection', needsPv: false },
  { key: 'net', label: 'Solde net', needsPv: false },
  { key: 'production', label: 'Production PV', needsPv: true },
  { key: 'house', label: 'Consommation maison', needsPv: true },
];

/** Valeur d'un mois pour l'indicateur choisi, ou `null` si elle n'est pas connue. */
export function metricValue(metric: MetricKey, bucket: MonthBucket): number | null {
  const needsPv = metric === 'production' || metric === 'house';
  if (needsPv && !bucket.pvComplete) {
    return null;
  }
  const d = derive(bucket.values, needsPv);
  switch (metric) {
    case 'import':
      return d.import;
    case 'export':
      return d.export;
    case 'net':
      return d.net;
    case 'production':
      return d.production;
    case 'house':
      return d.houseConsumption;
  }
}

/** Valeur mensuelle de la référence belge pour l'indicateur choisi. */
export function referenceValue(metric: MetricKey, ref: ReferenceProfile, month: number): number {
  const imp = ref.registers.importPeak[month]! + ref.registers.importOff[month]!;
  const exp = ref.registers.exportPeak[month]! + ref.registers.exportOff[month]!;
  switch (metric) {
    case 'import':
      return imp;
    case 'export':
      return exp;
    case 'net':
      return imp - exp;
    case 'production':
      return ref.production[month]!;
    case 'house':
      return ref.consumption[month]!;
  }
}

/** Moyenne des mois complets de chaque mois du calendrier. */
export function monthAverages(metric: MetricKey, months: MonthBucket[]): (number | null)[] {
  return Array.from({ length: 12 }, (_, m) => {
    const values = months
      .filter((b) => b.month === m && b.complete)
      .map((b) => metricValue(metric, b))
      .filter((v): v is number => v !== null);
    return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;
  });
}
