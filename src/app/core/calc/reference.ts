import {
  REGISTER_KEYS,
  pvKwp,
  type House,
  type Presence,
  type RegisterKey,
  type Settings,
} from '../models/app-data.model';
import { UCCLE_DEGREE_DAYS, UCCLE_DEGREE_DAYS_YEAR } from './degree-days';
import { smoothMonthlyProfile, type DailyProfile } from './smooth';
import { DAY_AMPLITUDE, PV_MONTH_SHAPE, clearDayPeakKw, dayMix, sunShape } from './solar';
import { daysInMonth } from './time';

export { PV_MONTH_SHAPE };

/** Valeurs mensuelles (janvier → décembre) par registre du compteur, en kWh. */
export type MonthlyByRegister = Record<RegisterKey, number[]>;

export interface ReferenceProfile {
  /** Consommation de la maison (kWh/mois), radiateur d'appoint compris, hors véhicule électrique. */
  readonly consumption: number[];
  /** Production photovoltaïque injectée par l'onduleur, après écrêtage (kWh/mois). */
  readonly production: number[];
  /** Production perdue parce que les panneaux dépassent la puissance de l'onduleur (kWh/mois). */
  readonly clipped: number[];
  /** Part de la production consommée sur place (kWh/mois). */
  readonly selfConsumed: number[];
  /** Surplus solaire consommé par le radiateur d'appoint (kWh/mois). */
  readonly heater: number[];
  /** Recharge à domicile du véhicule électrique incluse dans ce profil (kWh/mois). */
  readonly ev: number[];
  /** Profil mensuel attendu pour chacun des quatre registres du compteur. */
  readonly registers: MonthlyByRegister;
  readonly annual: {
    consumption: number;
    production: number;
    clipped: number;
    selfConsumed: number;
    heater: number;
    ev: number;
    import: number;
    export: number;
  };
}

export interface ReferenceOptions {
  /** Ajouter la recharge du véhicule électrique de la maison. */
  readonly ev?: boolean;
}

const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);

// --- Profil de consommation d'une journée ----------------------------------------------------

/** Part de la consommation qui tourne en permanence (frigo, veilles, box, circulateurs…). */
const BASE_LOAD_SHARE = 0.32;

/** Activité relative de chaque heure : pic du matin, creux de la journée, pic du soir. */
const ACTIVITY = [
  0, 0, 0, 0, 0, 0.2, 1.2, 2.4, 1.6, 0.8, 0.8, 0.8, 1.4, 0.8, 0.8, 0.8, 0.9, 2, 3.2, 3.4, 2.8, 1.8,
  0.8, 0.2,
];

/** De 9 h à 16 h, l'activité dépend de la présence à la maison. */
const DAY_PRESENCE: Record<Presence, number> = { absent: 0.2, partial: 0.6, home: 1.3 };
const DAYTIME_HOURS = [9, 10, 11, 12, 13, 14, 15, 16];

/** Part de la consommation journalière dépensée à chaque heure (somme = 1). */
export function loadShape(presence: Presence, weekend: boolean): number[] {
  const factor = DAY_PRESENCE[weekend ? 'home' : presence];
  const activity = ACTIVITY.map((a, h) => (DAYTIME_HOURS.includes(h) ? a * factor : a));
  const total = sum(activity);
  return activity.map((a) => BASE_LOAD_SHARE / 24 + ((1 - BASE_LOAD_SHARE) * a) / total);
}

export function isOffPeakHour(hour: number, weekend: boolean, settings: Settings): boolean {
  return (weekend && settings.offPeakWeekends) || settings.offPeakHours.includes(hour);
}

/** Plages horaires d'un ensemble d'heures (0-23), en tenant compte du passage par minuit : « 22 h – 7 h ». */
export function hourRanges(hours: readonly number[]): string[] {
  const set = new Set(hours);
  if (set.size === 0) {
    return [];
  }
  if (set.size === 24) {
    return ['toute la journée'];
  }
  const ranges: string[] = [];
  // On part d'une heure hors de l'ensemble pour ne jamais couper une plage qui passe par minuit.
  const start = [...Array(24).keys()].find((h) => !set.has(h))!;
  let from: number | null = null;
  for (let i = 1; i <= 24; i++) {
    const h = (start + i) % 24;
    if (set.has(h) && from === null) {
      from = h;
    }
    if (!set.has(h) && from !== null) {
      ranges.push(`${from} h – ${h} h`);
      from = null;
    }
  }
  return ranges;
}

/** Le radiateur d'appoint est-il utilisable ce mois-là (0-11) ? */
export function heaterSeasonIncludes(month: number, startMonth: number, endMonth: number): boolean {
  const m = month + 1;
  return startMonth <= endMonth
    ? m >= startMonth && m <= endMonth
    : m >= startMonth || m <= endMonth;
}

// --- Une journée type -------------------------------------------------------------------------

export interface DayInputs {
  /** Consommation de la maison heure par heure (kW). */
  readonly load: readonly number[];
  /** Production en courant continu heure par heure (kW). */
  readonly pvDc: readonly number[];
  /** Puissance maximale injectée par l'onduleur (kW). */
  readonly inverterKw: number;
  /** Radiateur d'appoint : puissance si utilisé ce jour-là, sinon `null`. */
  readonly heaterKw: number | null;
  /** Recharge du véhicule électrique à répartir sur la journée. */
  readonly ev: {
    readonly dailyKwh: number;
    readonly chargerKw: number;
    readonly nightShare: number;
  } | null;
}

export interface DayOutcome {
  readonly importKwh: number[];
  readonly exportKwh: number[];
  readonly produced: number;
  readonly clipped: number;
  readonly heater: number;
  readonly ev: number;
}

const NIGHT_CHARGE_HOURS = [23, 0, 1, 2, 3, 4, 5];
const DAY_GRID_CHARGE_HOURS = [9, 10, 11, 12, 13, 14, 15, 16];

/**
 * Bilan horaire d'une journée : le solaire alimente d'abord la maison, puis le radiateur d'appoint
 * (quand le surplus dépasse sa puissance), puis la voiture ; le reste est injecté, et le manque est soutiré.
 */
export function simulateDay(input: DayInputs): DayOutcome {
  const pvAc = input.pvDc.map((p) => Math.min(p, input.inverterKw));
  const clipped = sum(input.pvDc) - sum(pvAc);
  const heater = pvAc.map((p, h) =>
    input.heaterKw !== null && p - input.load[h]! >= input.heaterKw ? input.heaterKw : 0,
  );
  const evLoad = Array.from({ length: 24 }, () => 0);
  if (input.ev !== null && input.ev.dailyKwh > 0) {
    const night = input.ev.dailyKwh * input.ev.nightShare;
    for (const h of NIGHT_CHARGE_HOURS) {
      evLoad[h] = Math.min(night / NIGHT_CHARGE_HOURS.length, input.ev.chargerKw);
    }
    let remaining = input.ev.dailyKwh - night;
    for (let h = 0; h < 24 && remaining > 1e-9; h++) {
      const surplus = pvAc[h]! - input.load[h]! - heater[h]!;
      const take = Math.min(Math.max(0, surplus), input.ev.chargerKw, remaining);
      evLoad[h] = evLoad[h]! + take;
      remaining -= take;
    }
    // Pas assez de surplus : le reste est tiré du réseau en journée.
    for (const h of DAY_GRID_CHARGE_HOURS) {
      const take = Math.min(remaining / DAY_GRID_CHARGE_HOURS.length, input.ev.chargerKw);
      evLoad[h] = evLoad[h]! + take;
    }
  }
  const importKwh: number[] = [];
  const exportKwh: number[] = [];
  for (let h = 0; h < 24; h++) {
    const net = input.load[h]! + heater[h]! + evLoad[h]! - pvAc[h]!;
    importKwh.push(Math.max(0, net));
    exportKwh.push(Math.max(0, -net));
  }
  return {
    importKwh,
    exportKwh,
    produced: sum(pvAc),
    clipped,
    heater: sum(heater),
    ev: sum(evLoad),
  };
}

// --- Profil mensuel de référence --------------------------------------------------------------

const WEEKDAY_SHARE = 5 / 7;

/**
 * Profil de référence d'une maison belge « type » avec les réglages choisis, calculé jour type par jour type :
 * - consommation = base constante + part hivernale répartie selon les degrés-jours d'Uccle, étalée sur la journée
 *   selon la présence ; les week-ends diffèrent des jours de semaine ;
 * - production = puissance crête × rendement × forme mensuelle, répartie sur des jours dégagés, éclaircis et couverts ;
 *   l'onduleur écrête la puissance qui dépasse sa limite ;
 * - le solaire alimente d'abord la maison, puis le radiateur d'appoint, puis la voiture ; le surplus est injecté ;
 * - heures pleines / creuses : d'après l'heure à laquelle chaque kWh est soutiré ou injecté.
 */
export function referenceProfile(
  house: House,
  settings: Settings,
  options: ReferenceOptions = {},
): ReferenceProfile {
  const winter = settings.winterSharePct / 100;
  const kwp = pvKwp(house.pv);
  const inverterKw = house.pv.inverterKva;
  const heater = house.surplusHeater;
  const ev = house.ev;
  const evAnnual = options.ev
    ? ((ev.kmPerYear * ev.kWhPer100km) / 100) * (ev.homeChargingPct / 100)
    : 0;
  const nightShare = ev.chargeWindow === 'night' ? 1 : ev.chargeWindow === 'mixed' ? 0.5 : 0;

  const out = {
    consumption: Array.from({ length: 12 }, () => 0),
    production: Array.from({ length: 12 }, () => 0),
    clipped: Array.from({ length: 12 }, () => 0),
    selfConsumed: Array.from({ length: 12 }, () => 0),
    heater: Array.from({ length: 12 }, () => 0),
    ev: Array.from({ length: 12 }, () => 0),
  };
  const registers = {
    importPeak: Array.from({ length: 12 }, () => 0),
    importOff: Array.from({ length: 12 }, () => 0),
    exportPeak: Array.from({ length: 12 }, () => 0),
    exportOff: Array.from({ length: 12 }, () => 0),
  } satisfies MonthlyByRegister;

  for (let m = 0; m < 12; m++) {
    const days = daysInMonth(2025, m);
    const monthlyLoad =
      settings.referenceAnnualKwh *
      ((1 - winter) / 12 + (winter * UCCLE_DEGREE_DAYS[m]!) / UCCLE_DEGREE_DAYS_YEAR);
    const peakKw = clearDayPeakKw(m, kwp * settings.specificYieldKwhPerKwp * PV_MONTH_SHAPE[m]!);
    const shape = sunShape(m);
    const useHeater =
      heater.enabled &&
      heater.powerKw > 0 &&
      heaterSeasonIncludes(m, heater.startMonth, heater.endMonth);
    out.consumption[m] = monthlyLoad;

    for (const weekend of [false, true]) {
      const kindDays = days * (weekend ? 1 - WEEKDAY_SHARE : WEEKDAY_SHARE);
      const load = loadShape(settings.presence, weekend).map((s) => (s * monthlyLoad) / days);
      for (const { type, share } of dayMix(m)) {
        const weight = kindDays * share;
        const pvDc = shape.map((s) => s * peakKw * DAY_AMPLITUDE[type]);
        // Le radiateur n'est branché que certains jours : on pondère les deux cas.
        const usage = useHeater ? heater.usagePct / 100 : 0;
        const cases: [number, number | null][] = useHeater
          ? [
              [usage, heater.powerKw],
              [1 - usage, null],
            ]
          : [[1, null]];
        for (const [probability, heaterKw] of cases) {
          if (probability <= 0) {
            continue;
          }
          const day = simulateDay({
            load,
            pvDc,
            inverterKw,
            heaterKw,
            ev:
              evAnnual > 0
                ? { dailyKwh: evAnnual / 365, chargerKw: ev.chargerKw, nightShare }
                : null,
          });
          const w = weight * probability;
          let selfUsed = day.produced;
          for (let h = 0; h < 24; h++) {
            const off = isOffPeakHour(h, weekend, settings);
            registers[off ? 'importOff' : 'importPeak'][m]! += w * day.importKwh[h]!;
            registers[off ? 'exportOff' : 'exportPeak'][m]! += w * day.exportKwh[h]!;
            selfUsed -= day.exportKwh[h]!;
          }
          out.production[m]! += w * day.produced;
          out.clipped[m]! += w * day.clipped;
          out.selfConsumed[m]! += w * selfUsed;
          out.heater[m]! += w * day.heater;
          out.ev[m]! += w * day.ev;
        }
      }
    }
    out.consumption[m] = monthlyLoad + out.heater[m]!;
  }

  const imports = REGISTER_KEYS.filter((k) => k.startsWith('import')).flatMap((k) => registers[k]);
  const exports = REGISTER_KEYS.filter((k) => k.startsWith('export')).flatMap((k) => registers[k]);
  return {
    ...out,
    registers,
    annual: {
      consumption: sum(out.consumption),
      production: sum(out.production),
      clipped: sum(out.clipped),
      selfConsumed: sum(out.selfConsumed),
      heater: sum(out.heater),
      ev: sum(out.ev),
      import: sum(imports),
      export: sum(exports),
    },
  };
}

export function zeroRegisters(): MonthlyByRegister {
  return Object.fromEntries(
    REGISTER_KEYS.map((k) => [k, Array.from({ length: 12 }, () => 0)]),
  ) as MonthlyByRegister;
}

// --- Poids journaliers pour répartir les index entre deux relevés ----------------------------

export type SeriesWeightKey = RegisterKey | 'pv';
export type SeriesWeights = Record<SeriesWeightKey, DailyProfile>;

/** Part minimale de répartition uniforme : évite les poids nuls quand un mois attendu est vide. */
const UNIFORM_FLOOR = 0.1;

function weightProfile(monthly: readonly number[]): DailyProfile {
  const total = sum(monthly);
  const lengths = Array.from({ length: 12 }, (_, m) => daysInMonth(2025, m));
  const shape = monthly.map((v, m) =>
    total > 0
      ? (1 - UNIFORM_FLOOR) * (v / total) + (UNIFORM_FLOOR * lengths[m]!) / 365
      : lengths[m]! / 365,
  );
  return smoothMonthlyProfile(shape);
}

/**
 * Poids saisonnier de chaque jour pour chaque série, issu du profil de référence : l'augmentation d'un index entre
 * deux relevés est répartie comme le profil attendu de ce registre (soutirage et injection suivent donc la saison
 * *et* l'effet de l'autoconsommation, du radiateur ou de l'onduleur).
 */
export function seriesWeights(reference: ReferenceProfile): SeriesWeights {
  return {
    importPeak: weightProfile(reference.registers.importPeak),
    importOff: weightProfile(reference.registers.importOff),
    exportPeak: weightProfile(reference.registers.exportPeak),
    exportOff: weightProfile(reference.registers.exportOff),
    pv: weightProfile(reference.production),
  };
}
