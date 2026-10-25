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
import { SecretStore } from './secrets';
import { DataFileStore } from './storage';
import {
  IPC,
  type AiChatRequest,
  type ExportKind,
  type MeterPhoto,
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

function registerIpc(store: DataFileStore, ai: AiService, secrets: SecretStore): void {
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
  handle(IPC.aiStatus, async () => ({
    hasKey: await secrets.hasKey(),
    encryptionAvailable: secrets.encryptionAvailable,
  }));
  handle(IPC.aiSetKey, (key) => secrets.set(assertString(key, 'key')));
  handle(IPC.aiClearKey, () => secrets.clear());
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

  const secrets = new SecretStore(join(app.getPath('userData'), 'secrets.bin'), safeStorage);
  const ai = new AiService(
    secrets,
    ((url, init) => net.fetch(url, init)) as FetchLike,
    DEV_API_URL,
  );
  registerIpc(store, ai, secrets);

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
