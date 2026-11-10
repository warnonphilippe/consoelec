import { AiService, type FetchLike } from './ai';
import type { AiStreamEvent } from './shared/ipc-contract';

const KEY = 'sk-ant-api03-cle-de-test-assez-longue';

function sse(...events: [string, unknown][]): string {
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

function streamOf(text: string, chunk = 40): Response {
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

describe('AiService', () => {
  // Clé API fournie au service, comme le magasin de secrets du process principal.
  let key: string | null;
  const secrets = {
    get: async () => key,
    set: async (value: string) => {
      key = value;
    },
  };

  beforeEach(() => {
    key = null;
  });

  it('refuse d’appeler l’API sans clé', async () => {
    const fetchImpl = vi.fn() as unknown as FetchLike;
    const service = new AiService(() => secrets.get(), fetchImpl);
    const result = await service.test('claude-sonnet-5-5');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('clé');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('envoie la clé dans l’en-tête et relaie le flux de texte', async () => {
    await secrets.set(KEY);
    const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] =
      [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({
        url,
        headers: init.headers,
        body: JSON.parse(init.body) as Record<string, unknown>,
      });
      return streamOf(
        sse(
          ['message_start', { type: 'message_start' }],
          [
            'content_block_delta',
            { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Bonjour ' } },
          ],
          [
            'content_block_delta',
            { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Philippe' } },
          ],
          ['message_stop', { type: 'message_stop' }],
        ),
      );
    };
    const events: AiStreamEvent[] = [];
    await new AiService(() => secrets.get(), fetchImpl).chat(
      {
        requestId: 'r1',
        model: 'claude-sonnet-5-5',
        system: 'CTX',
        messages: [{ role: 'user', content: 'Salut' }],
      },
      (e) => events.push(e),
    );
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0]!.headers['x-api-key']).toBe(KEY);
    expect(calls[0]!.headers['anthropic-version']).toBe('2023-06-01');
    expect(calls[0]!.body['stream']).toBe(true);
    expect(
      events
        .filter((e) => e.type === 'delta')
        .map((e) => (e as { text: string }).text)
        .join(''),
    ).toBe('Bonjour Philippe');
    expect(events.at(-1)).toEqual({ requestId: 'r1', type: 'done' });
  });

  it('transforme une erreur HTTP en message lisible, sans exposer la clé', async () => {
    await secrets.set(KEY);
    const fetchImpl: FetchLike = async () =>
      new Response('{"error":{"message":"invalid x-api-key"}}', { status: 401 });
    const events: AiStreamEvent[] = [];
    await new AiService(() => secrets.get(), fetchImpl).chat(
      { requestId: 'r2', model: 'm-test', system: '', messages: [] },
      (e) => events.push(e),
    );
    const error = events.find((e) => e.type === 'error') as { message: string } | undefined;
    expect(error?.message).toContain('Clé API refusée');
    expect(JSON.stringify(events)).not.toContain(KEY);
  });

  it('signale l’absence de connexion', async () => {
    await secrets.set(KEY);
    const fetchImpl: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };
    const result = await new AiService(() => secrets.get(), fetchImpl).test('claude-sonnet-5-5');
    expect(result).toEqual({ ok: false, message: expect.stringContaining('connexion') });
  });

  it('lit les index d’une photo via la sortie structurée', async () => {
    await secrets.set(KEY);
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          stop_reason: 'end_turn',
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                importPeak: 12345.6,
                importOff: 6789,
                exportPeak: null,
                exportOff: null,
                pvTotal: null,
                displayedDate: null,
                confidence: {
                  importPeak: 'high',
                  importOff: 'low',
                  exportPeak: null,
                  exportOff: null,
                  pvTotal: null,
                },
                notes: '',
              }),
            },
          ],
        }),
        { status: 200 },
      );
    const reading = await new AiService(() => secrets.get(), fetchImpl).readMeter(
      'claude-sonnet-5-5',
      [{ mediaType: 'image/jpeg', base64: 'AAAA' }],
    );
    expect(reading).toMatchObject({ importPeak: 12345.6, importOff: 6789, exportPeak: null });
    expect(reading.confidence.importOff).toBe('low');
  });

  it('interrompt un flux en cours', async () => {
    await secrets.set(KEY);
    let started: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => (started = resolve));
    const fetchImpl: FetchLike = async (_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init.signal?.addEventListener('abort', () =>
            controller.error(new DOMException('aborted', 'AbortError')),
          );
          started();
        },
      });
      return new Response(body, { status: 200 });
    };
    const service = new AiService(() => secrets.get(), fetchImpl);
    const events: AiStreamEvent[] = [];
    const running = service.chat(
      { requestId: 'r3', model: 'm-test', system: '', messages: [] },
      (e) => events.push(e),
    );
    await ready;
    service.abort('r3');
    await running;
    expect(events).toEqual([{ requestId: 'r3', type: 'done' }]);
  });
});
