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
  /** Une clé API est enregistrée (elle n'est jamais renvoyée à la page). */
  readonly hasKey: boolean;
  /** Le système (Trousseau macOS, DPAPI Windows) permet de chiffrer la clé. */
  readonly encryptionAvailable: boolean;
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
  readonly ai: {
    status(): Promise<AiStatus>;
    /** Enregistre la clé API (chiffrée) ; elle ne quitte ensuite jamais le process principal. */
    setKey(key: string): Promise<void>;
    clearKey(): Promise<void>;
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
  aiStatus: 'ai:status',
  aiSetKey: 'ai:setKey',
  aiClearKey: 'ai:clearKey',
  aiTest: 'ai:test',
  aiChat: 'ai:chat',
  aiAbort: 'ai:abort',
  aiReadMeter: 'ai:readMeter',
  aiEvent: 'ai:event',
} as const;
