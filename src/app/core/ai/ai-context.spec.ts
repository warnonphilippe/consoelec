import { analyze } from '../calc/analysis';
import { buildDemoData } from '../calc/demo-data';
import { dateToDayNumber } from '../calc/time';
import { emptyData } from '../models/app-data.model';
import { buildDataSnapshot, buildSystemPrompt } from './ai-context';

const NOW = new Date('2025-06-15T12:00:00');

describe('contexte de l’assistant', () => {
  it('contient toutes les données utiles, en JSON valide', () => {
    const data = buildDemoData(NOW);
    const day = dateToDayNumber(NOW);
    const prompt = buildSystemPrompt(data, analyze(data, day), day);
    const json = /<donnees>\n(.*)\n<\/donnees>/s.exec(prompt)![1]!;
    const snapshot = JSON.parse(json) as Record<string, unknown>;
    expect(Object.keys(snapshot)).toEqual(
      expect.arrayContaining([
        'maison',
        'releves',
        'mensuel',
        'annuel',
        'saisons',
        'referenceBelge',
        'previsions',
        'derniers12Mois',
      ]),
    );
    expect((snapshot['releves'] as unknown[]).length).toBe(data.readings.length);
    expect(prompt).toContain('soutirage');
  });

  it('fonctionne sans aucune donnée', () => {
    const data = emptyData();
    const snapshot = buildDataSnapshot(
      data,
      analyze(data, dateToDayNumber(NOW)),
      dateToDayNumber(NOW),
    );
    expect(snapshot['releves']).toEqual([]);
    expect(snapshot['derniers12Mois']).toBeNull();
    expect(snapshot['previsionsAvecVoiture']).toBeNull();
  });

  it('ne divulgue pas le thème ni le modèle IA', () => {
    const data = buildDemoData(NOW);
    const day = dateToDayNumber(NOW);
    const json = JSON.stringify(buildDataSnapshot(data, analyze(data, day), day));
    expect(json).not.toContain('aiModel');
    expect(json).not.toContain('theme');
  });
});
