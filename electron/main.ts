import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BrowserWindow,
  app,
  dialog,
  ipcMain,
  nativeTheme,
  net,
  protocol,
  safeStorage,
  session,
  shell,
} from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { APP_HOST, APP_SCHEME, assetFileUrl, buildContentSecurityPolicy } from './app-protocol';
import { AiService, type FetchLike } from './ai';
import { LocalLlmService } from './local-llm';
import { resolveModelsDir } from './models-dir';
import { OpenAiService } from './openai';
import { convertToJpeg } from './image';
import {
  discoverBonjourHosts,
  discoverEnphaseGateways,
  discoverP1Meters,
  discoverSmaInverters,
  p1Identity,
  relocatedHost,
  smaSerial,
} from './discovery';
import { HostRecovery } from './host-recovery';
import { InverterHub } from './inverters/hub';
import { scanInverters } from './inverters/scan';
import { P1Client, pairHomeWizard } from './p1';
import { localNetworks, scanPort } from './inverters/scan';
import { DEFAULT_P1_READER, isP1ReaderKind, p1Reader, type P1ReaderKind } from './shared/p1-readers';
import { SECRET_NAMES, Secrets, fileBackend, keychainBackend } from './secret-store';
import { EncryptedFileSecrets } from './secrets';
import { DataFileStore } from './storage';
import {
  DEFAULT_INVERTER_BRAND,
  inverterBrand,
  isInverterBrand,
  type InverterBrand,
} from './shared/inverter-brands';
import {
  IPC,
  type AiChatRequest,
  type AiProvider,
  type AiStreamEvent,
  type ExportKind,
  type InverterConfig,
  type InverterFound,
  type InverterReading,
  type MeterPhoto,
  type P1Config,
  type P1Reading,
  type SecretName,
  type ThemeMode,
} from './shared/ipc-contract';

/** URL du serveur de développement Angular, honorée uniquement hors application packagée. */
const DEV_URL = !app.isPackaged ? (process.env['CONSOELEC_DEV_URL'] ?? null) : null;
const DEV_ORIGIN = DEV_URL === null ? null : new URL(DEV_URL).origin;
const RENDERER_ROOT = join(__dirname, '..', 'dist', 'consoelec', 'browser');
/** Développement uniquement : serveur local simulant l'API Claude (jamais honoré dans l'application packagée). */
const DEV_API_URL = !app.isPackaged ? process.env['CONSOELEC_API_URL'] : undefined;
/** Développement uniquement : serveur local simulant l'API OpenAI. */
const DEV_OPENAI_API_URL = !app.isPackaged ? process.env['CONSOELEC_OPENAI_API_URL'] : undefined;
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
const CSP = buildContentSecurityPolicy(DEV_ORIGIN);
const MAX_CONTENT_LENGTH = 50 * 1024 * 1024;
const MAX_SYSTEM_LENGTH = 3 * 1024 * 1024;
const MAX_MESSAGE_LENGTH = 200_000;
const MAX_PHOTO_BASE64 = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
const MAX_PHOTO_SIDE = 1568;
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

// Développement uniquement : dossier de données isolé pour les essais.
const DEV_USER_DATA = !app.isPackaged ? process.env['CONSOELEC_USER_DATA'] : undefined;
if (DEV_USER_DATA !== undefined) {
  app.setPath('userData', DEV_USER_DATA);
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true },
  },
]);

let mainWindow: BrowserWindow | null = null;

const BACKGROUND = { dark: '#0f172a', light: '#f1f5f9' } as const;

function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'system' || value === 'light' || value === 'dark';
}

function backgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? BACKGROUND.dark : BACKGROUND.light;
}

/** Seules la page de l'application (ou le serveur de dev) peuvent appeler le process principal. */
function fromApp(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? '';
  return (
    url.startsWith(`${APP_ORIGIN}/`) || (DEV_ORIGIN !== null && url.startsWith(`${DEV_ORIGIN}/`))
  );
}

function assertString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length > MAX_CONTENT_LENGTH) {
    throw new Error(`Paramètre invalide : ${name}`);
  }
  return value;
}

function assertModel(value: unknown): string {
  const model = assertString(value, 'model');
  if (!/^[\w.:-]{3,80}$/.test(model)) {
    throw new Error('Paramètre invalide : model');
  }
  return model;
}

/** Moteur de l'assistant ; absent : Claude, comme avant l'arrivée des autres moteurs. */
function assertProvider(value: unknown): AiProvider {
  if (value === undefined || value === null) {
    return 'claude';
  }
  if (value !== 'claude' && value !== 'openai' && value !== 'qwen') {
    throw new Error('Paramètre invalide : provider');
  }
  return value;
}

function assertPhotos(value: unknown): MeterPhoto[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) {
    throw new Error('Paramètre invalide : photos');
  }
  return value.map((item: unknown) => {
    const photo = item as Partial<MeterPhoto> | null;
    const mediaType = PHOTO_TYPES.find((t) => t === photo?.mediaType);
    if (
      mediaType === undefined ||
      typeof photo?.base64 !== 'string' ||
      photo.base64.length > MAX_PHOTO_BASE64
    ) {
      throw new Error('Paramètre invalide : photo');
    }
    return { mediaType, base64: photo.base64 };
  });
}

function assertChat(value: unknown): AiChatRequest {
  const request = value as Partial<AiChatRequest> | null;
  if (
    request === null ||
    typeof request !== 'object' ||
    !Array.isArray(request.messages) ||
    request.messages.length > 200
  ) {
    throw new Error('Paramètre invalide : conversation');
  }
  const messages = request.messages.map((m) => {
    if (
      (m.role !== 'user' && m.role !== 'assistant') ||
      typeof m.content !== 'string' ||
      m.content.length > MAX_MESSAGE_LENGTH
    ) {
      throw new Error('Paramètre invalide : message');
    }
    return { role: m.role, content: m.content };
  });
  const system = request.system;
  if (typeof system !== 'string' || system.length > MAX_SYSTEM_LENGTH) {
    throw new Error('Paramètre invalide : system');
  }
  return {
    requestId: assertString(request.requestId, 'requestId'),
    provider: assertProvider(request.provider),
    model: assertModel(request.model),
    system,
    messages,
  };
}

function handle(channel: string, handler: (...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    if (!fromApp(event)) {
      throw new Error('Appel refusé');
    }
    return handler(...args);
  });
}

const INVERTER_POLL_MS = 60_000;
/** Les index du compteur sont lus chaque minute par le lecteur P1. */
const P1_POLL_MS = 60_000;

function assertSecretName(value: unknown): SecretName {
  if (!SECRET_NAMES.includes(value as SecretName)) {
    throw new Error('Paramètre invalide : secret');
  }
  return value as SecretName;
}

function assertIsoDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('Date invalide');
  }
  return value;
}

function assertInverterConfig(value: unknown): InverterConfig {
  const c = value as Partial<InverterConfig> | null;
  if (
    c === null ||
    typeof c !== 'object' ||
    typeof c.enabled !== 'boolean' ||
    typeof c.host !== 'string'
  ) {
    throw new Error('Paramètre invalide : onduleur');
  }
  const host = c.host.trim();
  if (host.length > 0 && !/^[A-Za-z0-9.-]{1,253}$/.test(host)) {
    throw new Error("Adresse de l'onduleur invalide.");
  }
  const fp = c.certFingerprint;
  if (
    fp !== null &&
    fp !== undefined &&
    (typeof fp !== 'string' || !/^[0-9A-Fa-f:]{64,95}$/.test(fp))
  ) {
    throw new Error('Empreinte de certificat invalide.');
  }
  const brand = c.brand ?? DEFAULT_INVERTER_BRAND;
  if (!isInverterBrand(brand)) {
    throw new Error("Marque d'onduleur inconnue.");
  }
  const intOrNull = (value: unknown, max: number, what: string): number | null => {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
      throw new Error(`${what} invalide.`);
    }
    return value;
  };
  const serial = c.loggerSerial;
  if (serial !== null && serial !== undefined && (typeof serial !== 'string' || !/^\d{1,10}$/.test(serial))) {
    throw new Error('Numéro de série de la clé Wi-Fi invalide.');
  }
  return {
    enabled: c.enabled,
    brand,
    host,
    certFingerprint: fp ?? null,
    port: intOrNull(c.port, 65535, 'Port'),
    unitId: intOrNull(c.unitId, 255, 'Identifiant Modbus'),
    loggerSerial: serial ?? null,
  };
}

function assertBrand(value: unknown): InverterBrand {
  if (value === undefined || value === null) {
    return DEFAULT_INVERTER_BRAND;
  }
  if (!isInverterBrand(value)) {
    throw new Error("Marque d'onduleur inconnue.");
  }
  return value;
}

/**
 * Cherche les onduleurs de la marque sur le réseau local. `port` : port réglé pour cette marque (essais avec un
 * émulateur, port non standard), sinon celui de la marque.
 */
async function discoverInverters(brand: InverterBrand, port: number | null): Promise<InverterFound[]> {
  const info = inverterBrand(brand);
  if (info.protocol === 'sma') {
    return (await discoverSmaInverters()).map((host) => ({ host }));
  }
  if (info.protocol === 'enphase') {
    return (await discoverEnphaseGateways()).map((host) => ({ host }));
  }
  return info.discovery === 'scan' ? scanInverters(brand, { port }) : [];
}

function assertP1Config(value: unknown): P1Config {
  const c = value as Partial<P1Config> | null;
  if (
    c === null ||
    typeof c !== 'object' ||
    typeof c.enabled !== 'boolean' ||
    typeof c.host !== 'string'
  ) {
    throw new Error('Paramètre invalide : lecteur P1');
  }
  const host = c.host.trim();
  if (host.length > 0 && !/^[A-Za-z0-9.-]{1,253}$/.test(host)) {
    throw new Error('Adresse du lecteur P1 invalide.');
  }
  const kind = c.kind ?? DEFAULT_P1_READER;
  if (!isP1ReaderKind(kind)) {
    throw new Error('Type de lecteur P1 inconnu.');
  }
  const port = c.port ?? null;
  if (port !== null && (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error('Port du lecteur P1 invalide.');
  }
  const fp = c.certFingerprint ?? null;
  if (fp !== null && (typeof fp !== 'string' || !/^[0-9A-Fa-f:]{64,95}$/.test(fp))) {
    throw new Error('Empreinte de certificat invalide.');
  }
  return { enabled: c.enabled, kind, host, port, certFingerprint: fp };
}

/** Cherche les lecteurs P1 du type donné : Bonjour, ou balayage du réseau local confirmé par une lecture. */
async function discoverP1Readers(kind: P1ReaderKind, port: number | null): Promise<string[]> {
  const info = p1Reader(kind);
  if (kind === 'homewizard') {
    return discoverP1Meters();
  }
  if (info.bonjour !== null) {
    return discoverBonjourHosts(info.bonjour);
  }
  if (!info.scan) {
    return [];
  }
  const tcpPort = port ?? info.defaultPort;
  const open = await scanPort(localNetworks().flatMap((n) => n.hosts), tcpPort);
  const confirmed = await Promise.all(
    open.map(async (host) => {
      const client = new P1Client();
      client.configure({ enabled: true, kind, host, port: tcpPort });
      return (await client.read()).error === null;
    }),
  );
  return open.filter((_, i) => confirmed[i]);
}

function registerIpc(
  store: DataFileStore,
  ai: AiService,
  engines: { readonly openai: OpenAiService; readonly local: LocalLlmService },
  secrets: Secrets,
  secretsReady: Promise<void>,
  inverter: InverterHub,
  pollInverter: () => void,
  p1: P1Client,
  pollP1: () => void,
): void {
  handle(IPC.load, () => store.load());
  handle(IPC.save, (content) => store.save(assertString(content, 'content')));

  handle(IPC.exportFile, async (content, suggestedName, kind) => {
    const text = assertString(content, 'content');
    const name = assertString(suggestedName, 'suggestedName').replace(/[\\/]/g, '_');
    const exportKind: ExportKind = kind === 'csv' ? 'csv' : 'json';
    const options = {
      defaultPath: join(app.getPath('documents'), name),
      filters:
        exportKind === 'csv'
          ? [{ name: 'CSV', extensions: ['csv'] }]
          : [{ name: 'Données ConsoElec', extensions: ['json'] }],
    };
    const result = mainWindow
      ? await dialog.showSaveDialog(mainWindow, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) {
      return null;
    }
    await writeFile(result.filePath, text, 'utf-8');
    return result.filePath;
  });

  handle(IPC.importFile, async (kind) => {
    const csv = kind === 'csv';
    const options = {
      properties: ['openFile' as const],
      filters: csv
        ? [{ name: 'CSV', extensions: ['csv', 'txt'] }]
        : [{ name: 'Données ConsoElec', extensions: ['json'] }],
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    const file = result.filePaths[0];
    if (result.canceled || file === undefined) {
      return null;
    }
    return assertString(await readFile(file, 'utf-8'), 'fichier');
  });

  handle(IPC.reveal, () => shell.showItemInFolder(store.path));

  handle(IPC.imageToJpeg, (data) => {
    if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) {
      throw new Error('Paramètre invalide : image');
    }
    const bytes =
      data instanceof ArrayBuffer
        ? Buffer.from(data)
        : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new Error('Image trop volumineuse.');
    }
    return convertToJpeg(bytes, MAX_PHOTO_SIDE);
  });
  handle(IPC.secretsStatus, async () => {
    await secretsReady;
    return secrets.status();
  });
  handle(IPC.secretsSet, async (name, value) => {
    if (value !== null && (typeof value !== 'string' || value.length > 4000)) {
      throw new Error('Paramètre invalide : valeur');
    }
    const secretName = assertSecretName(name);
    await secretsReady;
    await secrets.set(secretName, value);
    if (secretName === 'inverterPsk') {
      await inverter.close();
      pollInverter();
    }
    return secrets.status();
  });
  handle(IPC.secretsImportVault, async (passphrase) => {
    await secretsReady;
    await secrets.importVault(assertString(passphrase, 'passphrase'));
    await inverter.close();
    pollInverter();
    return secrets.status();
  });
  handle(IPC.inverterConfigure, (config) => {
    inverter.configure(assertInverterConfig(config));
    pollInverter();
  });
  handle(IPC.inverterDiscover, (value) => {
    const brand = assertBrand(value);
    const current = inverter.settings;
    return discoverInverters(brand, (current.brand ?? DEFAULT_INVERTER_BRAND) === brand ? (current.port ?? null) : null);
  });
  handle(IPC.inverterHistory, () => inverter.history());
  handle(IPC.inverterDayCurve, (date) => inverter.dayCurve(assertIsoDate(date)));
  handle(IPC.inverterRefresh, async () => {
    const reading = await inverter.read();
    mainWindow?.webContents.send(IPC.inverterReading, reading);
    return reading;
  });
  handle(IPC.p1Configure, (config) => {
    p1.configure(assertP1Config(config));
    pollP1();
  });
  handle(IPC.p1Discover, (value) => {
    const kind = value === undefined || value === null ? DEFAULT_P1_READER : value;
    if (!isP1ReaderKind(kind)) {
      throw new Error('Type de lecteur P1 inconnu.');
    }
    const current = p1.settings;
    return discoverP1Readers(kind, (current.kind ?? DEFAULT_P1_READER) === kind ? (current.port ?? null) : null);
  });
  handle(IPC.p1Pair, async () => {
    const current = p1.settings;
    if (p1.kind !== 'homewizard-v2' || !current.host) {
      throw new Error('Choisissez « HomeWizard (API v2) » et renseignez l’adresse du lecteur avant de l’associer.');
    }
    await secretsReady;
    const result = await pairHomeWizard(current.host, current.port ?? p1Reader('homewizard-v2').defaultPort);
    await secrets.set('p1Token', result.token);
    p1.configure({ ...current, certFingerprint: result.fingerprint });
    pollP1();
    return { certFingerprint: result.fingerprint };
  });
  handle(IPC.p1Refresh, async () => {
    const reading = await p1.read();
    mainWindow?.webContents.send(IPC.p1Reading, reading);
    return reading;
  });
  handle(IPC.aiStatus, async () => {
    await secretsReady;
    return { hasKey: secrets.has('claudeApiKey') };
  });
  handle(IPC.aiTest, (model, provider) => {
    switch (assertProvider(provider)) {
      case 'openai':
        return engines.openai.test(assertModel(model));
      case 'qwen':
        return engines.local.test(assertModel(model));
      default:
        return ai.test(assertModel(model));
    }
  });
  handle(IPC.aiAbort, (requestId) => {
    const id = assertString(requestId, 'requestId');
    ai.abort(id);
    engines.openai.abort(id);
    engines.local.abort(id);
  });
  handle(IPC.aiReadMeter, (model, photos, provider) => {
    switch (assertProvider(provider)) {
      case 'openai':
        return engines.openai.readMeter(assertModel(model), assertPhotos(photos));
      case 'qwen':
        return engines.local.readMeter();
      default:
        return ai.readMeter(assertModel(model), assertPhotos(photos));
    }
  });
  handle(IPC.aiLocalStatus, (model) => engines.local.status(assertModel(model)));
  handle(IPC.aiLocalDownload, (model) => engines.local.startDownload(assertModel(model)));
  handle(IPC.aiLocalCancel, (model) => engines.local.cancelDownload(assertModel(model)));
  handle(IPC.aiLocalRemove, (model) => engines.local.remove(assertModel(model)));
  ipcMain.handle(IPC.aiChat, (event, request: unknown) => {
    if (!fromApp(event)) {
      throw new Error('Appel refusé');
    }
    const chat = assertChat(request);
    // Le flux est relayé à la page qui l'a demandé ; la promesse se termine à la fin du flux.
    const emit = (payload: AiStreamEvent): void => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(IPC.aiEvent, payload);
      }
    };
    switch (chat.provider) {
      case 'openai':
        return engines.openai.chat(chat, emit);
      case 'qwen':
        return engines.local.chat(chat, emit);
      default:
        return ai.chat(chat, emit);
    }
  });

  handle(IPC.theme, (mode) => {
    nativeTheme.themeSource = isThemeMode(mode) ? mode : 'system';
    mainWindow?.setBackgroundColor(backgroundColor());
  });
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 620,
    title: 'ConsoElec',
    backgroundColor: backgroundColor(),
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });

  window.once('ready-to-show', () => window.show());
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  // Liens externes (sources des statistiques) : ouverts dans le navigateur par défaut.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  void window.loadURL(DEV_URL ?? `${APP_ORIGIN}/index.html`);
  return window;
}

function bootstrap(): void {
  const store = new DataFileStore(join(app.getPath('userData'), 'consoelec.json'));
  const savedTheme = store.readThemeSync();
  nativeTheme.themeSource = isThemeMode(savedTheme) ? savedTheme : 'system';

  protocol.handle(APP_SCHEME, async (request) => {
    const response = await net.fetch(assetFileUrl(RENDERER_ROOT, request.url));
    const headers = new Headers(response.headers);
    headers.set('Content-Security-Policy', CSP);
    headers.set('X-Content-Type-Options', 'nosniff');
    // index.html jamais mis en cache : une nouvelle version de l'app charge toujours ses nouveaux fichiers.
    if (headers.get('Content-Type')?.startsWith('text/html')) {
      headers.set('Cache-Control', 'no-store');
    }
    return new Response(response.body, { status: response.status, headers });
  });

  const defaultSession = session.defaultSession;
  defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  defaultSession.setPermissionCheckHandler(() => false);
  if (DEV_ORIGIN !== null) {
    defaultSession.webRequest.onHeadersReceived(
      { urls: [`${DEV_ORIGIN}/*`] },
      (details, callback) => {
        callback({
          responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP] },
        });
      },
    );
  }

  const userData = app.getPath('userData');
  // Clés dans le Trousseau macOS (fichier chiffré par le système ailleurs) ; l'ancien coffre SSH est importé sur demande.
  const secrets = new Secrets(
    process.platform === 'darwin'
      ? keychainBackend()
      : fileBackend(new EncryptedFileSecrets(join(userData, 'secrets.bin'), safeStorage)),
    join(userData, 'secrets.vault'),
    userData,
  );
  const secretsReady = secrets.load();
  const ai = new AiService(
    async () => {
      await secretsReady;
      return secrets.get('claudeApiKey');
    },
    ((url, init) => net.fetch(url, init)) as FetchLike,
    DEV_API_URL,
  );
  const openai = new OpenAiService(
    async () => {
      await secretsReady;
      return secrets.get('openaiApiKey');
    },
    ((url, init) => net.fetch(url, init)) as FetchLike,
    DEV_OPENAI_API_URL,
  );
  // Modèle Qwen local : dossier partagé (LOCAL_MODELS_DIR ou ~/.config/local-models/config.json), sinon
  // userData/models ; moteur natif chargé au premier usage.
  const local = new LocalLlmService(resolveModelsDir(join(userData, 'models')), (status) => {
    mainWindow?.webContents.send(IPC.aiLocalEvent, status);
  });
  setTimeout(() => void local.probe(), 5000);
  const inverter = new InverterHub(() => secrets.get('inverterPsk'));
  /** Le secret de l'onduleur est présent, ou la marque n'en demande pas. */
  const inverterSecretReady = (): boolean =>
    !inverter.brand.secretRequired || secrets.has('inverterPsk');
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  // Onduleur introuvable sous son nom : on le cherche sur le réseau. Sans numéro de série reconnu, le seul onduleur
  // trouvé est essayé : le certificat épinglé refuse tout autre appareil.
  const inverterRecovery = new HostRecovery(discoverSmaInverters, (current, found) =>
    relocatedHost(current, found, smaSerial, true),
  );
  /** Essaie l'onduleur sous un nouveau nom ; revient à l'ancien si la lecture échoue. */
  const readInverter = async (): Promise<InverterReading> => {
    const reading = await inverter.read();
    if (!inverter.troubled) {
      inverterRecovery.reset();
      return reading;
    }
    // Seuls les onduleurs SMA changent de nom réseau (conflit Bonjour) ; les autres gardent leur adresse.
    if (inverter.brand.protocol !== 'sma') {
      return reading;
    }
    const previous = inverter.host;
    const candidate = await inverterRecovery.trouble(previous);
    if (candidate === null || inverter.host !== previous) {
      return reading;
    }
    const config = { ...inverter.settings, enabled: true, host: candidate, certFingerprint: inverter.certFingerprint };
    inverter.configure(config);
    const moved = await inverter.read();
    if (moved.error === null && !inverter.troubled) {
      inverterRecovery.reset();
      return { ...moved, movedTo: candidate };
    }
    if (inverter.host === candidate) {
      inverter.configure({ ...config, host: previous });
    }
    return reading;
  };
  const pollOnce = async (): Promise<void> => {
    if (!inverter.enabled || !inverterSecretReady() || mainWindow === null) {
      return;
    }
    const reading = await readInverter();
    mainWindow?.webContents.send(IPC.inverterReading, reading);
  };
  const pollInverter = (): void => {
    void secretsReady.then(() => {
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (inverter.enabled && inverterSecretReady()) {
        void pollOnce();
        pollTimer = setInterval(() => void pollOnce(), INVERTER_POLL_MS);
      }
    });
  };
  const p1 = new P1Client(() => secrets.get('p1Token'));
  let p1Timer: ReturnType<typeof setInterval> | null = null;
  // Lecteur P1 introuvable sous son nom : on le cherche sur le réseau, sous le même identifiant uniquement.
  const p1Recovery = new HostRecovery(() => discoverP1Readers(p1.kind, null), (current, found) =>
    relocatedHost(current, found, p1Identity),
  );
  const readP1 = async (): Promise<P1Reading> => {
    const reading = await p1.read();
    if (!p1.troubled) {
      p1Recovery.reset();
      return reading;
    }
    const previous = p1.host;
    const candidate = await p1Recovery.trouble(previous);
    if (candidate === null || p1.host !== previous) {
      return reading;
    }
    const settings = p1.settings;
    p1.configure({ ...settings, enabled: true, host: candidate });
    const moved = await p1.read();
    if (moved.error === null) {
      p1Recovery.reset();
      return { ...moved, movedTo: candidate };
    }
    if (p1.host === candidate) {
      p1.configure({ ...settings, enabled: true, host: previous });
    }
    return reading;
  };
  const pollP1Once = async (): Promise<void> => {
    if (!p1.enabled || mainWindow === null) {
      return;
    }
    const reading = await readP1();
    mainWindow?.webContents.send(IPC.p1Reading, reading);
  };
  const pollP1 = (): void => {
    if (p1Timer !== null) {
      clearInterval(p1Timer);
      p1Timer = null;
    }
    if (p1.enabled) {
      void pollP1Once();
      p1Timer = setInterval(() => void pollP1Once(), P1_POLL_MS);
    }
  };
  app.on('before-quit', () => {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
    }
    if (p1Timer !== null) {
      clearInterval(p1Timer);
    }
    void inverter.close();
    void local.dispose();
  });
  registerIpc(store, ai, { openai, local }, secrets, secretsReady, inverter, pollInverter, p1, pollP1);

  const openWindow = (): void => {
    mainWindow = createWindow();
    mainWindow.on('closed', () => {
      mainWindow = null;
    });
  };
  openWindow();
  app.on('activate', () => {
    if (mainWindow === null) {
      openWindow();
    }
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow !== null) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
  void app.whenReady().then(bootstrap);
  app.on('window-all-closed', () => app.quit());
}
