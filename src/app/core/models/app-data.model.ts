import type { InverterBrand } from '../../../../electron/shared/inverter-brands';
import { DEFAULT_LOCAL_MODEL, DEFAULT_OPENAI_MODEL } from '../../../../electron/shared/ai-models';
import type { AiProvider } from '../../../../electron/shared/ipc-contract';
import type { P1ReaderKind } from '../../../../electron/shared/p1-readers';
import type { ThemeMode } from '../../../../electron/shared/ipc-contract';
import { DEFAULT_DASHBOARD, type CardId } from './dashboard';

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

/**
 * Origine d'un relevé. `auto` désigne les relevés quotidiens tirés du journal du lecteur P1 : ils sont recalculés pour
 * l'analyse et ne sont jamais enregistrés dans `readings`.
 */
export type ReadingSource = 'manual' | 'photo' | 'csv' | 'auto';

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
  /**
   * Début de l'année de facturation (`MM-JJ`) : date du relevé annuel du compteur intelligent. La compensation
   * entre soutirage et injection se fait sur cette année, par période tarifaire.
   */
  billingStart: string;
  /** Prix moyen du kWh en heures pleines, tout compris, TVA incluse (€). */
  priceHp: number;
  /** Prix moyen du kWh en heures creuses, tout compris, TVA incluse (€). */
  priceHc: number;
  theme: ThemeMode;
  /** Modèle Claude utilisé par l'assistant et la lecture de photo. */
  aiModel: string;
  /** Moteur de l'assistant : Claude (recommandé, par défaut), OpenAI ou Qwen exécuté sur l'ordinateur. */
  aiProvider: AiProvider;
  /** Modèle OpenAI (moteur OpenAI). */
  openaiModel: string;
  /** Modèle Qwen exécuté sur l'ordinateur (moteur Qwen). */
  localModel: string;
  inverter: InverterSettings;
  p1: P1Settings;
  /** Cadres du tableau de bord, dans l'ordre (préférence locale, comme le thème). */
  dashboard: CardId[];
}

/** Production lue sur l'onduleur pour un jour donné (dernière lecture de ce jour). */
export interface PvDay {
  /** `AAAA-MM-JJ` */
  date: string;
  /** Production du jour au moment de la lecture (kWh) ; définitive si la lecture a eu lieu après le coucher du soleil. */
  dayKwh: number;
  /** Index de production totale de l'onduleur au moment de la lecture (kWh). */
  totalKwh: number;
  /** Heure locale de la lecture, `AAAA-MM-JJTHH:mm`. */
  at: string;
}

/** Horaire des heures pleines / creuses en vigueur pendant une facture. */
export type BillSchedule = 'legacy' | 'current';

/**
 * Facture annuelle (de régularisation) d'un compteur bihoraire, ancien ou intelligent : soldes facturés de l'année,
 * soutirage moins injection, par période tarifaire (négatifs quand l'injection l'emporte).
 */
export interface AnnualBill {
  id: string;
  /** Début et fin (exclue) de l'année facturée, `AAAA-MM-JJ`. */
  from: string;
  to: string;
  /** Solde heures pleines / « jour » (I), kWh. */
  netPeak: number;
  /** Solde heures creuses / « nuit » (II), kWh. */
  netOff: number;
  /** `legacy` : ancien bihoraire (22 h-7 h et week-ends en heures creuses) ; `current` : horaire des réglages. */
  schedule: BillSchedule;
  note: string;
}

/**
 * Connexion locale à l'onduleur ; le secret (clé de la plaque SMA, mot de passe, jeton Enphase) est dans le Trousseau,
 * jamais ici.
 */
export interface InverterSettings {
  enabled: boolean;
  /** Marque (protocole de lecture). */
  brand: InverterBrand;
  host: string;
  /** Empreinte SHA-256 du certificat de l'onduleur, épinglée à la première connexion (SMA, Enphase). */
  certFingerprint: string | null;
  /** Port ; `null` : celui de la marque. */
  port: number | null;
  /** Identifiant Modbus ; `null` : celui de la marque. */
  unitId: number | null;
  /** Numéro de série de la clé Wi-Fi Solarman (Solis, Deye, Sofar), ou `null`. */
  loggerSerial: string | null;
}

/** Lecture du compteur par le port P1 (lecteur HomeWizard sur le réseau local). */
export interface P1Settings {
  enabled: boolean;
  /** Type de lecteur (protocole). */
  kind: P1ReaderKind;
  /** Nom réseau (`p1meter-XXXXXX.local`) ou adresse IP du lecteur. */
  host: string;
  /** Port ; `null` : celui du lecteur. */
  port: number | null;
  /** Empreinte du certificat épinglée à l'association (HomeWizard API v2). */
  certFingerprint: string | null;
}

/** Index du compteur lus par le port P1 à une minute donnée (kWh). */
export interface MeterLogPoint {
  /** Heure locale de la lecture, `AAAA-MM-JJTHH:mm`. */
  at: string;
  importPeak: number;
  importOff: number;
  exportPeak: number;
  exportOff: number;
}

/**
 * Journal des index lus par le port P1, gardé de façon compacte : chaque minute de la dernière heure, la dernière
 * lecture de chaque heure du jour en cours et la dernière lecture de chaque jour.
 */
export interface MeterLog {
  minutes: MeterLogPoint[];
  hours: MeterLogPoint[];
  days: MeterLogPoint[];
}

/**
 * Une journée du profil de soutirage et d'injection : index totaux (HP + HC, en Wh) à chaque quart d'heure
 * (00:00, 00:15 … 23:45). Voir `src/app/core/calc/meter-profile.ts`.
 */
export interface MeterProfileDay {
  /** `AAAA-MM-JJ`, date locale. */
  date: string;
  /** Index de soutirage (1.8.1 + 1.8.2, Wh) au début de chaque quart d'heure ; `null` = inconnu. */
  importWh: (number | null)[];
  /** Index d'injection (2.8.1 + 2.8.2, Wh) au début de chaque quart d'heure ; `null` = inconnu. */
  exportWh: (number | null)[];
  /** Quarts d'heure dont l'index est interpolé sur un trou de lecture (estimé, pas mesuré). */
  estimated?: number[];
}

export interface AppData {
  schemaVersion: 1;
  house: House;
  readings: MeterReading[];
  /** Historique quotidien de la production lue sur l'onduleur. */
  pvDaily: PvDay[];
  /** Factures annuelles des années passées (soldes jour / nuit). */
  annualBills: AnnualBill[];
  /** Index lus automatiquement par le port P1. */
  meterLog: MeterLog;
  /** Profil de soutirage et d'injection au quart d'heure (lecteur P1 et exports HomeWizard). */
  meterProfile: MeterProfileDay[];
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
  billingStart: '01-01',
  // Moyennes wallonnes 2026 estimées (énergie, réseau, taxes, TVA) : à remplacer par celles du contrat.
  priceHp: 0.34,
  priceHc: 0.24,
  theme: 'system',
  aiModel: DEFAULT_AI_MODEL,
  aiProvider: 'claude',
  openaiModel: DEFAULT_OPENAI_MODEL,
  localModel: DEFAULT_LOCAL_MODEL,
  inverter: {
    enabled: false,
    brand: 'sma',
    host: '',
    certFingerprint: null,
    port: null,
    unitId: null,
    loggerSerial: null,
  },
  p1: { enabled: false, kind: 'homewizard', host: '', port: null, certFingerprint: null },
  dashboard: [...DEFAULT_DASHBOARD],
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
    pvDaily: [],
    annualBills: [],
    meterLog: { minutes: [], hours: [], days: [] },
    meterProfile: [],
    settings: {
      ...DEFAULT_SETTINGS,
      offPeakHours: [...DEFAULT_SETTINGS.offPeakHours],
      inverter: { ...DEFAULT_SETTINGS.inverter },
      p1: { ...DEFAULT_SETTINGS.p1 },
    },
  };
}
