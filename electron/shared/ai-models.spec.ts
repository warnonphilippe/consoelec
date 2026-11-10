import { DEFAULT_LOCAL_MODEL, LOCAL_MODELS, localModelInfo } from './ai-models';

describe('ai-models', () => {
  it('propose le modèle Qwen recommandé par défaut', () => {
    expect(LOCAL_MODELS.some((m) => m.id === DEFAULT_LOCAL_MODEL)).toBe(true);
    expect(localModelInfo('inconnu').id).toBe(DEFAULT_LOCAL_MODEL);
  });

  it('décrit chaque modèle local (taille, mémoire, fichier GGUF)', () => {
    for (const m of LOCAL_MODELS) {
      expect(m.description.length).toBeGreaterThan(10);
      expect(m.sizeMb).toBeGreaterThan(500);
      expect(m.ramGb).toBeGreaterThanOrEqual(8);
      expect(m.url).toMatch(/^https:\/\/huggingface\.co\/.+\.gguf$/);
    }
  });
});
