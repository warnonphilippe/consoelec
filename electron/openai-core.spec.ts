import { METER_TOOL_NAME, buildMeterBody } from './ai-core';
import {
  NO_CREDIT_MESSAGE,
  buildOpenAiChatBody,
  buildOpenAiMeterBody,
  openAiHeaders,
  openAiHttpErrorMessage,
  openAiStepOf,
  openAiToolInputOf,
} from './openai-core';

describe('openai-core', () => {
  it('construit une requête de conversation en flux, sans stockage chez OpenAI', () => {
    const body = buildOpenAiChatBody({
      model: 'gpt-6-astra',
      system: 'CTX',
      messages: [
        { role: 'user', content: 'Salut' },
        { role: 'assistant', content: 'Bonjour' },
        { role: 'user', content: 'Ça va ?' },
      ],
    });
    expect(body).toMatchObject({
      model: 'gpt-6-astra',
      instructions: 'CTX',
      stream: true,
      store: false,
      input: [
        { role: 'user', content: 'Salut' },
        { role: 'assistant', content: 'Bonjour' },
        { role: 'user', content: 'Ça va ?' },
      ],
    });
  });

  it('met la clé dans l’en-tête Authorization', () => {
    expect(openAiHeaders('sk-test')).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer sk-test',
    });
  });

  it('demande les index par un appel de fonction forcé, avec le schéma de Claude', () => {
    const body = buildOpenAiMeterBody('gpt-6-astra', [
      { mediaType: 'image/jpeg', base64: 'QUJD' },
    ]);
    const tools = body['tools'] as Record<string, unknown>[];
    expect(tools[0]).toMatchObject({ type: 'function', name: METER_TOOL_NAME });
    const claudeTools = buildMeterBody('m', [])['tools'] as Record<string, unknown>[];
    expect(tools[0]!['parameters']).toEqual(claudeTools[0]!['input_schema']);
    expect(body['tool_choice']).toEqual({ type: 'function', name: METER_TOOL_NAME });
    const input = body['input'] as { content: Record<string, unknown>[] }[];
    expect(input[0]!.content[0]).toMatchObject({
      type: 'input_image',
      image_url: 'data:image/jpeg;base64,QUJD',
    });
    expect(input[0]!.content[1]!['type']).toBe('input_text');
  });

  it('lit le texte, la fin et les erreurs du flux Responses', () => {
    const ev = (event: string, data: unknown) => ({ event, data: JSON.stringify(data) });
    expect(
      openAiStepOf(
        ev('response.output_text.delta', { type: 'response.output_text.delta', delta: 'Bon' }),
      ),
    ).toEqual({ kind: 'text', text: 'Bon' });
    expect(openAiStepOf(ev('response.completed', { type: 'response.completed' }))).toEqual({
      kind: 'done',
    });
    expect(openAiStepOf(ev('response.created', { type: 'response.created' }))).toEqual({
      kind: 'ignore',
    });
    expect(openAiStepOf({ event: 'message', data: '[DONE]' })).toEqual({ kind: 'done' });
    expect(() => openAiStepOf(ev('error', { type: 'error', message: 'Trop de requêtes' }))).toThrow(
      'Trop de requêtes',
    );
    expect(() =>
      openAiStepOf(
        ev('response.failed', {
          type: 'response.failed',
          response: { error: { message: 'Modèle surchargé' } },
        }),
      ),
    ).toThrow('Modèle surchargé');
    expect(() =>
      openAiStepOf(
        ev('error', {
          type: 'error',
          code: 'insufficient_quota',
          message: 'You have no credits remaining. Add credits to continue using the API.',
        }),
      ),
    ).toThrow(NO_CREDIT_MESSAGE);
  });

  it('extrait les arguments de l’appel de fonction', () => {
    const response = {
      output: [
        { type: 'reasoning', summary: [] },
        {
          type: 'function_call',
          name: METER_TOOL_NAME,
          arguments: JSON.stringify({ importPeak: 705.94, notes: '' }),
        },
      ],
    };
    expect(openAiToolInputOf(response)).toEqual({ importPeak: 705.94, notes: '' });
    expect(() => openAiToolInputOf({ output: [] })).toThrow('OpenAI');
  });

  it('traduit les erreurs HTTP en messages lisibles qui nomment OpenAI', () => {
    expect(openAiHttpErrorMessage(401, '')).toContain('Clé API OpenAI refusée');
    expect(
      openAiHttpErrorMessage(404, JSON.stringify({ error: { message: 'model not found' } })),
    ).toContain('model not found');
    expect(openAiHttpErrorMessage(429, '')).toContain('OpenAI');
    expect(openAiHttpErrorMessage(503, '')).toContain('indisponible');
    expect(
      openAiHttpErrorMessage(
        429,
        JSON.stringify({ error: { message: 'You have no credits remaining.', code: 'insufficient_quota' } }),
      ),
    ).toBe(NO_CREDIT_MESSAGE);
  });
});
