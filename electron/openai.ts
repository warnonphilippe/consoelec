import { SseParser, isRecord, parseMeterInput } from './ai-core';
import type { FetchLike } from './ai';
import {
  OPENAI_API_URL,
  buildOpenAiChatBody,
  buildOpenAiMeterBody,
  buildOpenAiTestBody,
  openAiHeaders,
  openAiHttpErrorMessage,
  openAiStepOf,
  openAiToolInputOf,
} from './openai-core';
import type {
  AiChatRequest,
  AiStreamEvent,
  AiTestResult,
  MeterPhoto,
  PhotoReading,
} from './shared/ipc-contract';

const NO_KEY = 'Aucune clé API OpenAI : ajoutez-la dans les réglages.';
const OFFLINE = 'Impossible de joindre le service OpenAI : vérifiez la connexion internet.';

/** Appels à l'API OpenAI (Responses), faits uniquement depuis le process principal : la clé n'atteint jamais la page. */
export class OpenAiService {
  private readonly running = new Map<string, AbortController>();

  constructor(
    /** Fournit la clé API OpenAI (Trousseau) ou `null`. */
    private readonly apiKey: () => Promise<string | null>,
    private readonly fetchImpl: FetchLike,
    /** Adresse de l'API ; remplaçable uniquement en développement (serveur de test local). */
    private readonly apiUrl: string = OPENAI_API_URL,
  ) {}

  async test(model: string): Promise<AiTestResult> {
    try {
      const response = await this.post(buildOpenAiTestBody(model));
      await response.text();
      return { ok: true, message: 'Connexion réussie : la clé OpenAI et le modèle fonctionnent.' };
    } catch (error) {
      return { ok: false, message: messageOf(error) };
    }
  }

  async chat(request: AiChatRequest, emit: (event: AiStreamEvent) => void): Promise<void> {
    const controller = new AbortController();
    this.running.set(request.requestId, controller);
    try {
      const response = await this.post(buildOpenAiChatBody(request), controller.signal);
      if (response.body === null) {
        throw new Error('Réponse vide du service OpenAI.');
      }
      const parser = new SseParser();
      const decoder = new TextDecoder();
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        for (const event of parser.push(decoder.decode(value, { stream: true }))) {
          const step = openAiStepOf(event);
          if (step.kind === 'text') {
            emit({ requestId: request.requestId, type: 'delta', text: step.text });
          }
        }
      }
      emit({ requestId: request.requestId, type: 'done' });
    } catch (error) {
      if (controller.signal.aborted) {
        emit({ requestId: request.requestId, type: 'done' });
      } else {
        emit({ requestId: request.requestId, type: 'error', message: messageOf(error) });
      }
    } finally {
      this.running.delete(request.requestId);
    }
  }

  abort(requestId: string): void {
    this.running.get(requestId)?.abort();
  }

  async readMeter(model: string, photos: readonly MeterPhoto[]): Promise<PhotoReading> {
    const response = await this.post(buildOpenAiMeterBody(model, photos));
    const input = openAiToolInputOf(await response.json());
    if (!isRecord(input)) {
      throw new Error('OpenAI n’a pas renvoyé de valeurs exploitables.');
    }
    return parseMeterInput(input);
  }

  private async post(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    const key = await this.apiKey();
    if (key === null) {
      throw new Error(NO_KEY);
    }
    let response: Response;
    try {
      response = await this.fetchImpl(this.apiUrl, {
        method: 'POST',
        headers: openAiHeaders(key),
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      throw new Error(OFFLINE);
    }
    if (!response.ok) {
      throw new Error(openAiHttpErrorMessage(response.status, await response.text().catch(() => '')));
    }
    return response;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
