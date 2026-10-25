import {
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
  type MeterReading,
  type Presence,
  type Pv,
  type ReadingSource,
  type ReferencePreset,
  type Settings,
  type SurplusHeater,
} from './app-data.model';

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
  if (!isObject(input) || !('settings' in input || 'readings' in input || 'house' in input)) {
    throw new Error('Ce fichier ne contient pas de données ConsoElec.');
  }
  const base = emptyData();
  return {
    schemaVersion: 1,
    house: isObject(input['house']) ? normalizeHouse(input['house']) : base.house,
    readings: asArray(input['readings'])
      .map(normalizeReading)
      .filter((r): r is MeterReading => r !== null),
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
    offPeakStartHour: hour(raw['offPeakStartHour'], DEFAULT_SETTINGS.offPeakStartHour),
    offPeakEndHour: hour(raw['offPeakEndHour'], DEFAULT_SETTINGS.offPeakEndHour),
    offPeakWeekends: bool(raw['offPeakWeekends'], DEFAULT_SETTINGS.offPeakWeekends),
    specificYieldKwhPerKwp: Math.max(
      0,
      num(raw['specificYieldKwhPerKwp'], DEFAULT_SETTINGS.specificYieldKwhPerKwp),
    ),
    theme:
      theme === 'light' || theme === 'dark' || theme === 'system' ? theme : DEFAULT_SETTINGS.theme,
    aiModel:
      model.length > 0 && model.length < 80
        ? model
        : (AI_MODELS[0]?.id ?? DEFAULT_SETTINGS.aiModel),
  };
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

function hour(value: unknown, fallback: number): number {
  return Math.round(clamp(num(value, fallback), 0, 23));
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
