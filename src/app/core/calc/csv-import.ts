import type { MeterReading } from '../models/app-data.model';
import { newId } from '../models/normalize';

export interface CsvError {
  /** Numéro de ligne dans le fichier (1 = première ligne). */
  readonly line: number;
  readonly message: string;
}

export interface CsvImport {
  readonly readings: MeterReading[];
  readonly errors: CsvError[];
}

/** Découpe une ligne CSV en respectant les guillemets. */
function splitLine(text: string, sep: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        current += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        current += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === sep) {
      cells.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  cells.push(current);
  return cells.map((c) => c.trim());
}

function detectSeparator(header: string): string {
  const counts = [';', '\t', ','].map((s) => ({ s, n: header.split(s).length - 1 }));
  return counts.sort((a, b) => b.n - a.n)[0]!.s;
}

/** Date `AAAA-MM-JJ[ HH:mm]` ou `JJ/MM/AAAA[ HH:mm]` (aussi avec « - » ou « . ») → `AAAA-MM-JJTHH:mm`. */
export function parseCsvDate(text: string): string | null {
  const t = text.trim();
  let y: string, m: string, d: string, rest: string;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](.*))?$/.exec(t);
  if (match) {
    [, y, m, d] = match as unknown as [string, string, string, string];
    rest = match[4] ?? '';
  } else {
    match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ T](.*))?$/.exec(t);
    if (!match) {
      return null;
    }
    [, d, m, y] = match as unknown as [string, string, string, string];
    rest = match[4] ?? '';
  }
  const time = /^(\d{1,2}):(\d{2})/.exec(rest.trim());
  const hour = time ? Number(time[1]) : 12;
  const minute = time ? Number(time[2]) : 0;
  const month = Number(m);
  const day = Number(d);
  const date = new Date(Date.UTC(Number(y), month - 1, day));
  if (month < 1 || month > 12 || date.getUTCDate() !== day || hour > 23 || minute > 59) {
    return null;
  }
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${y}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`;
}

/** Nombre belge (« 12 345,6 ») ou anglo-saxon (« 12345.6 ») ; `null` si vide, `NaN` si invalide. */
export function parseCsvNumber(text: string): number | null {
  const t = text.replace(/[\s ]/g, '').replace(/kwh$/i, '');
  if (t === '') {
    return null;
  }
  const normalized = t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t;
  return /^-?\d+(\.\d+)?$/.test(normalized) ? Number(normalized) : Number.NaN;
}

/**
 * Lit un CSV de relevés : première colonne = date, puis soutirage HP, soutirage HC, injection HP, injection HC,
 * production PV totale (optionnelle) et note (optionnelle). Une ligne d'en-têtes est reconnue et ignorée.
 * Les lignes invalides sont signalées sans bloquer les autres.
 */
export function parseReadingsCsv(content: string): CsvImport {
  const lines = content.replace(/^﻿/, '').split(/\r?\n/);
  const firstIndex = lines.findIndex((l) => l.trim() !== '');
  const first = lines[firstIndex] ?? '';
  const sep = detectSeparator(first);
  const readings: MeterReading[] = [];
  const errors: CsvError[] = [];

  lines.forEach((raw, index) => {
    if (raw.trim() === '') {
      return;
    }
    const cells = splitLine(raw, sep);
    const date = parseCsvDate(cells[0] ?? '');
    if (date === null) {
      // Une première ligne non datée est l'en-tête ; ailleurs, c'est une erreur.
      if (index !== firstIndex) {
        errors.push({ line: index + 1, message: `Date illisible : « ${cells[0] ?? ''} »` });
      }
      return;
    }
    const numbers = cells.slice(1, 6).map(parseCsvNumber);
    const required = numbers.slice(0, 4);
    if (required.length < 4 || required.some((n) => n === null)) {
      errors.push({
        line: index + 1,
        message: 'Il faut les quatre index (soutirage HP/HC, injection HP/HC).',
      });
      return;
    }
    if (numbers.some((n) => n !== null && (Number.isNaN(n) || n < 0))) {
      errors.push({ line: index + 1, message: 'Un des index n’est pas un nombre positif.' });
      return;
    }
    readings.push({
      id: newId(),
      date,
      importPeak: numbers[0]!,
      importOff: numbers[1]!,
      exportPeak: numbers[2]!,
      exportOff: numbers[3]!,
      pvTotal: numbers[4] ?? null,
      meterChange: false,
      source: 'csv',
      note: cells[6] ?? '',
    });
  });
  return { readings, errors };
}
