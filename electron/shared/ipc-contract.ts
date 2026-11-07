/**
 * Contrat entre le process principal et la page, partagé par les deux côtés.
 * Ne contient que des types : il est effacé à la compilation.
 */

import type { InverterBrand } from './inverter-brands';
import type { P1ReaderKind } from './p1-readers';

export type ThemeMode = 'system' | 'light' | 'dark';

export type ExportKind = 'json' | 'csv';

export interface LoadResult {
  /** Contenu brut du fichier de données, ou `null` au premier démarrage. */
  readonly content: string | null;
  /** Chemin absolu du fichier de données. */
  readonly path: string;
  /** Renseigné quand le fichier principal était illisible et que la copie `.bak` a été utilisée. */
  readonly recoveredFromBackup: boolean;
}

export interface AiStatus {
  /** Une clé API est enregistrée (elle n'est jamais renvoyée à la page). */
  readonly hasKey: boolean;
}

export type SecretName = 'claudeApiKey' | 'inverterPsk' | 'p1Token';

export interface SecretsStatus {
  /** `keychain` : Trousseau macOS ; `file` : fichier chiffré par le système (hors macOS). */
  readonly storage: 'keychain' | 'file';
  /** Secrets présents. */
  readonly secrets: Readonly<Record<SecretName, boolean>>;
  /** L'ancien coffre chiffré par la clé SSH attend d'être importé. */
  readonly legacyVault: boolean;
}

export interface InverterConfig {
  readonly enabled: boolean;
  /** Marque (protocole) de l'onduleur ; SMA si absent. */
  readonly brand?: InverterBrand;
  /** Nom ou adresse de l'onduleur sur le réseau local (ex. `SMA3012345678.local` : « SMA » + numéro de série). */
  readonly host: string;
  /** Empreinte SHA-256 du certificat épinglée à la première connexion, ou `null`. */
  readonly certFingerprint: string | null;
  /** Port ; `null` ou absent : port par défaut de la marque. */
  readonly port?: number | null;
  /** Identifiant Modbus (unit id) ; `null` ou absent : celui de la marque. */
  readonly unitId?: number | null;
  /** Numéro de série de la clé Wi-Fi Solarman (Solis, Deye, Sofar), ou `null`. */
  readonly loggerSerial?: string | null;
}

/** Journaux de l'onduleur : production par jour depuis sa mise en service et courbe du jour (5 minutes). */
export interface InverterHistory {
  readonly days: readonly { date: string; dayKwh: number; totalKwh: number }[];
  readonly today: readonly { at: number; powerW: number }[];
  readonly error: string | null;
}

/** Courbe de puissance d'une journée (journal des 5 minutes de l'onduleur). */
export interface InverterDayCurve {
  /** `AAAA-MM-JJ`. */
  readonly date: string;
  readonly points: readonly { at: number; powerW: number }[];
  readonly error: string | null;
}

/** Onduleur trouvé sur le réseau local. */
export interface InverterFound {
  /** Nom réseau ou adresse IP. */
  readonly host: string;
  /** Numéro de série de la clé Wi-Fi Solarman, quand la recherche le donne. */
  readonly loggerSerial?: string;
}

export interface InverterReading {
  /** Horodatage de la lecture (ms). */
  readonly at: number;
  /** Puissance AC instantanée (W) ; `null` la nuit ou en cas d'erreur. */
  readonly powerW: number | null;
  /** Production du jour (Wh). */
  readonly dayWh: number | null;
  /** Production totale cumulée (Wh). */
  readonly totalWh: number | null;
  readonly error: string | null;
  /** Empreinte du certificat présenté par l'onduleur (pour l'épingler la première fois). */
  readonly certFingerprint: string | null;
  /** Nouveau nom réseau sous lequel l'onduleur a été retrouvé (à enregistrer dans les réglages). */
  readonly movedTo?: string;
}

export interface P1Config {
  readonly enabled: boolean;
  /** Type de lecteur ; HomeWizard API v1 si absent. */
  readonly kind?: P1ReaderKind;
  /** Nom ou adresse du lecteur P1 sur le réseau local (ex. `p1meter-1A2B3C.local`). */
  readonly host: string;
  /** Port ; `null` ou absent : celui du lecteur. */
  readonly port?: number | null;
  /** Empreinte du certificat épinglée (HomeWizard API v2). */
  readonly certFingerprint?: string | null;
}

/** Lecture du compteur intelligent par le port P1 (lecteur HomeWizard, Chargee, YouLess ou télégramme brut). */
export interface P1Reading {
  /** Horodatage de la lecture (ms). */
  readonly at: number;
  /** Puissance active nette (W) : positive en soutirage, négative en injection. */
  readonly powerW: number | null;
  /** Moyenne du quart d'heure en cours (W), base du tarif capacitaire. */
  readonly quarterHourAvgW: number | null;
  /** Tarif en cours : 1 = heures pleines, 2 = heures creuses. */
  readonly tariff: 1 | 2 | null;
  /** Index cumulés (kWh) : 1.8.1, 1.8.2, 2.8.1, 2.8.2. */
  readonly importPeak: number | null;
  readonly importOff: number | null;
  readonly exportPeak: number | null;
  readonly exportOff: number | null;
  /** Modèle du compteur annoncé par le lecteur (ex. `ISKRA 2MIE5T-200`). */
  readonly meterModel: string | null;
  readonly error: string | null;
  /** Empreinte du certificat présenté (HomeWizard API v2), pour l'épingler. */
  readonly certFingerprint?: string | null;
  /** Nouveau nom réseau sous lequel le lecteur a été retrouvé (à enregistrer dans les réglages). */
  readonly movedTo?: string;
}

export interface AiMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface AiChatRequest {
  /** Identifiant choisi par la page pour rattacher les événements de flux à la conversation. */
  readonly requestId: string;
  readonly model: string;
  /** Contexte : rôle de l'assistant et instantané des données. */
  readonly system: string;
  readonly messages: readonly AiMessage[];
}

export type AiStreamEvent =
  | { readonly requestId: string; readonly type: 'delta'; readonly text: string }
  | { readonly requestId: string; readonly type: 'done' }
  | { readonly requestId: string; readonly type: 'error'; readonly message: string };

export interface AiTestResult {
  readonly ok: boolean;
  readonly message: string;
}

export interface MeterPhoto {
  readonly mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
  readonly base64: string;
}

export type Confidence = 'high' | 'medium' | 'low';

/** Valeurs lues par Claude sur la ou les photos du compteur (toujours à valider par l'utilisateur). */
export interface PhotoReading {
  readonly importPeak: number | null;
  readonly importOff: number | null;
  readonly exportPeak: number | null;
  readonly exportOff: number | null;
  readonly pvTotal: number | null;
  /** Date et heure affichées par le compteur, `YYYY-MM-DDTHH:mm`, si elles sont lisibles. */
  readonly displayedDate: string | null;
  readonly confidence: {
    readonly importPeak: Confidence | null;
    readonly importOff: Confidence | null;
    readonly exportPeak: Confidence | null;
    readonly exportOff: Confidence | null;
    readonly pvTotal: Confidence | null;
  };
  readonly notes: string;
}

export interface ConsoElecApi {
  readonly platform: string;
  readonly data: {
    load(): Promise<LoadResult>;
    save(content: string): Promise<void>;
    /** Ouvre « Enregistrer sous » ; renvoie le chemin choisi, ou `null` si annulé. */
    exportFile(content: string, suggestedName: string, kind: ExportKind): Promise<string | null>;
    /** Ouvre « Ouvrir » sur un fichier JSON ou CSV ; renvoie son contenu, ou `null` si annulé. */
    importFile(kind: ExportKind): Promise<string | null>;
    /** Affiche le fichier de données dans le Finder / l'Explorateur. */
    reveal(): Promise<void>;
  };
  readonly theme: {
    set(mode: ThemeMode): Promise<void>;
  };
  readonly image: {
    /** Décode une image que Chromium ne lit pas (HEIC d'iPhone…) avec les codecs du système, réduite et en JPEG. */
    toJpeg(data: ArrayBuffer): Promise<MeterPhoto>;
  };
  readonly secrets: {
    status(): Promise<SecretsStatus>;
    /** Enregistre ou efface un secret ; il n'est jamais renvoyé à la page. */
    setSecret(name: SecretName, value: string | null): Promise<SecretsStatus>;
    /** Reprend les secrets de l'ancien coffre (phrase de passe de la clé SSH), puis le supprime. */
    importVault(passphrase: string): Promise<SecretsStatus>;
  };
  readonly inverter: {
    configure(config: InverterConfig): Promise<void>;
    /** Lit tout de suite les mesures (aussi diffusées par `onReading`). */
    refresh(): Promise<InverterReading>;
    onReading(listener: (reading: InverterReading) => void): () => void;
    /**
     * Cherche les onduleurs de la marque sur le réseau local (SMA si absente) ; renvoie leurs noms réseau ou adresses,
     * avec le numéro de série de la clé Wi-Fi quand la recherche le donne (Solarman).
     */
    discover(brand?: InverterBrand): Promise<InverterFound[]>;
    /** Lit les journaux de production de l'onduleur (jours passés et courbe du jour). */
    history(): Promise<InverterHistory>;
    /** Lit la courbe de puissance d'une journée (`AAAA-MM-JJ`) dans le journal des 5 minutes. */
    dayCurve(date: string): Promise<InverterDayCurve>;
  };
  readonly p1: {
    configure(config: P1Config): Promise<void>;
    /** Lit tout de suite le compteur (aussi diffusé par `onReading`). */
    refresh(): Promise<P1Reading>;
    onReading(listener: (reading: P1Reading) => void): () => void;
    /** Cherche les lecteurs P1 du type donné sur le réseau local ; renvoie leurs noms réseau ou adresses. */
    discover(kind?: P1ReaderKind): Promise<string[]>;
    /**
     * Associe le lecteur HomeWizard (API v2) configuré : attend l'appui sur son bouton (60 s au plus), range le jeton
     * dans le Trousseau et renvoie l'empreinte du certificat à épingler. Lève une erreur lisible en cas d'échec.
     */
    pair(): Promise<{ readonly certFingerprint: string | null }>;
  };
  readonly ai: {
    status(): Promise<AiStatus>;
    /** Petit appel de contrôle pour vérifier la clé et le modèle. */
    test(model: string): Promise<AiTestResult>;
    /** Lance une réponse en flux ; les morceaux arrivent par `onEvent`. */
    chat(request: AiChatRequest): Promise<void>;
    abort(requestId: string): Promise<void>;
    onEvent(listener: (event: AiStreamEvent) => void): () => void;
    /** Lit les index d'un compteur sur 1 à 4 photos. Lève une erreur lisible en cas d'échec. */
    readMeter(model: string, photos: readonly MeterPhoto[]): Promise<PhotoReading>;
  };
}

export const IPC = {
  load: 'data:load',
  save: 'data:save',
  exportFile: 'data:export',
  importFile: 'data:import',
  reveal: 'data:reveal',
  theme: 'theme:set',
  imageToJpeg: 'image:toJpeg',
  secretsStatus: 'secrets:status',
  secretsSet: 'secrets:set',
  secretsImportVault: 'secrets:importVault',
  inverterConfigure: 'inverter:configure',
  inverterRefresh: 'inverter:refresh',
  inverterReading: 'inverter:reading',
  inverterDiscover: 'inverter:discover',
  inverterHistory: 'inverter:history',
  inverterDayCurve: 'inverter:day-curve',
  p1Configure: 'p1:configure',
  p1Refresh: 'p1:refresh',
  p1Reading: 'p1:reading',
  p1Discover: 'p1:discover',
  p1Pair: 'p1:pair',
  aiStatus: 'ai:status',
  aiTest: 'ai:test',
  aiChat: 'ai:chat',
  aiAbort: 'ai:abort',
  aiReadMeter: 'ai:readMeter',
  aiEvent: 'ai:event',
} as const;
