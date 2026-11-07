/**
 * Données de la vidéo de présentation : les deux ans de relevés de démo de l'application, complétés de ce qu'auraient
 * enregistré le lecteur P1 et l'onduleur (production jour par jour, journal quotidien des index) jusqu'à hier.
 * La journée en cours est simulée dans la page par `fake-api.js`. Compilé par esbuild depuis `record.mjs`.
 */
import { buildDemoData } from '../../src/app/core/calc/demo-data';
import { simulateHouse } from '../../src/app/core/calc/house-simulator';
import type {
  AppData,
  MeterLogPoint,
  MeterProfileDay,
  PvDay,
} from '../../src/app/core/models/app-data.model';

/** Jours de journal P1 gardés avant aujourd'hui (le lecteur a été installé il y a quelques semaines). */
const P1_LOG_DAYS = 45;
/** Jours passés dont le profil au quart d'heure est connu (le lecteur tourne depuis ; l'historique HomeWizard l'a complété). */
const PROFILE_DAYS = 30;

export interface VideoScenario {
  readonly data: AppData;
  /** Index du compteur à minuit (kWh), point de départ de la journée simulée dans la page. */
  readonly midnight: {
    importPeak: number;
    importOff: number;
    exportPeak: number;
    exportOff: number;
  };
  /** Index de production de l'onduleur à minuit (kWh). */
  readonly pvMidnightKwh: number;
}

const pad = (n: number): string => String(n).padStart(2, '0');
const isoDay = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/** Bruit déterministe dans [0, 1). */
const noise = (k: number): number => {
  const x = Math.sin(k * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
};

/** Répartit l'énergie d'une heure sur ses 4 quarts d'heure, avec de l'irrégularité (la somme reste exacte). */
function quarterSplit(kwh: number, seed: number): number[] {
  const weights = [0, 1, 2, 3].map((q) => 0.55 + noise(seed + q * 7.31) * 0.9);
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => (kwh * w) / total);
}

export function buildScenario(now: Date): VideoScenario {
  const demo = buildDemoData(now);

  // Même simulation que `buildDemoData` (même graine) : on y relit chaque journée.
  const firstMonth = new Date(now.getFullYear() - 2, now.getMonth(), 1);
  const start = isoDay(firstMonth);
  const days = Math.ceil((now.getTime() - firstMonth.getTime()) / 86_400_000) + 1;
  const sim = simulateHouse({
    house: demo.house,
    settings: demo.settings,
    start,
    days,
    seed: 42,
    consumptionScale: 1.12,
  });

  const today = isoDay(now);
  const cumulative = {
    importPeak: 18450,
    importOff: 11200,
    exportPeak: 9800,
    exportOff: 3100,
    pv: 21000,
  };
  const pvDaily: PvDay[] = [];
  const logDays: MeterLogPoint[] = [];
  const profile: MeterProfileDay[] = [];
  const past = sim.filter((d) => d.date < today);
  past.forEach((d, i) => {
    if (i >= past.length - PROFILE_DAYS) {
      // Index totaux (Wh) au début de chaque quart d'heure : mesurés, chaînés d'un jour à l'autre.
      let imp = (cumulative.importPeak + cumulative.importOff) * 1000;
      let exp = (cumulative.exportPeak + cumulative.exportOff) * 1000;
      const importWh: number[] = [];
      const exportWh: number[] = [];
      for (let h = 0; h < 24; h++) {
        const qi = quarterSplit(d.hourlyImport[h]! * 1000, i * 101 + h * 3);
        const qe = quarterSplit(d.hourlyExport[h]! * 1000, i * 101 + h * 3 + 1);
        for (let q = 0; q < 4; q++) {
          importWh.push(Math.round(imp));
          exportWh.push(Math.round(exp));
          imp += qi[q]!;
          exp += qe[q]!;
        }
      }
      profile.push({ date: d.date, importWh, exportWh, estimated: [] });
    }
    cumulative.importPeak += d.importPeak;
    cumulative.importOff += d.importOff;
    cumulative.exportPeak += d.exportPeak;
    cumulative.exportOff += d.exportOff;
    cumulative.pv += d.production;
    pvDaily.push({
      date: d.date,
      dayKwh: round3(d.production),
      totalKwh: round3(cumulative.pv),
      at: `${d.date}T22:30`,
    });
    if (i >= past.length - P1_LOG_DAYS) {
      logDays.push({
        at: `${d.date}T23:59`,
        importPeak: round3(cumulative.importPeak),
        importOff: round3(cumulative.importOff),
        exportPeak: round3(cumulative.exportPeak),
        exportOff: round3(cumulative.exportOff),
      });
    }
  });

  const data: AppData = {
    ...demo,
    house: { ...demo.house, name: 'Maison de démo' },
    pvDaily,
    meterLog: { minutes: [], hours: [], days: logDays },
    meterProfile: profile,
    settings: {
      ...demo.settings,
      theme: 'dark',
      p1: { enabled: true, host: 'p1meter-1A2B3C.local' },
      inverter: {
        enabled: true,
        host: 'SMA3012345678.local',
        certFingerprint:
          'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89',
      },
    },
  };
  return {
    data,
    midnight: {
      importPeak: round3(cumulative.importPeak),
      importOff: round3(cumulative.importOff),
      exportPeak: round3(cumulative.exportPeak),
      exportOff: round3(cumulative.exportOff),
    },
    pvMidnightKwh: round3(cumulative.pv),
  };
}
