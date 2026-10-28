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
import { convertToJpeg } from './image';
import { discoverP1Meters, discoverSmaInverters } from './discovery';
import { InverterClient } from './inverter';
import { P1Client } from './p1';
import { SECRET_NAMES, Secrets, fileBackend, keychainBackend } from './secret-store';
import { EncryptedFileSecrets } from './secrets';
import { DataFileStore } from './storage';
import {
  IPC,
  type AiChatRequest,
  type ExportKind,
  type InverterConfig,
  type MeterPhoto,
  type P1Config,
  type SecretName,
  type ThemeMode,
} from './shared/ipc-contract';

/** URL du serveur de développement Angular, honorée uniquement hors application packagée. */
const DEV_URL = !app.isPackaged ? (process.env['CONSOELEC_DEV_URL'] ?? null) : null;
const DEV_ORIGIN = DEV_URL === null ? null : new URL(DEV_URL).origin;
const RENDERER_ROOT = join(__dirname, '..', 'dist', 'consoelec', 'browser');
/** Développement uniquement : serveur local simulant l'API Claude (jamais honoré dans l'application packagée). */
const DEV_API_URL = !app.isPackaged ? process.env['CONSOELEC_API_URL'] : undefined;
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
  return { enabled: c.enabled, host, certFingerprint: fp ?? null };
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
  return { enabled: c.enabled, host };
}

function registerIpc(
  store: DataFileStore,
  ai: AiService,
  secrets: Secrets,
  secretsReady: Promise<void>,
  inverter: InverterClient,
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
    if (value !== null && (typeof value !== 'string' || value.length > 400)) {
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
  handle(IPC.inverterDiscover, () => discoverSmaInverters());
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
  handle(IPC.p1Discover, () => discoverP1Meters());
  handle(IPC.p1Refresh, async () => {
    const reading = await p1.read();
    mainWindow?.webContents.send(IPC.p1Reading, reading);
    return reading;
  });
  handle(IPC.aiStatus, async () => {
    await secretsReady;
    return { hasKey: secrets.has('claudeApiKey') };
  });
  handle(IPC.aiTest, (model) => ai.test(assertModel(model)));
  handle(IPC.aiAbort, (requestId) => ai.abort(assertString(requestId, 'requestId')));
  handle(IPC.aiReadMeter, (model, photos) =>
    ai.readMeter(assertModel(model), assertPhotos(photos)),
  );
  ipcMain.handle(IPC.aiChat, (event, request: unknown) => {
    if (!fromApp(event)) {
      throw new Error('Appel refusé');
    }
    const chat = assertChat(request);
    // Le flux est relayé à la page qui l'a demandé ; la promesse se termine à la fin du flux.
    return ai.chat(chat, (payload) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(IPC.aiEvent, payload);
      }
    });
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
  const inverter = new InverterClient(() => secrets.get('inverterPsk'));
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  const pollOnce = async (): Promise<void> => {
    if (!inverter.enabled || !secrets.has('inverterPsk') || mainWindow === null) {
      return;
    }
    const reading = await inverter.read();
    mainWindow?.webContents.send(IPC.inverterReading, reading);
  };
  const pollInverter = (): void => {
    void secretsReady.then(() => {
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (inverter.enabled && secrets.has('inverterPsk')) {
        void pollOnce();
        pollTimer = setInterval(() => void pollOnce(), INVERTER_POLL_MS);
      }
    });
  };
  const p1 = new P1Client();
  let p1Timer: ReturnType<typeof setInterval> | null = null;
  const pollP1Once = async (): Promise<void> => {
    if (!p1.enabled || mainWindow === null) {
      return;
    }
    const reading = await p1.read();
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
  });
  registerIpc(store, ai, secrets, secretsReady, inverter, pollInverter, p1, pollP1);

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
