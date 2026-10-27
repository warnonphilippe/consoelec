import {
  LEGACY_OFF_PEAK,
  pvKwp,
  type AnnualBill,
  type AppData,
  type Settings,
} from '../models/app-data.model';
import { expectedDailyProduction, productionDays } from './production';
import { measuredYield } from './pv-yield';
import { referenceProfile, type ReferenceProfile } from './reference';
import type { DailyProfile } from './smooth';
import { toDayNumber } from './time';

/**
 * Historique annuel de la maison, d'après les factures de régularisation : le solde facturé (soutirage − injection)
 * plus la production de l'onduleur sur la même période donne la consommation réelle de la maison, année par année.
 * Ces années calent la consommation de référence des prévisions, la moyenne belge ne servant plus que d'appoint.
 */

const DAYS_PER_YEAR = 365.25;
/** Une année de facture compte deux fois moins tous les deux ans d'ancienneté. */
const HALF_LIFE_YEARS = 2;
/** Poids de la moyenne belge, en années de facture équivalentes. */
const BELGIAN_WEIGHT = 0.5;
/** Il faut un an de journal de l'onduleur pour remplacer le rendement réglé par le rendement mesuré. */
const MIN_YIELD_DAYS = 365;

export type BillProduction = 'none' | 'measured' | 'estimated';

export interface BillYear {
  readonly bill: AnnualBill;
  readonly days: number;
  /** Production des panneaux sur la période (kWh). */
  readonly production: number;
  /** `none` : pas encore de panneaux ; `estimated` : une partie vient du modèle, faute de journal de l'onduleur. */
  readonly productionStatus: BillProduction;
  /** Consommation de la maison sur la période : solde jour + nuit + production (kWh). */
  readonly consumption: number;
  /** La même, ramenée à une année de 365,25 jours. */
  readonly consumptionPerYear: number;
  /** Soldes jour / nuit que donne le modèle calé pour cette période, avec l'horaire de la facture (contrôle). */
  readonly model: { readonly netPeak: number; readonly netOff: number } | null;
}

export interface HouseBaseline {
  /** Consommation annuelle retenue pour la maison (kWh), radiateur d'appoint compris. */
  readonly annualKwh: number;
  readonly years: number;
  readonly minKwh: number;
  readonly maxKwh: number;
  /** Moyenne belge utilisée en appoint, et sa part dans la valeur retenue (%). */
  readonly belgianKwh: number;
  readonly belgianSharePct: number;
}

export interface AnnualHistory {
  readonly years: BillYear[];
  readonly baseline: HouseBaseline;
  /** Rendement mesuré sur le journal de l'onduleur (kWh/kWc/an), s'il couvre au moins un an. */
  readonly measuredYield: number | null;
  /** Réglages de la référence « maison » : consommation et rendement de la maison. */
  readonly settings: Settings;
  readonly reference: ReferenceProfile;
}

/**
 * Production et consommation de chaque facture. `days` : production jour par jour (journal de l'onduleur) ;
 * `expected` : production attendue par jour, pour les jours avec panneaux que le journal ne couvre pas ;
 * `pvStart` : premier jour de production (`null` : pas de panneaux).
 */
export function billYears(
  bills: readonly AnnualBill[],
  days: readonly { day: number; kwh: number }[],
  expected: DailyProfile,
  pvStart: number | null,
): Omit<BillYear, 'model'>[] {
  const byDay = new Map(days.map((d) => [d.day, d.kwh]));
  return bills.map((bill) => {
    const from = toDayNumber(bill.from);
    const to = toDayNumber(bill.to);
    let production = 0;
    let estimated = false;
    if (pvStart !== null) {
      for (let day = Math.max(from, Math.floor(pvStart)); day < to; day++) {
        const measured = byDay.get(day);
        if (measured === undefined) {
          production += expected(day);
          estimated = true;
        } else {
          production += measured;
        }
      }
    }
    const status: BillProduction =
      pvStart === null || pvStart >= to ? 'none' : estimated ? 'estimated' : 'measured';
    const consumption = bill.netPeak + bill.netOff + production;
    const length = to - from;
    return {
      bill,
      days: length,
      production,
      productionStatus: status,
      consumption,
      consumptionPerYear: length > 0 ? (consumption * DAYS_PER_YEAR) / length : consumption,
    };
  });
}

/**
 * Consommation annuelle de la maison : moyenne des années facturées, les plus récentes pesant davantage (demi-vie de
 * deux ans), avec la moyenne belge en appoint (poids d'une demi-année).
 */
export function houseBaseline(
  years: readonly { bill: AnnualBill; consumptionPerYear: number }[],
  belgianKwh: number,
  now: number,
): HouseBaseline | null {
  const usable = years.filter((y) => Number.isFinite(y.consumptionPerYear) && y.consumptionPerYear > 0);
  if (usable.length === 0) {
    return null;
  }
  let weighted = BELGIAN_WEIGHT * belgianKwh;
  let total = BELGIAN_WEIGHT;
  for (const y of usable) {
    const age = Math.max(0, (now - toDayNumber(y.bill.to)) / DAYS_PER_YEAR);
    const w = 0.5 ** (age / HALF_LIFE_YEARS);
    weighted += w * y.consumptionPerYear;
    total += w;
  }
  const values = usable.map((y) => y.consumptionPerYear);
  return {
    annualKwh: weighted / total,
    years: usable.length,
    minKwh: Math.min(...values),
    maxKwh: Math.max(...values),
    belgianKwh,
    belgianSharePct: (BELGIAN_WEIGHT / total) * 100,
  };
}

/**
 * Historique annuel et référence « maison » calée dessus, ou `null` sans facture. `belgian` : référence des réglages
 * (profil belge type).
 */
export function annualHistory(
  data: AppData,
  belgian: ReferenceProfile,
  now: number,
): AnnualHistory | null {
  if (data.annualBills.length === 0) {
    return null;
  }
  const { house, settings } = data;
  const expected = expectedDailyProduction(belgian);
  const days = productionDays(data.pvDaily, data.readings, expected, now);
  const installed = house.pv.installDate ? toDayNumber(house.pv.installDate) : Number.NaN;
  const pvStart =
    days[0]?.day ?? (Number.isFinite(installed) && pvKwp(house.pv) > 0 ? installed : null);
  const partial = billYears(data.annualBills, days, expected, pvStart);
  const baseline = houseBaseline(partial, settings.referenceAnnualKwh, now);
  if (baseline === null) {
    return null;
  }

  const kwp = pvKwp(house.pv);
  const yieldResult = measuredYield(data.pvDaily, belgian, kwp);
  const measured = yieldResult && yieldResult.days >= MIN_YIELD_DAYS ? yieldResult.kwhPerKwp : null;
  const withYield: Settings = {
    ...settings,
    specificYieldKwhPerKwp: measured ?? settings.specificYieldKwhPerKwp,
  };
  // Le radiateur d'appoint fait déjà partie de la consommation facturée : le modèle l'ajoute de lui-même.
  const heater = referenceProfile(house, withYield).annual.heater;
  const houseSettings: Settings = {
    ...withYield,
    referenceAnnualKwh: Math.max(500, baseline.annualKwh - heater),
  };
  const reference = referenceProfile(house, houseSettings);

  // Contrôle : soldes jour / nuit du modèle calé, avec l'horaire de chaque facture, pour une année de production
  // mesurée (ou sans panneaux).
  const legacy = referenceProfile(house, {
    ...houseSettings,
    offPeakHours: [...LEGACY_OFF_PEAK],
    offPeakWeekends: true,
  });
  const noPv = referenceProfile({ ...house, pv: { ...house.pv, panelCount: 0 } }, houseSettings);
  const noPvLegacy = referenceProfile(
    { ...house, pv: { ...house.pv, panelCount: 0 } },
    { ...houseSettings, offPeakHours: [...LEGACY_OFF_PEAK], offPeakWeekends: true },
  );
  const years: BillYear[] = partial.map((y) => {
    const profile =
      y.productionStatus === 'none'
        ? y.bill.schedule === 'legacy'
          ? noPvLegacy
          : noPv
        : y.productionStatus === 'measured'
          ? y.bill.schedule === 'legacy'
            ? legacy
            : reference
          : null;
    if (profile === null) {
      return { ...y, model: null };
    }
    const scale = y.days / DAYS_PER_YEAR;
    const sum = (values: readonly number[]) => values.reduce((s, v) => s + v, 0) * scale;
    const r = profile.registers;
    return {
      ...y,
      model: {
        netPeak: sum(r.importPeak) - sum(r.exportPeak),
        netOff: sum(r.importOff) - sum(r.exportOff),
      },
    };
  });

  return { years, baseline, measuredYield: measured, settings: houseSettings, reference };
}
