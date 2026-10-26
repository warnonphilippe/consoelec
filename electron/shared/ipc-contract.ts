/**
 * Contrat entre le process principal et la page, partagé par les deux côtés.
 * Ne contient que des types : il est effacé à la compilation.
 */

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
  /** Une clé API est disponible dans le coffre déverrouillé (elle n'est jamais renvoyée à la page). */
  readonly hasKey: boolean;
  /** État du coffre qui contient la clé. */
  readonly vault: VaultState;
}

export type VaultState = 'absent' | 'locked' | 'unlocked';
export type SecretName = 'claudeApiKey' | 'inverterPsk';

export interface VaultStatus {
  readonly state: VaultState;
  /** Clé SSH qui chiffre le coffre, ou `null` s'il n'existe pas encore. */
  readonly sshKeyPath: string | null;
  /** Clé SSH proposée à la création. */
  readonly defaultSshKeyPath: string;
  /** Secrets présents (connus seulement quand le coffre est ouvert). */
  readonly secrets: Readonly<Record<SecretName, boolean>>;
  /** Une ancienne clé API (Trousseau macOS) attend d'être reprise dans le coffre. */
  readonly legacyApiKey: boolean;
}

export interface InverterConfig {
  readonly enabled: boolean;
  /** Nom ou adresse de l'onduleur sur le réseau local (ex. `SMA3012345678.local` : « SMA » + numéro de série). */
  readonly host: string;
  /** Empreinte SHA-256 du certificat épinglée à la première connexion, ou `null`. */
  readonly certFingerprint: string | null;
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
  readonly vault: {
    status(): Promise<VaultStatus>;
    /** Crée le coffre avec la clé SSH donnée (et y reprend l'ancienne clé API s'il y en a une). */
    create(sshKeyPath: string, passphrase: string): Promise<VaultStatus>;
    unlock(passphrase: string): Promise<VaultStatus>;
    lock(): Promise<VaultStatus>;
    /** Enregistre ou efface un secret ; il n'est jamais renvoyé à la page. */
    setSecret(name: SecretName, value: string | null): Promise<VaultStatus>;
  };
  readonly inverter: {
    configure(config: InverterConfig): Promise<void>;
    /** Lit tout de suite les mesures (aussi diffusées par `onReading`). */
    refresh(): Promise<InverterReading>;
    onReading(listener: (reading: InverterReading) => void): () => void;
    /** Cherche les onduleurs SMA sur le réseau local ; renvoie leurs noms réseau. */
    discover(): Promise<string[]>;
    /** Lit les journaux de production de l'onduleur (jours passés et courbe du jour). */
    history(): Promise<InverterHistory>;
    /** Lit la courbe de puissance d'une journée (`AAAA-MM-JJ`) dans le journal des 5 minutes. */
    dayCurve(date: string): Promise<InverterDayCurve>;
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
  vaultStatus: 'vault:status',
  vaultCreate: 'vault:create',
  vaultUnlock: 'vault:unlock',
  vaultLock: 'vault:lock',
  vaultSetSecret: 'vault:setSecret',
  inverterConfigure: 'inverter:configure',
  inverterRefresh: 'inverter:refresh',
  inverterReading: 'inverter:reading',
  inverterDiscover: 'inverter:discover',
  inverterHistory: 'inverter:history',
  inverterDayCurve: 'inverter:day-curve',
  aiStatus: 'ai:status',
  aiTest: 'ai:test',
  aiChat: 'ai:chat',
  aiAbort: 'ai:abort',
  aiReadMeter: 'ai:readMeter',
  aiEvent: 'ai:event',
} as const;
