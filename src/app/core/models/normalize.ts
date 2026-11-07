import {
  type AnnualBill,
  AI_MODELS,
  DEFAULT_EV,
  DEFAULT_HOUSE,
  DEFAULT_PV,
  DEFAULT_SETTINGS,
  DEFAULT_SURPLUS_HEATER,
  emptyData,
  type AppData,
  type ChargeWindow,
  type ElectricVehicle,
  type EvMode,
  type House,
  type InverterSettings,
  type MeterLog,
  type MeterLogPoint,
  type MeterProfileDay,
  type P1Settings,
  REGISTER_KEYS,
  type MeterReading,
  type Presence,
  type PvDay,
  type Pv,
  type ReadingSource,
  type ReferencePreset,
  type Settings,
  type SurplusHeater,
} from './app-data.model';
import { normalizeDashboard } from './dashboard';
import { QUARTERS_PER_DAY, profileFromLog, pruneProfile } from '../calc/meter-profile';

type Raw = Record<string, unknown>;

const DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?/;
const SOURCES: readonly ReadingSource[] = ['manual', 'photo', 'csv'];
const PRESETS: readonly ReferencePreset[] = ['sober', 'average', 'high', 'custom'];
const EV_MODES: readonly EvMode[] = ['none', 'planned', 'owned'];
const WINDOWS: readonly ChargeWindow[] = ['night', 'day', 'mixed'];
const PRESENCES: readonly Presence[] = ['absent', 'partial', 'home'];

/**
 * Valide et complète des données lues sur disque ou importées : champs manquants remplacés
 * par leurs valeurs par défaut, entrées invalides écartées.
 * Lève une erreur si le contenu n'a manifestement rien à voir avec ConsoElec.
 */
export function normalizeData(input: unknown): AppData {
  if (
    !isObject(input) ||
    !(
      'settings' in input ||
      'readings' in input ||
      'house' in input ||
      'pvDaily' in input ||
      'annualBills' in input
    )
  ) {
    throw new Error('Ce fichier ne contient pas de données ConsoElec.');
  }
  const base = emptyData();
  const meterLog = normalizeMeterLog(input['meterLog']);
  return {
    schemaVersion: 1,
    house: isObject(input['house']) ? normalizeHouse(input['house']) : base.house,
    readings: asArray(input['readings'])
      .map(normalizeReading)
      .filter((r): r is MeterReading => r !== null),
    pvDaily: normalizePvDaily(input['pvDaily']),
    annualBills: normalizeAnnualBills(input['annualBills']),
    meterLog,
    // Premier chargement avec le profil au quart d'heure : il est tiré du journal P1 existant.
    meterProfile:
      'meterProfile' in input
        ? normalizeMeterProfile(input['meterProfile'])
        : profileFromLog(meterLog),
    settings: isObject(input['settings']) ? normalizeSettings(input['settings']) : base.settings,
  };
}

export function normalizeReading(raw: unknown): MeterReading | null {
  if (!isObject(raw) || !DATE_RE.test(str(raw['date'], ''))) {
    return null;
  }
  const values = [raw['importPeak'], raw['importOff'], raw['exportPeak'], raw['exportOff']].map(
    (v) => num(v, Number.NaN),
  );
  if (values.some((v) => !Number.isFinite(v) || v < 0)) {
    return null;
  }
  const pv = num(raw['pvTotal'], Number.NaN);
  const source = raw['source'];
  return {
    id: str(raw['id'], newId()),
    date: normalizeDate(str(raw['date'], '')),
    importPeak: values[0]!,
    importOff: values[1]!,
    exportPeak: values[2]!,
    exportOff: values[3]!,
    pvTotal: Number.isFinite(pv) && pv >= 0 ? pv : null,
    meterChange: bool(raw['meterChange'], false),
    source: SOURCES.includes(source as ReadingSource) ? (source as ReadingSource) : 'manual',
    note: str(raw['note'], ''),
  };
}

function normalizePv(raw: Raw): Pv {
  // Anciens fichiers : seule la puissance crête totale était connue.
  const legacyKwp = num(raw['kWp'], Number.NaN);
  const hasPanels = 'panelCount' in raw;
  const panelWp = Math.max(50, num(raw['panelWp'], DEFAULT_PV.panelWp));
  const panelCount =
    !hasPanels && Number.isFinite(legacyKwp)
      ? Math.max(0, Math.round((legacyKwp * 1000) / panelWp))
      : Math.max(0, Math.round(num(raw['panelCount'], DEFAULT_PV.panelCount)));
  return {
    panelCount,
    panelWp,
    inverterKva: Math.max(0.5, num(raw['inverterKva'], DEFAULT_PV.inverterKva)),
    inverterPhases: num(raw['inverterPhases'], DEFAULT_PV.inverterPhases) === 1 ? 1 : 3,
    inverterModel: str(raw['inverterModel'], DEFAULT_PV.inverterModel),
    orientation: str(raw['orientation'], DEFAULT_PV.orientation),
    tiltDeg: num(raw['tiltDeg'], DEFAULT_PV.tiltDeg),
    installDate: str(raw['installDate'], ''),
  };
}

function normalizeHeater(raw: Raw): SurplusHeater {
  return {
    enabled: bool(raw['enabled'], DEFAULT_SURPLUS_HEATER.enabled),
    powerKw: clamp(num(raw['powerKw'], DEFAULT_SURPLUS_HEATER.powerKw), 0, 20),
    startMonth: Math.round(clamp(num(raw['startMonth'], DEFAULT_SURPLUS_HEATER.startMonth), 1, 12)),
    endMonth: Math.round(clamp(num(raw['endMonth'], DEFAULT_SURPLUS_HEATER.endMonth), 1, 12)),
    usagePct: clamp(num(raw['usagePct'], DEFAULT_SURPLUS_HEATER.usagePct), 0, 100),
  };
}

function normalizeHouse(raw: Raw): House {
  const heating = isObject(raw['heating']) ? raw['heating'] : {};
  return {
    name: str(raw['name'], DEFAULT_HOUSE.name),
    persons: Math.max(1, Math.round(num(raw['persons'], DEFAULT_HOUSE.persons))),
    areaM2: Math.max(0, num(raw['areaM2'], DEFAULT_HOUSE.areaM2)),
    pv: normalizePv(isObject(raw['pv']) ? raw['pv'] : {}),
    surplusHeater: normalizeHeater(isObject(raw['surplusHeater']) ? raw['surplusHeater'] : {}),
    heating: {
      oilBoiler: bool(heating['oilBoiler'], DEFAULT_HOUSE.heating.oilBoiler),
      woodStove: bool(heating['woodStove'], DEFAULT_HOUSE.heating.woodStove),
      note: str(heating['note'], DEFAULT_HOUSE.heating.note),
    },
    ev: normalizeEv(isObject(raw['ev']) ? raw['ev'] : {}),
  };
}

function normalizeEv(raw: Raw): ElectricVehicle {
  return {
    mode: EV_MODES.includes(raw['mode'] as EvMode) ? (raw['mode'] as EvMode) : DEFAULT_EV.mode,
    startDate: str(raw['startDate'], ''),
    kmPerYear: Math.max(0, num(raw['kmPerYear'], DEFAULT_EV.kmPerYear)),
    kWhPer100km: Math.max(0, num(raw['kWhPer100km'], DEFAULT_EV.kWhPer100km)),
    homeChargingPct: clamp(num(raw['homeChargingPct'], DEFAULT_EV.homeChargingPct), 0, 100),
    chargeWindow: WINDOWS.includes(raw['chargeWindow'] as ChargeWindow)
      ? (raw['chargeWindow'] as ChargeWindow)
      : DEFAULT_EV.chargeWindow,
    chargerKw: clamp(num(raw['chargerKw'], DEFAULT_EV.chargerKw), 1.4, 22),
  };
}

function normalizeSettings(raw: Raw): Settings {
  const preset = raw['referencePreset'];
  const theme = raw['theme'];
  const presence = raw['presence'];
  const model = str(raw['aiModel'], DEFAULT_SETTINGS.aiModel);
  return {
    referencePreset: PRESETS.includes(preset as ReferencePreset)
      ? (preset as ReferencePreset)
      : DEFAULT_SETTINGS.referencePreset,
    referenceAnnualKwh: Math.max(
      0,
      num(raw['referenceAnnualKwh'], DEFAULT_SETTINGS.referenceAnnualKwh),
    ),
    winterSharePct: clamp(num(raw['winterSharePct'], DEFAULT_SETTINGS.winterSharePct), 0, 100),
    presence: PRESENCES.includes(presence as Presence)
      ? (presence as Presence)
      : DEFAULT_SETTINGS.presence,
    offPeakHours: offPeakHours(raw),
    offPeakWeekends: bool(raw['offPeakWeekends'], DEFAULT_SETTINGS.offPeakWeekends),
    specificYieldKwhPerKwp: Math.max(
      0,
      num(raw['specificYieldKwhPerKwp'], DEFAULT_SETTINGS.specificYieldKwhPerKwp),
    ),
    billingStart: monthDay(raw['billingStart'], DEFAULT_SETTINGS.billingStart),
    priceHp: clamp(num(raw['priceHp'], DEFAULT_SETTINGS.priceHp), 0, 2),
    priceHc: clamp(num(raw['priceHc'], DEFAULT_SETTINGS.priceHc), 0, 2),
    theme:
      theme === 'light' || theme === 'dark' || theme === 'system' ? theme : DEFAULT_SETTINGS.theme,
    aiModel:
      model.length > 0 && model.length < 80
        ? model
        : (AI_MODELS[0]?.id ?? DEFAULT_SETTINGS.aiModel),
    inverter: normalizeInverter(raw['inverter']),
    p1: normalizeP1(raw['p1']),
    dashboard: normalizeDashboard(raw['dashboard']),
  };
}

/** `MM-JJ` valide (le 29 février est ramené au 28), sinon la valeur par défaut. */
function monthDay(value: unknown, fallback: string): string {
  const match = typeof value === 'string' ? /^(\d{2})-(\d{2})$/.exec(value) : null;
  if (!match) {
    return fallback;
  }
  const month = Number(match[1]);
  const day = Number(match[2]);
  const max = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (max === undefined || day < 1 || day > (month === 2 ? 29 : max)) {
    return fallback;
  }
  return month === 2 && day === 29 ? '02-28' : value as string;
}

function normalizePvDaily(value: unknown): PvDay[] {
  const byDate = new Map<string, PvDay>();
  for (const raw of asArray(value)) {
    if (!isObject(raw)) {
      continue;
    }
    const date = str(raw['date'], '');
    const dayKwh = num(raw['dayKwh'], Number.NaN);
    const totalKwh = num(raw['totalKwh'], Number.NaN);
    const at = str(raw['at'], '');
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !(dayKwh >= 0) ||
      !(totalKwh >= 0) ||
      !DATE_RE.test(at)
    ) {
      continue;
    }
    const entry: PvDay = { date, dayKwh, totalKwh, at: at.slice(0, 16) };
    const existing = byDate.get(date);
    if (!existing || existing.at < entry.at) {
      byDate.set(date, entry);
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Factures annuelles valides (période cohérente, soldes chiffrés), une par période, triées. */
function normalizeAnnualBills(value: unknown): AnnualBill[] {
  const byPeriod = new Map<string, AnnualBill>();
  for (const raw of asArray(value)) {
    if (!isObject(raw)) {
      continue;
    }
    const from = str(raw['from'], '');
    const to = str(raw['to'], '');
    const netPeak = num(raw['netPeak'], Number.NaN);
    const netOff = num(raw['netOff'], Number.NaN);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(to) ||
      !(to > from) ||
      !Number.isFinite(netPeak) ||
      !Number.isFinite(netOff)
    ) {
      continue;
    }
    byPeriod.set(`${from}|${to}`, {
      id: str(raw['id'], '') || newId(),
      from,
      to,
      netPeak,
      netOff,
      schedule: raw['schedule'] === 'current' ? 'current' : 'legacy',
      note: str(raw['note'], ''),
    });
  }
  return [...byPeriod.values()].sort((a, b) => a.from.localeCompare(b.from));
}

function normalizeInverter(raw: unknown): InverterSettings {
  const r = isObject(raw) ? raw : {};
  const fp = r['certFingerprint'];
  return {
    enabled: bool(r['enabled'], DEFAULT_SETTINGS.inverter.enabled),
    host: str(r['host'], DEFAULT_SETTINGS.inverter.host).trim(),
    certFingerprint: typeof fp === 'string' && /^[0-9A-Fa-f:]{64,95}$/.test(fp) ? fp : null,
  };
}

function normalizeP1(raw: unknown): P1Settings {
  const r = isObject(raw) ? raw : {};
  return {
    enabled: bool(r['enabled'], DEFAULT_SETTINGS.p1.enabled),
    host: str(r['host'], DEFAULT_SETTINGS.p1.host).trim(),
  };
}

/** Points valides (heure à la minute, quatre index positifs), triés, un seul par heure de lecture. */
function normalizeLogPoints(raw: unknown): MeterLogPoint[] {
  const byAt = new Map<string, MeterLogPoint>();
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!isObject(item) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(str(item['at'], ''))) {
      continue;
    }
    const values = REGISTER_KEYS.map((k) => num(item[k], Number.NaN));
    if (values.some((v) => !Number.isFinite(v) || v < 0)) {
      continue;
    }
    const [importPeak, importOff, exportPeak, exportOff] = values as [
      number,
      number,
      number,
      number,
    ];
    const at = str(item['at'], '');
    byAt.set(at, { at, importPeak, importOff, exportPeak, exportOff });
  }
  return [...byAt.values()].sort((a, b) => a.at.localeCompare(b.at));
}

function normalizeMeterLog(raw: unknown): MeterLog {
  const r = isObject(raw) ? raw : {};
  return {
    minutes: normalizeLogPoints(r['minutes']),
    hours: normalizeLogPoints(r['hours']),
    days: normalizeLogPoints(r['days']),
  };
}

/** Index d'un quart d'heure : entier positif (Wh) ou `null`. */
function profileValues(raw: unknown): (number | null)[] {
  const values = Array.isArray(raw) ? raw : [];
  return Array.from({ length: QUARTERS_PER_DAY }, (_, q) => {
    const v = values[q];
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
  });
}

/** Journées valides du profil au quart d'heure, triées, une seule par date. */
function normalizeMeterProfile(raw: unknown): MeterProfileDay[] {
  const byDate = new Map<string, MeterProfileDay>();
  for (const item of Array.isArray(raw) ? raw : []) {
    const date = isObject(item) ? str(item['date'], '') : '';
    if (!isObject(item) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      continue;
    }
    const importWh = profileValues(item['importWh']);
    const exportWh = profileValues(item['exportWh']);
    // Un index n'a de sens qu'avec son pendant : soutirage et injection lus ensemble.
    for (let q = 0; q < QUARTERS_PER_DAY; q++) {
      if (importWh[q] === null || exportWh[q] === null) {
        importWh[q] = null;
        exportWh[q] = null;
      }
    }
    const estimated = (Array.isArray(item['estimated']) ? item['estimated'] : []).filter(
      (q): q is number => Number.isInteger(q) && q >= 0 && q < QUARTERS_PER_DAY && importWh[q as number] !== null,
    );
    byDate.set(date, { date, importWh, exportWh, estimated: [...new Set(estimated)].sort((a, b) => a - b) });
  }
  return pruneProfile([...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)));
}

export function newId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}

/** `YYYY-MM-DD` → `YYYY-MM-DDT12:00` ; sinon tronqué à la minute. */
export function normalizeDate(value: string): string {
  return value.length === 10 ? `${value}T12:00` : value.slice(0, 16);
}

function isObject(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Heures creuses : liste d'heures, ou ancienne plage de nuit « début-fin » convertie en liste. */
function offPeakHours(raw: Raw): number[] {
  const list = raw['offPeakHours'];
  if (Array.isArray(list)) {
    const hours = list.filter((h): h is number => Number.isInteger(h) && h >= 0 && h <= 23);
    return [...new Set(hours)].sort((a, b) => a - b);
  }
  const start = num(raw['offPeakStartHour'], Number.NaN);
  const end = num(raw['offPeakEndHour'], Number.NaN);
  if (Number.isFinite(start) && Number.isFinite(end)) {
    const s = Math.round(clamp(start, 0, 23));
    const e = Math.round(clamp(end, 0, 23));
    return Array.from({ length: 24 }, (_, h) => h).filter((h) =>
      s > e ? h >= s || h < e : h >= s && h < e,
    );
  }
  return [...DEFAULT_SETTINGS.offPeakHours];
}

function num(value: unknown, fallback: number): number {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  const n = typeof value === 'string' ? Number(value.replace(/\s/g, '').replace(',', '.')) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
