import { pvKwp, type House, type MeterReading, type Settings } from '../models/app-data.model';
import { newId } from '../models/normalize';
import { UCCLE_DEGREE_DAYS, UCCLE_DEGREE_DAYS_YEAR } from './degree-days';
import {
  PV_MONTH_SHAPE,
  heaterSeasonIncludes,
  isOffPeakHour,
  loadShape,
  simulateDay,
} from './reference';
import { DAY_AMPLITUDE, clearDayPeakKw, sunShape, type DayType } from './solar';
import { daysInMonth } from './time';

/**
 * Simulateur de maison jour par jour, avec météo aléatoire, consommation irrégulière, radiateur d'appoint et voiture.
 * Il sert de « vérité terrain » pour vérifier les calculs du profil de référence (tests) et à fabriquer les
 * données de démonstration. Il partage la physique du modèle (`simulateDay`) mais pas ses moyennes : chaque jour
 * est tiré au hasard, au lieu d'être un jour type.
 */

export interface SimConfig {
  readonly house: House;
  readonly settings: Settings;
  /** Premier jour simulé, `AAAA-MM-JJ`. */
  readonly start: string;
  readonly days: number;
  readonly seed: number;
  /** Multiplie la consommation de référence (1 = comme la référence). */
  readonly consumptionScale?: number;
  /** Multiplie la production (météo de l'année plus ou moins ensoleillée). */
  readonly solarScale?: number;
  /** Jour (numéro d'ordre depuis le début) à partir duquel la voiture électrique est utilisée ; `null` = jamais. */
  readonly evFromDay?: number | null;
}

export interface SimDay {
  readonly date: string;
  readonly importPeak: number;
  readonly importOff: number;
  readonly exportPeak: number;
  readonly exportOff: number;
  /** Production après écrêtage. */
  readonly production: number;
  readonly clipped: number;
  readonly heater: number;
  readonly ev: number;
  /** Consommation de la maison, radiateur et voiture compris. */
  readonly consumption: number;
}

/** Générateur pseudo-aléatoire reproductible (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MS_PER_DAY = 86_400_000;

const pad = (n: number): string => String(n).padStart(2, '0');

function dateOf(startMs: number, index: number): { iso: string; month: number; weekend: boolean } {
  const d = new Date(startMs + index * MS_PER_DAY);
  const dow = d.getUTCDay();
  return {
    iso: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    month: d.getUTCMonth(),
    weekend: dow === 0 || dow === 6,
  };
}

export function simulateHouse(config: SimConfig): SimDay[] {
  const { house, settings } = config;
  const rand = mulberry32(config.seed);
  const startMs = Date.parse(`${config.start}T00:00:00Z`);
  const consumptionScale = config.consumptionScale ?? 1;
  const solarScale = config.solarScale ?? 1;
  const kwp = pvKwp(house.pv);
  const winter = settings.winterSharePct / 100;
  const heater = house.surplusHeater;
  const evAnnual =
    ((house.ev.kmPerYear * house.ev.kWhPer100km) / 100) * (house.ev.homeChargingPct / 100);
  const nightShare =
    house.ev.chargeWindow === 'night' ? 1 : house.ev.chargeWindow === 'mixed' ? 0.5 : 0;

  const result: SimDay[] = [];
  for (let i = 0; i < config.days; i++) {
    const { iso, month, weekend } = dateOf(startMs, i);
    const length = daysInMonth(2025, month);

    // Météo du jour : type tiré selon les fréquences du mois, puissance variable, nuages qui passent.
    const clearShare = [0.1, 0.14, 0.2, 0.27, 0.28, 0.28, 0.32, 0.3, 0.24, 0.16, 0.09, 0.08][
      month
    ]!;
    const partlyShare = [0.17, 0.22, 0.3, 0.35, 0.38, 0.38, 0.38, 0.36, 0.33, 0.27, 0.2, 0.17][
      month
    ]!;
    const draw = rand();
    const type: DayType =
      draw < clearShare ? 'clear' : draw < clearShare + partlyShare ? 'partly' : 'overcast';
    const jitter =
      type === 'clear'
        ? 0.93 + rand() * 0.14
        : type === 'partly'
          ? 0.8 + rand() * 0.4
          : 0.6 + rand() * 0.8;
    const peakKw =
      clearDayPeakKw(month, kwp * settings.specificYieldKwhPerKwp * PV_MONTH_SHAPE[month]!) *
      DAY_AMPLITUDE[type] *
      jitter *
      solarScale;
    const shape = sunShape(month);
    const pvDc = shape.map((s) => {
      const flicker =
        type === 'partly' ? 0.55 + rand() * 0.9 : type === 'overcast' ? 0.8 + rand() * 0.4 : 1;
      return s * peakKw * flicker;
    });

    // Consommation du jour : énergie variable, répartie au hasard sur les heures, plus un gros appareil.
    const monthlyLoad =
      settings.referenceAnnualKwh *
      consumptionScale *
      ((1 - winter) / 12 + (winter * UCCLE_DEGREE_DAYS[month]!) / UCCLE_DEGREE_DAYS_YEAR);
    const dayEnergy = (monthlyLoad / length) * Math.exp((rand() - 0.5) * 0.4);
    const appliance = rand() < (weekend ? 0.6 : 0.4) ? Math.min(2.5, dayEnergy * 0.3) : 0;
    const applianceHour = 9 + Math.floor(rand() * 7);
    const noisy = loadShape(settings.presence, weekend).map((s) => s * (0.6 + rand() * 0.8));
    const noisySum = noisy.reduce((a, b) => a + b, 0);
    const load = noisy.map(
      (s, h) =>
        (s / noisySum) * (dayEnergy - appliance) +
        (h === applianceHour || h === applianceHour + 1 ? appliance / 2 : 0),
    );

    const useHeater =
      heater.enabled &&
      heater.powerKw > 0 &&
      heaterSeasonIncludes(month, heater.startMonth, heater.endMonth) &&
      rand() < heater.usagePct / 100;
    const evActive = config.evFromDay != null && i >= config.evFromDay && evAnnual > 0;
    const evToday = evActive && rand() < 0.6 ? (evAnnual / 365 / 0.6) * (0.6 + rand() * 0.8) : 0;

    const day = simulateDay({
      load,
      pvDc,
      inverterKw: house.pv.inverterKva,
      heaterKw: useHeater ? heater.powerKw : null,
      ev: evToday > 0 ? { dailyKwh: evToday, chargerKw: house.ev.chargerKw, nightShare } : null,
    });
    let importPeak = 0;
    let importOff = 0;
    let exportPeak = 0;
    let exportOff = 0;
    for (let h = 0; h < 24; h++) {
      if (isOffPeakHour(h, weekend, settings)) {
        importOff += day.importKwh[h]!;
        exportOff += day.exportKwh[h]!;
      } else {
        importPeak += day.importKwh[h]!;
        exportPeak += day.exportKwh[h]!;
      }
    }
    result.push({
      date: iso,
      importPeak,
      importOff,
      exportPeak,
      exportOff,
      production: day.produced,
      clipped: day.clipped,
      heater: day.heater,
      ev: day.ev,
      consumption: dayEnergy + day.heater + day.ev,
    });
  }
  return result;
}

export interface ReadingPlan {
  /** Dates de relevé `AAAA-MM-JJ` (les relevés sont pris à minuit, ou à l'heure donnée par `hour`). */
  readonly dates: readonly string[];
  /** Heure du relevé (0-23) ; l'index est interpolé linéairement dans la journée. */
  readonly hour?: number;
  /** Index du compteur au premier jour simulé. */
  readonly initial?: {
    importPeak: number;
    importOff: number;
    exportPeak: number;
    exportOff: number;
    pv: number;
  };
  /** Encoder aussi l'index de production. */
  readonly withPv?: boolean;
}

/** Index du compteur aux dates de relevé, d'après la simulation. */
export function readingsFrom(days: readonly SimDay[], plan: ReadingPlan): MeterReading[] {
  const initial = plan.initial ?? {
    importPeak: 1000,
    importOff: 600,
    exportPeak: 500,
    exportOff: 200,
    pv: 800,
  };
  const hour = plan.hour ?? 0;
  const cumulative = { ...initial };
  const byDate = new Map<string, MeterReading>();
  const wanted = new Set(plan.dates);
  for (const day of days) {
    if (wanted.has(day.date)) {
      const f = hour / 24;
      byDate.set(day.date, {
        id: newId(),
        date: `${day.date}T${pad(hour)}:00`,
        importPeak: round(cumulative.importPeak + f * day.importPeak),
        importOff: round(cumulative.importOff + f * day.importOff),
        exportPeak: round(cumulative.exportPeak + f * day.exportPeak),
        exportOff: round(cumulative.exportOff + f * day.exportOff),
        pvTotal: plan.withPv ? round(cumulative.pv + f * day.production) : null,
        meterChange: false,
        source: 'manual',
        note: '',
      });
    }
    cumulative.importPeak += day.importPeak;
    cumulative.importOff += day.importOff;
    cumulative.exportPeak += day.exportPeak;
    cumulative.exportOff += day.exportOff;
    cumulative.pv += day.production;
  }
  return plan.dates.map((d) => byDate.get(d)).filter((r): r is MeterReading => r !== undefined);
}

const round = (v: number): number => Math.round(v * 100) / 100;

/** Dates `AAAA-MM-JJ` tous les `step` jours à partir de `start`, `count` fois. */
export function regularDates(start: string, count: number, step: number): string[] {
  const startMs = Date.parse(`${start}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) =>
    new Date(startMs + i * step * MS_PER_DAY).toISOString().slice(0, 10),
  );
}

/** Premier jour de chaque mois, `count` fois à partir du mois de `start`. */
export function monthlyDates(start: string, count: number, dayOfMonth = 1): string[] {
  const [y, m] = start.split('-').map(Number) as [number, number];
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 + i, dayOfMonth));
    return d.toISOString().slice(0, 10);
  });
}
