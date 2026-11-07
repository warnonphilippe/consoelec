import type { MeterProfileDay } from '../models/app-data.model';
import { detectSeparator, parseCsvDate, parseCsvNumber, splitLine } from './csv-import';
import {
  MINUTES_PER_DAY,
  MINUTES_PER_QUARTER,
  addSamples,
  dateOfDayIndex,
  minuteOf,
  pad,
  type IndexSample,
} from './meter-profile';

export interface HomeWizardImport {
  /** Index lus, par journée. */
  readonly days: MeterProfileDay[];
  /** Lignes lues. */
  readonly rows: number;
  /** Première et dernière heure lues (`AAAA-MM-JJTHH:mm`), ou `null`. */
  readonly from: string | null;
  readonly to: string | null;
  /** Export journalier (un index par jour) : totaux par jour seulement, pas de détail dans la journée. */
  readonly daily: boolean;
  readonly error: string | null;
}

/**
 * Lit l'export de l'app HomeWizard Energy (Réglages › Graphiques › graphique › Exporter les données) :
 * une colonne d'heure puis les index cumulés `Import T1 kWh`, `Import T2 kWh`, `Export T1 kWh`, `Export T2 kWh`
 * (d'autres colonnes, comme les puissances maximales par phase, sont ignorées). Export au quart d'heure ou par jour.
 */
export function parseHomeWizardCsv(content: string): HomeWizardImport {
  const fail = (error: string): HomeWizardImport => ({ days: [], rows: 0, from: null, to: null, daily: false, error });
  const lines = content.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = lines[0];
  if (header === undefined) {
    return fail('Fichier vide.');
  }
  const sep = detectSeparator(header);
  const names = splitLine(header, sep).map((h) => h.toLowerCase());
  const energy = (word: string): number[] =>
    names.flatMap((h, i) => (h.includes(word) && /kwh/.test(h) ? [i] : []));
  const imports = energy('import');
  const exports = energy('export');
  const timeCol = names.findIndex((h) => /time|tijd|date|datum|heure/.test(h));
  if (imports.length === 0 || exports.length === 0 || timeCol < 0) {
    return fail(
      "Ce n'est pas un export HomeWizard : colonnes « time », « Import … kWh » et « Export … kWh » attendues.",
    );
  }
  const samples: IndexSample[] = [];
  for (const line of lines.slice(1)) {
    const cells = splitLine(line, sep);
    const at = parseCsvDate(cells[timeCol] ?? '');
    const sum = (cols: number[]): number | null => {
      let total = 0;
      for (const c of cols) {
        const v = parseCsvNumber(cells[c] ?? '');
        if (v === null || Number.isNaN(v)) {
          return null;
        }
        total += v;
      }
      return total;
    };
    const imp = sum(imports);
    const exp = sum(exports);
    const minute = at === null ? Number.NaN : minuteOf(at);
    if (imp === null || exp === null || !Number.isFinite(minute) || minute % MINUTES_PER_QUARTER !== 0) {
      continue;
    }
    samples.push({ minute, importWh: Math.round(imp * 1000), exportWh: Math.round(exp * 1000), estimated: false });
  }
  if (samples.length === 0) {
    return fail("Aucune ligne lisible dans l'export HomeWizard.");
  }
  samples.sort((a, b) => a.minute - b.minute);
  const toIso = (minute: number): string => {
    const date = dateOfDayIndex(Math.floor(minute / MINUTES_PER_DAY));
    const m = minute % MINUTES_PER_DAY;
    return `${date}T${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  };
  return {
    days: addSamples([], samples),
    rows: samples.length,
    from: toIso(samples[0]!.minute),
    to: toIso(samples.at(-1)!.minute),
    daily: samples.every((s) => s.minute % MINUTES_PER_DAY === 0),
    error: null,
  };
}
