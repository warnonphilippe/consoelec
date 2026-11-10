import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { localModelInfo } from './shared/ai-models';
import type {
  AiChatRequest,
  AiStreamEvent,
  AiTestResult,
  LocalModelStatus,
} from './shared/ipc-contract';

/**
 * Modèle Qwen open source exécuté sur l'ordinateur par node-llama-cpp (Metal sur Mac), dans le process principal :
 * l'assistant fonctionne sans clé API et sans rien envoyer sur internet. Le fichier GGUF est téléchargé à la demande
 * dans `userData/models`. Le module natif n'est chargé qu'au premier usage : l'application démarre aussi vite qu'avant.
 * Repris de Plan Rando ; ici la réponse est diffusée en flux, comme celles de Claude.
 */

type NodeLlama = typeof import('node-llama-cpp');
type Llama = Awaited<ReturnType<NodeLlama['getLlama']>>;
type LlamaModel = Awaited<ReturnType<Llama['loadModel']>>;
type LlamaContext = Awaited<ReturnType<LlamaModel['createContext']>>;
type Downloader = Awaited<ReturnType<NodeLlama['createModelDownloader']>>;
type ChatWrapper = import('node-llama-cpp').ChatWrapper;
type ChatHistoryItem = import('node-llama-cpp').ChatHistoryItem;
type Sequence = ReturnType<LlamaContext['getSequence']>;

/** Le prompt système contient toutes les données de la maison : il faut un contexte large. */
const CONTEXT_SIZE = { min: 8192, max: 32_768 } as const;
const CHAT_MAX_TOKENS = 2048;

interface Loaded {
  readonly id: string;
  readonly model: LlamaModel;
  readonly context: LlamaContext;
  readonly sequence: Sequence;
  readonly wrapper: ChatWrapper;
}

interface Download {
  readonly id: string;
  downloader: Downloader | null;
  pct: number;
  received: number;
  total: number;
  error?: string;
  cancelled?: boolean;
}

export const NO_PHOTO_MESSAGE =
  'Le modèle Qwen local ne lit pas les photos : choisissez Claude ou OpenAI dans les réglages pour la lecture des index.';

export class LocalLlmService {
  private lib: Promise<NodeLlama> | null = null;
  private llama: Promise<Llama> | null = null;
  private loaded: Loaded | null = null;
  private supported: boolean | null = null;
  private loadError: string | undefined;
  private download: Download | null = null;
  private readonly running = new Map<string, AbortController>();
  /** Une seule génération à la fois (un seul contexte). */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    /** Dossier des modèles téléchargés. */
    private readonly dir: string,
    private readonly onStatus: (status: LocalModelStatus) => void = () => {},
    private readonly load: () => Promise<NodeLlama> = () => import('node-llama-cpp'),
  ) {}

  /** Fichier du modèle sur le disque (nom tiré de l'adresse). */
  private file(id: string): string {
    const info = localModelInfo(id);
    const name = basename(new URL(info.url).pathname) || `${info.id}.gguf`;
    return join(this.dir, name.endsWith('.gguf') ? name : `${name}.gguf`);
  }

  installed(id: string): boolean {
    const f = this.file(id);
    const downloading =
      this.download?.id === localModelInfo(id).id && !this.download.error && !this.download.cancelled;
    return existsSync(f) && !existsSync(`${f}.ipull`) && !downloading;
  }

  status(id: string): LocalModelStatus {
    const info = localModelInfo(id);
    const d = this.download?.id === info.id ? this.download : null;
    return {
      id: info.id,
      label: info.label,
      sizeMb: info.sizeMb,
      installed: this.installed(info.id),
      supported: this.supported !== false,
      downloading: d !== null && !d.error && !d.cancelled,
      ...(d && !d.error
        ? { progressPct: d.pct, receivedBytes: d.received, totalBytes: d.total || info.sizeMb * 1e6 }
        : {}),
      ...((d?.error ?? this.loadError) ? { error: d?.error ?? this.loadError } : {}),
    };
  }

  private lib$(): Promise<NodeLlama> {
    this.lib ??= this.load();
    return this.lib;
  }

  private llama$(): Promise<Llama> {
    this.llama ??= this.lib$()
      .then((m) =>
        m.getLlama({ build: 'never', progressLogs: false, logLevel: m.LlamaLogLevel.error }),
      )
      .then(
        (llama) => {
          this.supported = true;
          return llama;
        },
        (error: unknown) => {
          this.supported = false;
          this.loadError = `Moteur local indisponible sur cet ordinateur : ${messageOf(error)}`;
          this.llama = null;
          throw new Error(this.loadError);
        },
      );
    return this.llama;
  }

  /** Vérifie que le moteur natif se charge (appelé au démarrage, en arrière-plan). */
  async probe(): Promise<boolean> {
    try {
      await this.llama$();
      return true;
    } catch {
      return false;
    }
  }

  startDownload(modelId: string): LocalModelStatus {
    const id = localModelInfo(modelId).id;
    if (this.download && !this.download.error && !this.download.cancelled) {
      return this.status(id);
    }
    if (this.installed(id)) {
      return this.status(id);
    }
    mkdirSync(this.dir, { recursive: true });
    const state: Download = { id, downloader: null, pct: 0, received: 0, total: 0 };
    this.download = state;
    this.onStatus(this.status(id));
    void (async () => {
      try {
        const m = await this.lib$();
        let last = -1;
        state.downloader = await m.createModelDownloader({
          modelUri: localModelInfo(id).url,
          dirPath: this.dir,
          fileName: basename(this.file(id)),
          showCliProgress: false,
          deleteTempFileOnCancel: true,
          onProgress: ({ totalSize, downloadedSize }) => {
            state.received = downloadedSize;
            state.total = totalSize;
            state.pct = totalSize ? Math.floor((downloadedSize / totalSize) * 100) : 0;
            if (state.pct !== last) {
              last = state.pct;
              this.onStatus(this.status(id));
            }
          },
        });
        if (state.cancelled) {
          return;
        }
        await state.downloader.download();
        if (this.download === state) {
          this.download = null;
        }
      } catch (error) {
        if (!state.cancelled) {
          state.error = `Téléchargement interrompu : ${messageOf(error)}`;
        }
      }
      this.onStatus(this.status(id));
    })();
    return this.status(id);
  }

  async cancelDownload(modelId: string): Promise<LocalModelStatus> {
    const d = this.download;
    if (d) {
      d.cancelled = true;
      await d.downloader?.cancel({ deleteTempFile: true }).catch(() => undefined);
      this.download = null;
    }
    const status = this.status(modelId);
    this.onStatus(status);
    return status;
  }

  /** Supprime le modèle du disque (et le décharge de la mémoire). */
  async remove(modelId: string): Promise<LocalModelStatus> {
    const id = localModelInfo(modelId).id;
    if (this.download?.id === id) {
      await this.cancelDownload(id);
    }
    if (this.loaded?.id === id) {
      await this.unload();
    }
    const f = this.file(id);
    for (const name of existsSync(this.dir) ? readdirSync(this.dir) : []) {
      const path = join(this.dir, name);
      if (path === f || path.startsWith(`${f}.`)) {
        rmSync(path, { force: true });
      }
    }
    const status = this.status(id);
    this.onStatus(status);
    return status;
  }

  private async unload(): Promise<void> {
    const l = this.loaded;
    this.loaded = null;
    await l?.context.dispose().catch(() => undefined);
    await l?.model.dispose().catch(() => undefined);
  }

  private async context(modelId: string): Promise<Loaded> {
    const id = localModelInfo(modelId).id;
    if (this.loaded?.id === id) {
      return this.loaded;
    }
    await this.unload();
    if (!this.installed(id)) {
      throw new Error(
        'Le modèle Qwen n’est pas téléchargé : téléchargez-le dans Réglages → Assistant IA.',
      );
    }
    const llama = await this.llama$();
    const m = await this.lib$();
    const model = await llama.loadModel({ modelPath: this.file(id) });
    const context = await model.createContext({ contextSize: CONTEXT_SIZE });
    // Qwen 3.5 « réfléchit » avant de répondre : plus lent, et inutile pour l'assistant.
    const auto = m.resolveChatWrapper(model);
    const wrapper: ChatWrapper =
      auto instanceof m.QwenChatWrapper ? new m.QwenChatWrapper({ thoughts: 'discourage' }) : auto;
    // Une seule séquence, gardée d'une question à l'autre : le début commun (données, historique) n'est pas réévalué.
    this.loaded = { id, model, context, sequence: context.getSequence(), wrapper };
    return this.loaded;
  }

  /** Exécute `run` après les générations en cours. */
  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  test(modelId: string): Promise<AiTestResult> {
    return this.enqueue(async () => {
      try {
        const m = await this.lib$();
        const { sequence, wrapper } = await this.context(modelId);
        const session = new m.LlamaChatSession({
          contextSequence: sequence,
          chatWrapper: wrapper,
          autoDisposeSequence: false,
        });
        try {
          await session.prompt('Réponds simplement « ok ».', { maxTokens: 16 });
        } finally {
          session.dispose({ disposeSequence: false });
        }
        return {
          ok: true,
          message: 'Le modèle Qwen fonctionne sur cet ordinateur (aucune donnée n’est envoyée).',
        };
      } catch (error) {
        return { ok: false, message: messageOf(error) };
      }
    });
  }

  async chat(request: AiChatRequest, emit: (event: AiStreamEvent) => void): Promise<void> {
    const controller = new AbortController();
    this.running.set(request.requestId, controller);
    try {
      await this.enqueue(async () => {
        if (controller.signal.aborted) {
          return;
        }
        const last = request.messages.at(-1);
        if (last === undefined || last.role !== 'user') {
          throw new Error('Question manquante.');
        }
        const m = await this.lib$();
        const { sequence, wrapper } = await this.context(request.model);
        const session = new m.LlamaChatSession({
          contextSequence: sequence,
          chatWrapper: wrapper,
          autoDisposeSequence: false,
        });
        try {
          session.setChatHistory([
            { type: 'system', text: request.system },
            ...request.messages.slice(0, -1).map(
              (msg): ChatHistoryItem =>
                msg.role === 'user'
                  ? { type: 'user', text: msg.content }
                  : { type: 'model', response: [msg.content] },
            ),
          ]);
          await session.prompt(last.content, {
            maxTokens: CHAT_MAX_TOKENS,
            signal: controller.signal,
            stopOnAbortSignal: true,
            onTextChunk: (text) => {
              if (!controller.signal.aborted) {
                emit({ requestId: request.requestId, type: 'delta', text });
              }
            },
          });
        } finally {
          session.dispose({ disposeSequence: false });
        }
      });
      emit({ requestId: request.requestId, type: 'done' });
    } catch (error) {
      if (controller.signal.aborted) {
        emit({ requestId: request.requestId, type: 'done' });
      } else {
        emit({ requestId: request.requestId, type: 'error', message: chatErrorOf(error) });
      }
    } finally {
      this.running.delete(request.requestId);
    }
  }

  abort(requestId: string): void {
    this.running.get(requestId)?.abort();
  }

  readMeter(): Promise<never> {
    return Promise.reject(new Error(NO_PHOTO_MESSAGE));
  }

  async dispose(): Promise<void> {
    if (this.download) {
      await this.cancelDownload(this.download.id);
    }
    await this.unload();
  }
}

function chatErrorOf(error: unknown): string {
  const message = messageOf(error);
  if (/context size|too long|exceed/i.test(message)) {
    return 'Vos données dépassent la mémoire de travail du modèle Qwen local : choisissez Claude ou OpenAI pour cette question.';
  }
  return message;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
