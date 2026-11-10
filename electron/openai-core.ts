/**
 * Partie pure de l'intégration OpenAI (API Responses, sans SDK ni dépendance à Electron) : construction des requêtes,
 * lecture du flux SSE, extraction de l'appel de fonction, messages d'erreur. Testée sans réseau.
 */
import {
  METER_PROMPT,
  METER_TOOL_NAME,
  isRecord,
  meterInputSchema,
  type SseEvent,
  type StreamStep,
} from './ai-core';
import type { AiChatRequest, MeterPhoto } from './shared/ipc-contract';

export const OPENAI_API_URL = 'https://api.openai.com/v1/responses';
/** Les modèles OpenAI raisonnent avant de répondre : le budget comprend ce raisonnement. */
export const OPENAI_CHAT_MAX_TOKENS = 16_000;

export function openAiHeaders(apiKey: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
  };
}

/** Requête de conversation en flux ; rien n'est conservé chez OpenAI (`store: false`). */
export function buildOpenAiChatBody(
  request: Pick<AiChatRequest, 'model' | 'system' | 'messages'>,
): Record<string, unknown> {
  return {
    model: request.model,
    instructions: request.system,
    input: request.messages.map((m) => ({ role: m.role, content: m.content })),
    max_output_tokens: OPENAI_CHAT_MAX_TOKENS,
    reasoning: { effort: 'low' },
    stream: true,
    store: false,
  };
}

export function buildOpenAiTestBody(model: string): Record<string, unknown> {
  return {
    model,
    input: 'Réponds simplement « ok ».',
    max_output_tokens: 64,
    reasoning: { effort: 'low' },
    store: false,
  };
}

/** Lecture des index sur photo : même consigne et même schéma que Claude, rendus par un appel de fonction forcé. */
export function buildOpenAiMeterBody(
  model: string,
  photos: readonly MeterPhoto[],
): Record<string, unknown> {
  return {
    model,
    max_output_tokens: 8000,
    reasoning: { effort: 'low' },
    store: false,
    tools: [
      {
        type: 'function',
        name: METER_TOOL_NAME,
        description: 'Rapporte les index lus sur les photos du compteur.',
        parameters: meterInputSchema(),
        strict: false,
      },
    ],
    tool_choice: { type: 'function', name: METER_TOOL_NAME },
    input: [
      {
        role: 'user',
        content: [
          ...photos.map((p) => ({
            type: 'input_image',
            image_url: `data:${p.mediaType};base64,${p.base64}`,
            detail: 'high',
          })),
          { type: 'input_text', text: METER_PROMPT },
        ],
      },
    ],
  };
}

/** Interprète un événement du flux Responses : texte à afficher, fin, ou rien. Lève une erreur en cas d'échec. */
export function openAiStepOf(event: SseEvent): StreamStep {
  if (event.data === '[DONE]') {
    return { kind: 'done' };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(event.data);
  } catch {
    return { kind: 'ignore' };
  }
  if (!isRecord(payload)) {
    return { kind: 'ignore' };
  }
  const type = typeof payload['type'] === 'string' ? payload['type'] : event.event;
  switch (type) {
    case 'response.output_text.delta': {
      const delta = payload['delta'];
      return typeof delta === 'string' ? { kind: 'text', text: delta } : { kind: 'ignore' };
    }
    case 'response.completed':
    case 'response.incomplete':
      return { kind: 'done' };
    case 'error':
      throw new Error(streamErrorOf(payload) ?? 'Erreur du service OpenAI.');
    case 'response.failed': {
      const response = isRecord(payload['response']) ? payload['response'] : {};
      throw new Error(streamErrorOf(response) ?? 'Le service OpenAI n’a pas pu répondre.');
    }
    default:
      return { kind: 'ignore' };
  }
}

export const NO_CREDIT_MESSAGE =
  'Crédit OpenAI épuisé : ajoutez du crédit sur platform.openai.com (Settings → Billing), ou choisissez un autre moteur.';

/** Code d'erreur OpenAI (`code` direct ou `error.code`). */
function errorCodeOf(value: Record<string, unknown>): string | null {
  if (typeof value['code'] === 'string') {
    return value['code'];
  }
  const error = value['error'];
  return isRecord(error) && typeof error['code'] === 'string' ? error['code'] : null;
}

function isNoCredit(value: Record<string, unknown>, message: string | null): boolean {
  return errorCodeOf(value) === 'insufficient_quota' || /no credits remaining|exceeded your current quota/i.test(message ?? '');
}

/** Message d'une erreur reçue dans le flux, en français quand le cas est connu. */
function streamErrorOf(value: Record<string, unknown>): string | null {
  const message = errorMessageOf(value);
  if (isNoCredit(value, message)) {
    return NO_CREDIT_MESSAGE;
  }
  return message === null ? null : `OpenAI : ${message}`;
}

/** `message` direct ou `error.message`. */
function errorMessageOf(value: Record<string, unknown>): string | null {
  if (typeof value['message'] === 'string') {
    return value['message'];
  }
  const error = value['error'];
  return isRecord(error) && typeof error['message'] === 'string' ? error['message'] : null;
}

/** Message lisible pour une réponse HTTP en erreur. */
export function openAiHttpErrorMessage(status: number, body: string): string {
  let detail = '';
  let noCredit = false;
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed)) {
      detail = errorMessageOf(parsed) ?? '';
      noCredit = isNoCredit(parsed, detail);
    }
  } catch {
    // corps non JSON : on se contente du code
  }
  if (noCredit) {
    return NO_CREDIT_MESSAGE;
  }
  const suffix = detail ? ` (${detail})` : '';
  switch (status) {
    case 400:
      return `Requête refusée par OpenAI${suffix}`;
    case 401:
      return 'Clé API OpenAI refusée : vérifiez-la dans les réglages.';
    case 403:
      return `Accès refusé avec cette clé API OpenAI${suffix}`;
    case 404:
      return `Modèle OpenAI introuvable : choisissez un autre modèle dans les réglages${suffix}`;
    case 413:
      return 'Les données ou les photos sont trop volumineuses.';
    case 429:
      return `Limite d’utilisation OpenAI atteinte ou crédit épuisé, réessayez plus tard${suffix}`;
    case 500:
    case 502:
    case 503:
      return 'Le service OpenAI est momentanément indisponible, réessayez dans un instant.';
    default:
      return `Erreur ${status} du service OpenAI${suffix}`;
  }
}

/** Extrait les arguments (JSON) de l'appel de fonction d'une réponse non streamée. */
export function openAiToolInputOf(response: unknown): unknown {
  if (isRecord(response) && Array.isArray(response['output'])) {
    for (const item of response['output']) {
      if (
        isRecord(item) &&
        item['type'] === 'function_call' &&
        item['name'] === METER_TOOL_NAME &&
        typeof item['arguments'] === 'string'
      ) {
        try {
          return JSON.parse(item['arguments']);
        } catch {
          break;
        }
      }
    }
  }
  throw new Error('OpenAI n’a pas renvoyé de valeurs exploitables.');
}
