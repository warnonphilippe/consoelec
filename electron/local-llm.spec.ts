import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalLlmService, NO_PHOTO_MESSAGE } from './local-llm';
import type { AiStreamEvent, LocalModelStatus } from './shared/ipc-contract';

const FILE_4B = 'Qwen3.5-4B-Q4_K_M.gguf';

/** Faux node-llama-cpp : enregistre l'historique reçu et répond par morceaux. */
function fakeLib(options: { failLlama?: boolean } = {}) {
  const seen: { history: unknown[]; prompt: string }[] = [];
  class QwenChatWrapper {
    constructor(readonly options: unknown = {}) {}
  }
  class LlamaChatSession {
    private history: unknown[] = [];
    constructor(readonly options: unknown) {}
    setChatHistory(history: unknown[]): void {
      this.history = history;
    }
    async prompt(
      text: string,
      opts: { onTextChunk?: (t: string) => void; signal?: AbortSignal } = {},
    ): Promise<string> {
      seen.push({ history: this.history, prompt: text });
      for (const chunk of ['Bon', 'jour']) {
        if (opts.signal?.aborted) {
          break;
        }
        opts.onTextChunk?.(chunk);
        await new Promise((r) => setTimeout(r, 1));
      }
      return 'Bonjour';
    }
    dispose(): void {}
  }
  const lib = {
    LlamaLogLevel: { error: 'error' },
    QwenChatWrapper,
    LlamaChatSession,
    resolveChatWrapper: () => new QwenChatWrapper(),
    getLlama: async () => {
      if (options.failLlama) {
        throw new Error('Metal absent');
      }
      return {
        loadModel: async () => ({
          dispose: async () => undefined,
          createContext: async () => ({ getSequence: () => ({}), dispose: async () => undefined }),
        }),
      };
    },
    createModelDownloader: async (o: {
      dirPath: string;
      fileName: string;
      onProgress: (p: { totalSize: number; downloadedSize: number }) => void;
    }) => ({
      download: async () => {
        o.onProgress({ totalSize: 100, downloadedSize: 50 });
        writeFileSync(join(o.dirPath, o.fileName), 'gguf');
        o.onProgress({ totalSize: 100, downloadedSize: 100 });
      },
      cancel: async () => undefined,
    }),
  };
  return { lib, seen };
}

describe('LocalLlmService', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'consoelec-llm-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const service = (lib: unknown, onStatus?: (s: LocalModelStatus) => void) =>
    new LocalLlmService(dir, onStatus, async () => lib as never);

  it('télécharge le modèle en signalant la progression', async () => {
    const statuses: LocalModelStatus[] = [];
    const llm = service(fakeLib().lib, (s) => statuses.push(s));
    expect(llm.status('qwen3.5-4b')).toMatchObject({ installed: false, downloading: false });
    expect(llm.startDownload('qwen3.5-4b').downloading).toBe(true);
    await vi.waitFor(() => expect(llm.status('qwen3.5-4b').installed).toBe(true));
    expect(existsSync(join(dir, FILE_4B))).toBe(true);
    expect(statuses.some((s) => s.progressPct === 50)).toBe(true);
    expect(statuses.at(-1)).toMatchObject({ installed: true, downloading: false });
  });

  it('diffuse la réponse en flux avec le contexte et l’historique', async () => {
    writeFileSync(join(dir, FILE_4B), 'gguf');
    const { lib, seen } = fakeLib();
    const events: AiStreamEvent[] = [];
    await service(lib).chat(
      {
        requestId: 'r1',
        provider: 'qwen',
        model: 'qwen3.5-4b',
        system: 'CTX',
        messages: [
          { role: 'user', content: 'Salut' },
          { role: 'assistant', content: 'Bonjour' },
          { role: 'user', content: 'Ma consommation ?' },
        ],
      },
      (e) => events.push(e),
    );
    expect(seen[0]).toEqual({
      prompt: 'Ma consommation ?',
      history: [
        { type: 'system', text: 'CTX' },
        { type: 'user', text: 'Salut' },
        { type: 'model', response: ['Bonjour'] },
      ],
    });
    expect(events).toEqual([
      { requestId: 'r1', type: 'delta', text: 'Bon' },
      { requestId: 'r1', type: 'delta', text: 'jour' },
      { requestId: 'r1', type: 'done' },
    ]);
  });

  it('demande de télécharger le modèle avant de répondre', async () => {
    const events: AiStreamEvent[] = [];
    await service(fakeLib().lib).chat(
      { requestId: 'r1', model: 'qwen3.5-4b', system: 'CTX', messages: [{ role: 'user', content: 'Q' }] },
      (e) => events.push(e),
    );
    expect(events).toEqual([
      { requestId: 'r1', type: 'error', message: expect.stringContaining('pas téléchargé') },
    ]);
  });

  it('ne lit pas les photos', async () => {
    await expect(service(fakeLib().lib).readMeter()).rejects.toThrow(NO_PHOTO_MESSAGE);
  });

  it('signale un moteur natif indisponible', async () => {
    writeFileSync(join(dir, FILE_4B), 'gguf');
    const llm = service(fakeLib({ failLlama: true }).lib);
    expect(await llm.probe()).toBe(false);
    expect(llm.status('qwen3.5-4b')).toMatchObject({ supported: false });
    const result = await llm.test('qwen3.5-4b');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Moteur local indisponible');
  });

  it('supprime le fichier du modèle', async () => {
    writeFileSync(join(dir, FILE_4B), 'gguf');
    const llm = service(fakeLib().lib);
    expect((await llm.test('qwen3.5-4b')).ok).toBe(true);
    expect((await llm.remove('qwen3.5-4b')).installed).toBe(false);
    expect(existsSync(join(dir, FILE_4B))).toBe(false);
  });
});
