import { analyze } from '../calc/analysis';
import { buildDemoData } from '../calc/demo-data';
import { dateToDayNumber } from '../calc/time';
import { emptyData } from '../models/app-data.model';
import type { MazoutSummary } from '../link/household-summary';
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

  it('joint le résumé de ConsoMazout avec son âge, seulement s’il existe', () => {
    const data = buildDemoData(NOW);
    const day = dateToDayNumber(NOW);
    const analysis = analyze(data, day);
    expect(buildSystemPrompt(data, analysis, day)).not.toContain('<donnees_consomazout ageJours');
    const peer = {
      schema: 1,
      application: 'consomazout',
      genereLe: '2025-06-05T10:00:00.000Z',
      estimationAnnuelle: { litres: 2200, equivalentKwh: 22000 },
    } as unknown as MazoutSummary;
    const prompt = buildSystemPrompt(data, analysis, day, peer);
    const block = /<donnees_consomazout ageJours="(\d+)">\n(.*)\n<\/donnees_consomazout>/s.exec(prompt)!;
    expect(block[1]).toBe('10');
    expect(JSON.parse(block[2]!).estimationAnnuelle.litres).toBe(2200);
  });
});
