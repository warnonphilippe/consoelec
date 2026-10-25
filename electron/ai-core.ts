/**
 * Partie pure de l'intégration Claude (aucune dépendance à Electron) : construction des requêtes,
 * lecture du flux SSE, validation des réponses, messages d'erreur. Testée sans réseau.
 */
import type { AiChatRequest, Confidence, MeterPhoto, PhotoReading } from './shared/ipc-contract';

export const API_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';
export const CHAT_MAX_TOKENS = 4096;
export const METER_TOOL_NAME = 'report_meter_values';

export function apiHeaders(apiKey: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
  };
}

/** Requête de conversation en flux ; le contexte système est mis en cache (identique d'un tour à l'autre). */
export function buildChatBody(
  request: Pick<AiChatRequest, 'model' | 'system' | 'messages'>,
): Record<string, unknown> {
  return {
    model: request.model,
    max_tokens: CHAT_MAX_TOKENS,
    stream: true,
    system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
    messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
  };
}

export function buildTestBody(model: string): Record<string, unknown> {
  return {
    model,
    max_tokens: 16,
    messages: [{ role: 'user', content: 'Réponds simplement « ok ».' }],
  };
}

export interface SseEvent {
  readonly event: string;
  readonly data: string;
}

/** Lecteur incrémental d'un flux Server-Sent Events (les morceaux peuvent couper un événement en deux). */
export class SseParser {
  private buffer = '';

  push(chunk: string): SseEvent[] {
    this.buffer += chunk.replace(/\r\n/g, '\n');
    const events: SseEvent[] = [];
    let end = this.buffer.indexOf('\n\n');
    while (end !== -1) {
      const block = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      const event = parseBlock(block);
      if (event !== null) {
        events.push(event);
      }
      end = this.buffer.indexOf('\n\n');
    }
    return events;
  }
}

function parseBlock(block: string): SseEvent | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      data.push(line.slice(5).replace(/^ /, ''));
    }
  }
  return data.length > 0 ? { event, data: data.join('\n') } : null;
}

export type StreamStep =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'done' }
  | { readonly kind: 'ignore' };

/** Interprète un événement du flux : texte à afficher, fin du message, ou rien. Lève une erreur sur `error`. */
export function stepOf(event: SseEvent): StreamStep {
  let payload: unknown;
  try {
    payload = JSON.parse(event.data);
  } catch {
    return { kind: 'ignore' };
  }
  if (!isRecord(payload)) {
    return { kind: 'ignore' };
  }
  if (event.event === 'error' || payload['type'] === 'error') {
    const error = isRecord(payload['error']) ? payload['error'] : {};
    throw new Error(
      typeof error['message'] === 'string' ? error['message'] : 'Erreur du service Claude.',
    );
  }
  if (
    payload['type'] === 'content_block_delta' &&
    isRecord(payload['delta']) &&
    payload['delta']['type'] === 'text_delta'
  ) {
    const text = payload['delta']['text'];
    return typeof text === 'string' ? { kind: 'text', text } : { kind: 'ignore' };
  }
  if (payload['type'] === 'message_stop') {
    return { kind: 'done' };
  }
  return { kind: 'ignore' };
}

/** Message lisible pour une réponse HTTP en erreur. */
export function httpErrorMessage(status: number, body: string): string {
  let detail = '';
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      isRecord(parsed) &&
      isRecord(parsed['error']) &&
      typeof parsed['error']['message'] === 'string'
    ) {
      detail = parsed['error']['message'];
    }
  } catch {
    // corps non JSON : on se contente du code
  }
  const suffix = detail ? ` (${detail})` : '';
  switch (status) {
    case 400:
      return `Requête refusée par Claude${suffix}`;
    case 401:
      return 'Clé API refusée : vérifiez-la dans les réglages.';
    case 403:
      return `Accès refusé avec cette clé API${suffix}`;
    case 404:
      return `Modèle introuvable : choisissez un autre modèle dans les réglages${suffix}`;
    case 413:
      return 'Les données ou les photos sont trop volumineuses.';
    case 429:
      return `Limite d’utilisation atteinte, réessayez dans un instant${suffix}`;
    case 500:
    case 502:
    case 503:
    case 529:
      return 'Le service Claude est momentanément indisponible, réessayez dans un instant.';
    default:
      return `Erreur ${status} du service Claude${suffix}`;
  }
}

const METER_PROMPT = `Tu lis les index d'un compteur d'électricité communicant belge (compteur numérique à écran LCD, par exemple un Iskra IE.5) d'après une ou plusieurs photos.

Les registres à reporter sont :
- 1.8.1 : énergie soutirée du réseau en heures pleines (icône soleil, tarif T1) → importPeak
- 1.8.2 : énergie soutirée du réseau en heures creuses (icône lune, tarif T2) → importOff
- 2.8.1 : énergie injectée sur le réseau en heures pleines (icône soleil, T1) → exportPeak
- 2.8.2 : énergie injectée sur le réseau en heures creuses (icône lune, T2) → exportOff
Ignore les registres totaux 1.8.0 et 2.8.0 (sans tarif) : ils ne se reportent pas, mais ils aident à vérifier la lecture (1.8.0 = 1.8.1 + 1.8.2).
L'écran défile entre les registres : chaque photo n'en montre souvent qu'un seul. Repère le code OBIS affiché en haut à gauche de l'écran. Les valeurs sont en kWh, avec en général 6 chiffres avant la virgule et 2 après (ex. « 000705.94 » = 705,94). Un petit nombre en haut à droite de l'écran (ex. « 02 ») est la position dans la liste d'affichage, pas un index.
Une photo peut aussi être une capture d'écran de l'application de l'onduleur (SMA Energy, Sunny Portal ou équivalent) montrant la production totale (« rendement total », « Gesamtertrag », « production cumulée ») : reporte-la dans pvTotal, en kWh (convertis les MWh).

Règles : ne devine jamais. Si un registre n'est pas visible ou pas lisible avec certitude, mets null. Indique ta confiance (high : chiffres nets, medium : un doute sur un chiffre, low : lecture incertaine). Si l'écran montre une date et une heure, rapporte-les. Signale dans notes tout ce qui peut gêner (reflet, photo floue, registre ambigu).`;

export function buildMeterBody(
  model: string,
  photos: readonly MeterPhoto[],
): Record<string, unknown> {
  const confidence = { type: ['string', 'null'], enum: ['high', 'medium', 'low', null] };
  const value = {
    type: ['number', 'null'],
    description: 'Index en kWh, ou null si illisible/absent',
  };
  return {
    model,
    max_tokens: 1024,
    tools: [
      {
        name: METER_TOOL_NAME,
        description: 'Rapporte les index lus sur les photos du compteur.',
        input_schema: {
          type: 'object',
          properties: {
            importPeak: value,
            importOff: value,
            exportPeak: value,
            exportOff: value,
            pvTotal: value,
            displayedDate: {
              type: ['string', 'null'],
              description: 'Date/heure affichées, au format AAAA-MM-JJTHH:mm, ou null',
            },
            confidence: {
              type: 'object',
              properties: {
                importPeak: confidence,
                importOff: confidence,
                exportPeak: confidence,
                exportOff: confidence,
                pvTotal: confidence,
              },
            },
            notes: { type: 'string' },
          },
          required: ['importPeak', 'importOff', 'exportPeak', 'exportOff', 'notes'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: METER_TOOL_NAME },
    messages: [
      {
        role: 'user',
        content: [
          ...photos.map((p) => ({
            type: 'image',
            source: { type: 'base64', media_type: p.mediaType, data: p.base64 },
          })),
          { type: 'text', text: METER_PROMPT },
        ],
      },
    ],
  };
}

const CONFIDENCES: readonly Confidence[] = ['high', 'medium', 'low'];

function numberOrNull(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value.replace(/\s/g, '').replace(',', '.')) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n < 100_000_000 ? n : null;
}

function confidenceOf(value: unknown): Confidence | null {
  return CONFIDENCES.includes(value as Confidence) ? (value as Confidence) : null;
}

/** Valide et nettoie l'`input` du tool_use renvoyé par Claude. Lève une erreur si la réponse est inexploitable. */
export function parseMeterInput(input: unknown): PhotoReading {
  if (!isRecord(input)) {
    throw new Error('Claude n’a pas renvoyé de valeurs exploitables.');
  }
  const conf = isRecord(input['confidence']) ? input['confidence'] : {};
  const date =
    typeof input['displayedDate'] === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(input['displayedDate'])
      ? input['displayedDate'].slice(0, 16)
      : null;
  const reading: PhotoReading = {
    importPeak: numberOrNull(input['importPeak']),
    importOff: numberOrNull(input['importOff']),
    exportPeak: numberOrNull(input['exportPeak']),
    exportOff: numberOrNull(input['exportOff']),
    pvTotal: numberOrNull(input['pvTotal']),
    displayedDate: date,
    confidence: {
      importPeak: confidenceOf(conf['importPeak']),
      importOff: confidenceOf(conf['importOff']),
      exportPeak: confidenceOf(conf['exportPeak']),
      exportOff: confidenceOf(conf['exportOff']),
      pvTotal: confidenceOf(conf['pvTotal']),
    },
    notes: typeof input['notes'] === 'string' ? input['notes'].slice(0, 600) : '',
  };
  if (
    [
      reading.importPeak,
      reading.importOff,
      reading.exportPeak,
      reading.exportOff,
      reading.pvTotal,
    ].every((v) => v === null)
  ) {
    throw new Error(
      reading.notes || 'Aucun index n’est lisible sur cette photo. Cadrez l’écran de plus près.',
    );
  }
  return reading;
}

/** Extrait l'`input` du bloc tool_use d'une réponse non streamée. */
export function toolInputOf(response: unknown): unknown {
  if (isRecord(response) && Array.isArray(response['content'])) {
    for (const block of response['content']) {
      if (isRecord(block) && block['type'] === 'tool_use' && block['name'] === METER_TOOL_NAME) {
        return block['input'];
      }
    }
  }
  throw new Error('Claude n’a pas renvoyé de valeurs exploitables.');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
