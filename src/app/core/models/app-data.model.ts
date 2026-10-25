import type { ThemeMode } from '../../../../electron/shared/ipc-contract';

export type { ThemeMode };

/** Les quatre registres du compteur intelligent (index cumulés, en kWh). */
export type RegisterKey = 'importPeak' | 'importOff' | 'exportPeak' | 'exportOff';

export interface RegisterInfo {
  readonly key: RegisterKey;
  /** Code OBIS affiché par le compteur. */
  readonly code: string;
  readonly label: string;
  readonly short: string;
  readonly direction: 'import' | 'export';
  readonly tariff: 'peak' | 'off';
}

export const REGISTERS: readonly RegisterInfo[] = [
  {
    key: 'importPeak',
    code: '1.8.1',
    label: 'Soutirage heures pleines',
    short: 'Soutirage HP',
    direction: 'import',
    tariff: 'peak',
  },
  {
    key: 'importOff',
    code: '1.8.2',
    label: 'Soutirage heures creuses',
    short: 'Soutirage HC',
    direction: 'import',
    tariff: 'off',
  },
  {
    key: 'exportPeak',
    code: '2.8.1',
    label: 'Injection heures pleines',
    short: 'Injection HP',
    direction: 'export',
    tariff: 'peak',
  },
  {
    key: 'exportOff',
    code: '2.8.2',
    label: 'Injection heures creuses',
    short: 'Injection HC',
    direction: 'export',
    tariff: 'off',
  },
] as const;

export const REGISTER_KEYS: readonly RegisterKey[] = REGISTERS.map((r) => r.key);

export type ReadingSource = 'manual' | 'photo' | 'csv';

/**
 * Relevé du compteur à une date : les quatre index cumulés (kWh) et, en option,
 * l'index de production photovoltaïque totale lu sur l'onduleur ou le compteur de production.
 */
export interface MeterReading {
  id: string;
  /** Date et heure locales, format `YYYY-MM-DDTHH:mm`. */
  date: string;
  importPeak: number;
  importOff: number;
  exportPeak: number;
  exportOff: number;
  pvTotal: number | null;
  /** Premier relevé d'un nouveau compteur (ses index repartent de zéro) : l'intervalle depuis le relevé précédent est ignoré. */
  meterChange: boolean;
  source: ReadingSource;
  note: string;
}

export type EvMode = 'none' | 'planned' | 'owned';
export type ChargeWindow = 'night' | 'day' | 'mixed';

export interface ElectricVehicle {
  mode: EvMode;
  /** Date d'achat (réelle ou prévue), `YYYY-MM-DD`, ou chaîne vide. */
  startDate: string;
  kmPerYear: number;
  kWhPer100km: number;
  /** Part de la recharge faite à la maison (0-100 %). */
  homeChargingPct: number;
  chargeWindow: ChargeWindow;
  /** Puissance de la borne ou de la prise de recharge (kW). */
  chargerKw: number;
}

/** Radiateur électrique d'appoint branché de temps en temps pour consommer le surplus solaire. */
export interface SurplusHeater {
  enabled: boolean;
  powerKw: number;
  /** Mois de début et de fin de la période de chauffe (1-12) ; si le début dépasse la fin, la période enjambe le nouvel an. */
  startMonth: number;
  endMonth: number;
  /** Part des jours où le radiateur est effectivement branché sur le surplus (0-100 %). */
  usagePct: number;
}

export interface Pv {
  panelCount: number;
  /** Puissance d'un panneau (Wc). */
  panelWp: number;
  /** Puissance apparente de l'onduleur (kVA) : au-delà, la production est écrêtée. */
  inverterKva: number;
  inverterPhases: 1 | 3;
  inverterModel: string;
  orientation: string;
  tiltDeg: number;
  /** `YYYY-MM-DD` ou chaîne vide. */
  installDate: string;
}

/** Puissance crête installée (kWc). */
export function pvKwp(pv: Pick<Pv, 'panelCount' | 'panelWp'>): number {
  return (pv.panelCount * pv.panelWp) / 1000;
}

export interface House {
  name: string;
  persons: number;
  areaM2: number;
  pv: Pv;
  surplusHeater: SurplusHeater;
  heating: {
    oilBoiler: boolean;
    woodStove: boolean;
    note: string;
  };
  ev: ElectricVehicle;
}

export type ReferencePreset = 'sober' | 'average' | 'high' | 'custom';

/** Présence en journée : détermine la part de la consommation qui coïncide avec la production solaire. */
export type Presence = 'absent' | 'partial' | 'home';

export interface Settings {
  referencePreset: ReferencePreset;
  /** Consommation annuelle de référence de la maison (kWh), hors véhicule électrique. */
  referenceAnnualKwh: number;
  /** Part de la consommation qui suit l'hiver (éclairage, auxiliaires du chauffage), 0-100 %. */
  winterSharePct: number;
  presence: Presence;
  /**
   * Heures creuses : liste des heures (0-23) comptées au tarif « nuit » (T2), tous les jours.
   * 13 signifie de 13 h à 14 h. En Wallonie depuis 2026 : 22 h-7 h et 11 h-17 h.
   */
  offPeakHours: number[];
  /** Les week-ends sont entièrement en heures creuses (ancien bihoraire). */
  offPeakWeekends: boolean;
  /** Production annuelle par kWc installé, avant écrêtage de l'onduleur (kWh/kWc). */
  specificYieldKwhPerKwp: number;
  theme: ThemeMode;
  /** Modèle Claude utilisé par l'assistant et la lecture de photo. */
  aiModel: string;
}

export interface AppData {
  schemaVersion: 1;
  house: House;
  readings: MeterReading[];
  settings: Settings;
}

export const REFERENCE_PRESETS: Record<
  Exclude<ReferencePreset, 'custom'>,
  { label: string; kwh: number }
> = {
  sober: { label: 'Ménage sobre', kwh: 2800 },
  average: { label: 'Ménage moyen (4 personnes)', kwh: 3500 },
  high: { label: 'Ménage énergivore', kwh: 4500 },
};

export const AI_MODELS: readonly { id: string; label: string }[] = [
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (équilibré)' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (le plus précis)' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (rapide, économique)' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
];

export const DEFAULT_AI_MODEL = 'claude-sonnet-5-5';

/** Heures creuses du bihoraire wallon depuis le 1er janvier 2026 : 22 h-7 h et 11 h-17 h, tous les jours. */
export const WALLONIA_2026_OFF_PEAK: readonly number[] = [
  0, 1, 2, 3, 4, 5, 6, 11, 12, 13, 14, 15, 16, 22, 23,
];

/** Ancien bihoraire : 22 h-7 h en semaine, week-ends entiers. */
export const LEGACY_OFF_PEAK: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 22, 23];

export const DEFAULT_SETTINGS: Settings = {
  referencePreset: 'average',
  referenceAnnualKwh: 3500,
  winterSharePct: 30,
  presence: 'partial',
  offPeakHours: [...WALLONIA_2026_OFF_PEAK],
  offPeakWeekends: false,
  specificYieldKwhPerKwp: 900,
  theme: 'system',
  aiModel: DEFAULT_AI_MODEL,
};

export const DEFAULT_EV: ElectricVehicle = {
  mode: 'none',
  startDate: '',
  kmPerYear: 15000,
  kWhPer100km: 17,
  homeChargingPct: 80,
  chargeWindow: 'night',
  chargerKw: 7.4,
};

export const DEFAULT_PV: Pv = {
  panelCount: 16,
  panelWp: 400,
  inverterKva: 5,
  inverterPhases: 3,
  inverterModel: 'SMA Sunny Tripower STP5.0-3AV-40',
  orientation: 'Sud',
  tiltDeg: 35,
  installDate: '',
};

export const DEFAULT_SURPLUS_HEATER: SurplusHeater = {
  enabled: true,
  powerKw: 2,
  startMonth: 10,
  endMonth: 4,
  usagePct: 50,
};

export const DEFAULT_HOUSE: House = {
  name: 'Ma maison',
  persons: 4,
  areaM2: 160,
  pv: { ...DEFAULT_PV },
  surplusHeater: { ...DEFAULT_SURPLUS_HEATER },
  heating: {
    oilBoiler: true,
    woodStove: true,
    note: 'Chaudière mazout (eau chaude + chauffage), poêle à bois en appoint.',
  },
  ev: { ...DEFAULT_EV },
};

export function emptyData(): AppData {
  return {
    schemaVersion: 1,
    house: structuredClone(DEFAULT_HOUSE),
    readings: [],
    settings: { ...DEFAULT_SETTINGS, offPeakHours: [...DEFAULT_SETTINGS.offPeakHours] },
  };
}
