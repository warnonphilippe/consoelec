import type { MeterReading } from '../models/app-data.model';
import type { ConsumptionAnalysis, Interval } from './consumption';
import type { YearRow } from './stats';
import { MONTH_SHORT } from './time';

/** CSV au format attendu par Excel en Belgique : séparateur « ; », virgule décimale. */
const SEP = ';';

const cell = (value: string | number | null): string => {
  if (value === null) {
    return '';
  }
  const text =
    typeof value === 'number'
      ? Number.isFinite(value)
        ? String(value).replace('.', ',')
        : ''
      : value;
  return /[;"\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const line = (values: (string | number | null)[]): string => values.map(cell).join(SEP);

const round = (v: number, d = 1): number => Math.round(v * 10 ** d) / 10 ** d;

/** En-têtes du CSV de relevés ; le format est relu tel quel par `parseReadingsCsv`. */
export const READINGS_CSV_HEADER = [
  'Date',
  'Soutirage HP (kWh)',
  'Soutirage HC (kWh)',
  'Injection HP (kWh)',
  'Injection HC (kWh)',
  'Production PV totale (kWh)',
  'Note',
] as const;

/** CSV des relevés bruts, réimportable (colonnes : date, 4 index, production PV, note). */
export function readingsCsv(readings: MeterReading[]): string {
  const rows = readings
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((r) =>
      line([
        r.date.replace('T', ' '),
        r.importPeak,
        r.importOff,
        r.exportPeak,
        r.exportOff,
        r.pvTotal,
        r.note,
      ]),
    );
  return [line([...READINGS_CSV_HEADER]), ...rows].join('\r\n');
}

/** CSV d'analyse : consommation entre relevés, avec alertes. Non réimportable. */
export function intervalsCsv(analysis: ConsumptionAnalysis): string {
  const label = (i: Interval): string => i.anomalies.map((a) => ANOMALY_LABELS[a]).join(', ');
  const rows = analysis.intervals.map((i) =>
    line([
      i.to.reading.date.replace('T', ' '),
      round(i.days),
      i.delta.importPeak === null ? null : round(i.delta.importPeak),
      i.delta.importOff === null ? null : round(i.delta.importOff),
      i.delta.exportPeak === null ? null : round(i.delta.exportPeak),
      i.delta.exportOff === null ? null : round(i.delta.exportOff),
      label(i),
    ]),
  );
  return [
    line([
      'Relevé',
      'Jours depuis le précédent',
      'Soutirage HP (kWh)',
      'Soutirage HC (kWh)',
      'Injection HP (kWh)',
      'Injection HC (kWh)',
      'Alerte',
    ]),
    ...rows,
  ].join('\r\n');
}

export function monthlyCsv(rows: YearRow[]): string {
  const out: string[] = [
    line([
      'Mois',
      'Soutirage HP (kWh)',
      'Soutirage HC (kWh)',
      'Injection HP (kWh)',
      'Injection HC (kWh)',
      'Production PV (kWh)',
      'Mois complet',
    ]),
  ];
  for (const row of rows) {
    row.months.forEach((b, m) => {
      if (b) {
        out.push(
          line([
            `${MONTH_SHORT[m]} ${row.year}`,
            round(b.values.importPeak, 0),
            round(b.values.importOff, 0),
            round(b.values.exportPeak, 0),
            round(b.values.exportOff, 0),
            b.pvComplete ? round(b.values.pv, 0) : null,
            b.complete ? 'oui' : 'non',
          ]),
        );
      }
    });
  }
  return out.join('\r\n');
}

export const ANOMALY_LABELS = {
  decrease: 'index en baisse',
  spike: 'valeur aberrante',
  long: 'longue période sans relevé',
  'same-time': 'deux relevés à la même minute',
  'meter-change': 'nouveau compteur',
} as const;
