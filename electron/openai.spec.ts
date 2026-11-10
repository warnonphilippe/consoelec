import { METER_TOOL_NAME } from './ai-core';
import type { FetchLike } from './ai';
import { OpenAiService } from './openai';
import type { AiStreamEvent } from './shared/ipc-contract';

const KEY = 'sk-proj-cle-de-test-assez-longue';

function sse(...events: [string, unknown][]): string {
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

function streamOf(text: string, chunk = 37): Response {
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunk) {
        controller.enqueue(bytes.slice(i, i + chunk));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const chatRequest = {
  requestId: 'r1',
  provider: 'openai' as const,
  model: 'gpt-6-astra',
  system: 'CTX',
  messages: [{ role: 'user' as const, content: 'Salut' }],
};

describe('OpenAiService', () => {
  it('refuse d’appeler l’API sans clé', async () => {
    const fetchImpl = vi.fn() as unknown as FetchLike;
    const result = await new OpenAiService(async () => null, fetchImpl).test('gpt-6-astra');
    expect(result).toEqual({ ok: false, message: expect.stringContaining('clé API OpenAI') });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('envoie la clé et relaie le flux de texte', async () => {
    const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] =
      [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> });
      return streamOf(
        sse(
          ['response.created', { type: 'response.created' }],
          ['response.output_text.delta', { type: 'response.output_text.delta', delta: 'Bonjour ' }],
          ['response.output_text.delta', { type: 'response.output_text.delta', delta: 'Philippe' }],
          ['response.completed', { type: 'response.completed' }],
        ),
      );
    };
    const events: AiStreamEvent[] = [];
    await new OpenAiService(async () => KEY, fetchImpl).chat(chatRequest, (e) => events.push(e));
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/responses');
    expect(calls[0]!.headers['authorization']).toBe(`Bearer ${KEY}`);
    expect(calls[0]!.body).toMatchObject({ model: 'gpt-6-astra', instructions: 'CTX', stream: true });
    expect(events).toEqual([
      { requestId: 'r1', type: 'delta', text: 'Bonjour ' },
      { requestId: 'r1', type: 'delta', text: 'Philippe' },
      { requestId: 'r1', type: 'done' },
    ]);
  });

  it('signale une erreur HTTP par un événement lisible', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ error: { message: 'Incorrect API key' } }), { status: 401 });
    const events: AiStreamEvent[] = [];
    await new OpenAiService(async () => KEY, fetchImpl).chat(chatRequest, (e) => events.push(e));
    expect(events).toEqual([
      { requestId: 'r1', type: 'error', message: expect.stringContaining('Clé API OpenAI refusée') },
    ]);
  });

  it('signale une coupure réseau', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };
    const result = await new OpenAiService(async () => KEY, fetchImpl).test('gpt-6-astra');
    expect(result.message).toContain('Impossible de joindre le service OpenAI');
  });

  it('termine proprement quand la réponse est arrêtée', async () => {
    let release: (() => void) | null = null;
    const fetchImpl: FetchLike = async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        release = () => reject(new DOMException('aborted', 'AbortError'));
        init.signal?.addEventListener('abort', () => release?.());
      });
    const service = new OpenAiService(async () => KEY, fetchImpl);
    const events: AiStreamEvent[] = [];
    const done = service.chat(chatRequest, (e) => events.push(e));
    await vi.waitFor(() => expect(release).not.toBeNull());
    service.abort('r1');
    await done;
    expect(events).toEqual([{ requestId: 'r1', type: 'done' }]);
  });

  it('lit les index renvoyés par l’appel de fonction', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          output: [
            {
              type: 'function_call',
              name: METER_TOOL_NAME,
              arguments: JSON.stringify({
                importPeak: 705.94,
                importOff: 1203.5,
                exportPeak: null,
                exportOff: null,
                confidence: { importPeak: 'high', importOff: 'medium' },
                notes: 'Reflet léger',
              }),
            },
          ],
        }),
        { status: 200 },
      );
    const reading = await new OpenAiService(async () => KEY, fetchImpl).readMeter('gpt-6-astra', [
      { mediaType: 'image/jpeg', base64: 'QUJD' },
    ]);
    expect(reading.importPeak).toBe(705.94);
    expect(reading.importOff).toBe(1203.5);
    expect(reading.confidence.importPeak).toBe('high');
    expect(reading.notes).toBe('Reflet léger');
  });
});
