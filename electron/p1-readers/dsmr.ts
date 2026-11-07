import type { P1Reading } from '../shared/ipc-contract';

/**
 * Télégramme P1 (norme belge e-MUCS, dérivée de DSMR 5.0.2) : une ligne d'en-tête « /XXX5… », des lignes
 * « code OBIS(valeur*unité) », puis « !CRC ». Le CRC-16 (polynôme 0xA001, valeur initiale 0) couvre tout, de « / »
 * à « ! » compris.
 *
 * En Belgique, le tarif 1 est le tarif de jour (heures pleines) et le tarif 2 celui de nuit (heures creuses), à
 * l'inverse des Pays-Bas.
 */

/** CRC-16/ARC du télégramme. */
export function dsmrCrc(text: string): number {
  let crc = 0;
  for (const byte of Buffer.from(text, 'latin1')) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }
  return crc;
}

/** Télégramme complet extrait d'un flux : du dernier « / » avant « ! » jusqu'au CRC ; `null` s'il n'est pas complet. */
export function extractTelegram(buffer: string): { telegram: string; rest: string } | null {
  const end = buffer.search(/![0-9A-Fa-f]{4}/);
  if (end < 0) {
    return null;
  }
  const start = buffer.lastIndexOf('/', end);
  const stop = end + 5;
  const rest = buffer.slice(stop);
  if (start < 0) {
    // Fin d'un télégramme commencé avant la connexion : on le saute.
    return extractTelegram(rest);
  }
  return { telegram: buffer.slice(start, stop), rest };
}

/** Le CRC du télégramme est-il juste ? Les anciens compteurs (DSMR 2/3) n'en ont pas : accepté. */
export function telegramCrcOk(telegram: string): boolean {
  const match = /!([0-9A-Fa-f]{4})\s*$/.exec(telegram);
  if (!match) {
    return /!\s*$/.test(telegram);
  }
  const body = telegram.slice(0, telegram.lastIndexOf('!') + 1);
  return dsmrCrc(body) === parseInt(match[1]!, 16);
}

/** Valeurs par code OBIS (premier groupe entre parenthèses, sans unité). */
export function obisValues(telegram: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of telegram.split(/\r?\n/)) {
    const match = /^(\d+-\d+:\d+\.\d+\.\d+)\(([^)]*)\)/.exec(line.trim());
    if (match) {
      values.set(match[1]!, match[2]!);
    }
  }
  return values;
}

/** Nombre d'une valeur OBIS « 001234.567*kWh » ; facteur 1000 pour des kW → W. */
const numberOf = (raw: string | undefined): number | null => {
  if (raw === undefined) {
    return null;
  }
  const v = Number(raw.split('*')[0]);
  return Number.isFinite(v) ? v : null;
};

const round3 = (v: number | null): number | null =>
  v === null ? null : Math.round(v * 1000) / 1000;

/** Lecture du compteur tirée d'un télégramme dont le CRC a été vérifié. */
export function parseTelegram(telegram: string, at: number): P1Reading | null {
  const v = obisValues(telegram);
  const importPeak = round3(numberOf(v.get('1-0:1.8.1')));
  const importOff = round3(numberOf(v.get('1-0:1.8.2')));
  const exportPeak = round3(numberOf(v.get('1-0:2.8.1')));
  const exportOff = round3(numberOf(v.get('1-0:2.8.2')));
  const importKw = numberOf(v.get('1-0:1.7.0'));
  const exportKw = numberOf(v.get('1-0:2.7.0'));
  if ([importPeak, importOff, exportPeak, exportOff, importKw].every((x) => x === null)) {
    return null;
  }
  const tariffRaw = numberOf(v.get('0-0:96.14.0'));
  const demandKw = numberOf(v.get('1-0:1.4.0'));
  const header = /^\/(\S+)/.exec(telegram.trim())?.[1] ?? null;
  return {
    at,
    powerW:
      importKw === null && exportKw === null
        ? null
        : Math.round(((importKw ?? 0) - (exportKw ?? 0)) * 1000),
    quarterHourAvgW: demandKw === null ? null : Math.round(demandKw * 1000),
    tariff: tariffRaw === 1 || tariffRaw === 2 ? tariffRaw : null,
    importPeak,
    importOff,
    exportPeak,
    exportOff,
    meterModel: header,
    error: null,
  };
}
