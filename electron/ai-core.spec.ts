import {
  SseParser,
  buildChatBody,
  buildMeterBody,
  httpErrorMessage,
  parseMeterInput,
  stepOf,
  meterOutputOf,
  meterOutputSchema,
} from './ai-core';

describe('flux SSE', () => {
  it('reconstitue les événements coupés en plusieurs morceaux', () => {
    const parser = new SseParser();
    const sse =
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Bon"}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"jour"}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    const events = [
      ...parser.push(sse.slice(0, 50)),
      ...parser.push(sse.slice(50, 140)),
      ...parser.push(sse.slice(140)),
    ];
    const steps = events.map(stepOf);
    expect(steps).toEqual([
      { kind: 'text', text: 'Bon' },
      { kind: 'text', text: 'jour' },
      { kind: 'done' },
    ]);
  });

  it('ignore les événements sans intérêt et lève sur une erreur du flux', () => {
    expect(stepOf({ event: 'ping', data: '{"type":"ping"}' })).toEqual({ kind: 'ignore' });
    expect(stepOf({ event: 'x', data: 'pas du json' })).toEqual({ kind: 'ignore' });
    expect(() =>
      stepOf({ event: 'error', data: '{"type":"error","error":{"message":"Surchargé"}}' }),
    ).toThrow('Surchargé');
  });
});

describe('requêtes', () => {
  it('met le contexte en cache et demande un flux', () => {
    const body = buildChatBody({
      model: 'claude-sonnet-5-5',
      system: 'CTX',
      messages: [{ role: 'user', content: 'Salut' }],
    });
    expect(body['stream']).toBe(true);
    expect(body['system']).toEqual([
      { type: 'text', text: 'CTX', cache_control: { type: 'ephemeral' } },
    ]);
    expect(body['messages']).toEqual([{ role: 'user', content: 'Salut' }]);
  });

  it('demande les index en sortie structurée (sans outil forcé) avec les images', () => {
    const body = buildMeterBody('claude-sonnet-5-5', [{ mediaType: 'image/jpeg', base64: 'AAAA' }]);
    expect(body['tool_choice']).toBeUndefined();
    expect(body['tools']).toBeUndefined();
    expect(body['output_config']).toEqual({
      format: { type: 'json_schema', schema: meterOutputSchema() },
    });
    const content = (body['messages'] as { content: { type: string }[] }[])[0]!.content;
    expect(content.map((c) => c.type)).toEqual(['image', 'text']);
  });

  it('traduit les erreurs HTTP', () => {
    expect(httpErrorMessage(401, '')).toContain('Clé API refusée');
    expect(httpErrorMessage(429, '{"error":{"message":"rate"}}')).toContain('rate');
    expect(httpErrorMessage(529, '')).toContain('indisponible');
  });
});

describe('lecture de photo', () => {
  it('valide et nettoie le résultat de l’outil', () => {
    const reading = parseMeterInput({
      importPeak: '12 345,6',
      importOff: 6789.1,
      exportPeak: null,
      exportOff: -3,
      displayedDate: '2025-03-01T08:15:00',
      confidence: { importPeak: 'high', importOff: 'medium', exportPeak: 'bof' },
      notes: 'reflet',
    });
    expect(reading).toMatchObject({
      importPeak: 12345.6,
      importOff: 6789.1,
      exportPeak: null,
      exportOff: null,
      displayedDate: '2025-03-01T08:15',
      notes: 'reflet',
    });
    expect(reading.confidence).toMatchObject({
      importPeak: 'high',
      importOff: 'medium',
      exportPeak: null,
    });
  });

  it('refuse une photo où rien n’est lisible', () => {
    expect(() =>
      parseMeterInput({
        importPeak: null,
        importOff: null,
        exportPeak: null,
        exportOff: null,
        notes: 'Photo floue',
      }),
    ).toThrow('Photo floue');
    expect(() => parseMeterInput('n’importe quoi')).toThrow();
  });

  it('lit le JSON de la sortie structurée', () => {
    expect(
      meterOutputOf({
        stop_reason: 'end_turn',
        content: [
          { type: 'thinking', thinking: '' },
          { type: 'text', text: '{"importPeak":1,"notes":""}' },
        ],
      }),
    ).toEqual({ importPeak: 1, notes: '' });
    expect(() => meterOutputOf({ content: [] })).toThrow('valeurs exploitables');
    expect(() => meterOutputOf({ content: [{ type: 'text', text: 'pas du JSON' }] })).toThrow();
    expect(() => meterOutputOf({ stop_reason: 'refusal', content: [] })).toThrow('refusé');
    expect(() => meterOutputOf({ stop_reason: 'max_tokens', content: [] })).toThrow('coupée');
  });

  it('ferme tous les objets du schéma et rend chaque champ requis', () => {
    const check = (schema: Record<string, unknown>): void => {
      if (schema['type'] === 'object') {
        expect(schema['additionalProperties']).toBe(false);
        const props = schema['properties'] as Record<string, Record<string, unknown>>;
        expect([...(schema['required'] as string[])].sort()).toEqual(Object.keys(props).sort());
        Object.values(props).forEach(check);
      }
    };
    check(meterOutputSchema());
  });
});
