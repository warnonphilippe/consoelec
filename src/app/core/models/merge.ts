import type { AnnualBill, AppData, House, MeterReading, PvDay } from './app-data.model';

export interface MergeReport {
  /** Relevés du fichier ajoutés aux données locales. */
  readonly addedReadings: number;
  /** Relevés du fichier déjà présents localement (identiques) : ignorés. */
  readonly duplicateReadings: number;
  /** Relevés présents des deux côtés mais modifiés différemment : la version locale est conservée. */
  readonly conflicts: number;
  /** Jours de production (onduleur) ajoutés ou complétés par une lecture plus récente. */
  readonly addedPvDays: number;
  /** Factures annuelles du fichier ajoutées (périodes absentes localement). */
  readonly addedBills: number;
  /** La maison du fichier a été reprise (la maison locale n’avait jamais été modifiée). */
  readonly houseAdopted: boolean;
  /** La description de la maison du fichier diffère de la locale (la locale est conservée). */
  readonly houseDiffers: boolean;
}

export interface MergeResult {
  readonly data: AppData;
  readonly report: MergeReport;
}

/**
 * Fusionne des données importées (export JSON d'un autre ordinateur ou CSV) dans les données locales.
 * Rien de local n'est modifié ni supprimé : seuls les relevés absents sont ajoutés.
 * Un relevé est « déjà présent » s'il a le même identifiant, ou la même date et les mêmes index
 * (même relevé encodé séparément sur les deux ordinateurs).
 * La maison du fichier n'est reprise que si la maison locale est encore celle par défaut (jamais modifiée).
 */
export function mergeData(
  local: AppData,
  incoming: AppData,
  localHouseIsDefault = false,
): MergeResult {
  const byId = new Map(local.readings.map((r) => [r.id, r]));
  const keys = new Set(local.readings.map(readingKey));
  const readings = [...local.readings];
  let added = 0;
  let duplicates = 0;
  let conflicts = 0;

  for (const item of incoming.readings) {
    const existing = byId.get(item.id);
    if (existing) {
      if (sameReading(existing, item)) {
        duplicates++;
      } else {
        conflicts++;
      }
      continue;
    }
    if (keys.has(readingKey(item))) {
      duplicates++;
      continue;
    }
    readings.push(item);
    byId.set(item.id, item);
    keys.add(readingKey(item));
    added++;
  }

  const pv = mergePvDaily(local.pvDaily, incoming.pvDaily);
  const bills = mergeBills(local.annualBills, incoming.annualBills);
  const houseAdopted = localHouseIsDefault && !sameHouse(local.house, incoming.house);
  const houseDiffers = !localHouseIsDefault && !sameHouse(local.house, incoming.house);
  return {
    data: {
      ...local,
      house: houseAdopted ? incoming.house : local.house,
      readings,
      pvDaily: pv.list,
      annualBills: bills.list,
    },
    report: {
      addedReadings: added,
      duplicateReadings: duplicates,
      conflicts,
      addedPvDays: pv.added,
      addedBills: bills.added,
      houseAdopted,
      houseDiffers,
    },
  };
}

/** Factures annuelles : celles d'une période absente localement sont ajoutées ; les locales ne changent pas. */
function mergeBills(local: AnnualBill[], incoming: AnnualBill[]): { list: AnnualBill[]; added: number } {
  const periods = new Set(local.map((b) => `${b.from}|${b.to}`));
  const list = [...local];
  for (const bill of incoming) {
    if (!periods.has(`${bill.from}|${bill.to}`)) {
      list.push(bill);
      periods.add(`${bill.from}|${bill.to}`);
    }
  }
  return { list: list.sort((a, b) => a.from.localeCompare(b.from)), added: list.length - local.length };
}

/** Production par jour : on garde, pour chaque jour, la lecture la plus tardive (la plus complète). */
function mergePvDaily(local: PvDay[], incoming: PvDay[]): { list: PvDay[]; added: number } {
  const byDate = new Map(local.map((d) => [d.date, d]));
  let added = 0;
  for (const day of incoming) {
    const existing = byDate.get(day.date);
    if (!existing || existing.at < day.at) {
      byDate.set(day.date, day);
      added++;
    }
  }
  return { list: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)), added };
}

const readingKey = (r: MeterReading): string =>
  `${r.date}|${r.importPeak}|${r.importOff}|${r.exportPeak}|${r.exportOff}`;

const sameReading = (a: MeterReading, b: MeterReading): boolean =>
  readingKey(a) === readingKey(b) && a.pvTotal === b.pvTotal && a.note === b.note;

function sameHouse(a: House, b: House): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
