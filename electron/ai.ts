import {
  API_URL,
  SseParser,
  apiHeaders,
  buildChatBody,
  buildMeterBody,
  buildTestBody,
  httpErrorMessage,
  meterOutputOf,
  parseMeterInput,
  stepOf,
} from './ai-core';
import type {
  AiChatRequest,
  AiStreamEvent,
  AiTestResult,
  MeterPhoto,
  PhotoReading,
} from './shared/ipc-contract';

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<Response>;

const NO_KEY =
  'Aucune clé API : ajoutez-la dans les réglages.';
const OFFLINE = 'Impossible de joindre le service Claude : vérifiez la connexion internet.';

/** Appels à l'API Claude, faits uniquement depuis le process principal : la clé n'atteint jamais la page. */
export class AiService {
  private readonly running = new Map<string, AbortController>();

  constructor(
    /** Fournit la clé API (Trousseau) ou `null`. */
    private readonly apiKey: () => Promise<string | null>,
    private readonly fetchImpl: FetchLike,
    /** Adresse de l'API ; remplaçable uniquement en développement (serveur de test local). */
    private readonly apiUrl: string = API_URL,
  ) {}

  async test(model: string): Promise<AiTestResult> {
    try {
      const response = await this.post(buildTestBody(model));
      await response.text();
      return { ok: true, message: 'Connexion réussie : la clé et le modèle fonctionnent.' };
    } catch (error) {
      return { ok: false, message: messageOf(error) };
    }
  }

  async chat(request: AiChatRequest, emit: (event: AiStreamEvent) => void): Promise<void> {
    const controller = new AbortController();
    this.running.set(request.requestId, controller);
    try {
      const response = await this.post(buildChatBody(request), controller.signal);
      if (response.body === null) {
        throw new Error('Réponse vide du service Claude.');
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
          const step = stepOf(event);
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
    const response = await this.post(buildMeterBody(model, photos));
    return parseMeterInput(meterOutputOf(await response.json()));
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
        headers: apiHeaders(key),
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
      throw new Error(httpErrorMessage(response.status, await response.text().catch(() => '')));
    }
    return response;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
