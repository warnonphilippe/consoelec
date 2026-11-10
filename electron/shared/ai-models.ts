/**
 * Modèles proposés pour les moteurs OpenAI et Qwen (Claude : `AI_MODELS` dans le modèle de données de la page).
 * Partagé par le process principal et la page.
 */
export interface OpenAiModelInfo {
  readonly id: string;
  readonly label: string;
}

/** Modèles OpenAI proposés (le premier est utilisé par défaut). */
export const OPENAI_MODELS: readonly OpenAiModelInfo[] = [
  { id: 'gpt-6-astra', label: 'GPT-6 Astra (recommandé)' },
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol (plus économique)' },
];

export const DEFAULT_OPENAI_MODEL = 'gpt-6-astra';

/** Modèle Qwen open source (licence Apache 2.0), exécuté sur l'ordinateur ; fichier GGUF téléchargé une fois. */
export interface LocalModelInfo {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** Taille du fichier à télécharger (Mo). */
  readonly sizeMb: number;
  /** Mémoire vive conseillée, en Go. */
  readonly ramGb: number;
  readonly url: string;
}

export const LOCAL_MODELS: readonly LocalModelInfo[] = [
  {
    id: 'qwen3.5-4b',
    label: 'Qwen 3.5 4B (recommandé)',
    description: 'Bon équilibre entre qualité des analyses et rapidité.',
    sizeMb: 2740,
    ramGb: 8,
    url: 'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf',
  },
  {
    id: 'qwen3.5-2b',
    label: 'Qwen 3.5 2B (léger)',
    description: 'Le plus rapide, pour les ordinateurs modestes. Réponses plus simples.',
    sizeMb: 1280,
    ramGb: 8,
    url: 'https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/main/Qwen3.5-2B-Q4_K_M.gguf',
  },
];

export const DEFAULT_LOCAL_MODEL = 'qwen3.5-4b';

export function localModelInfo(id: string): LocalModelInfo {
  return LOCAL_MODELS.find((m) => m.id === id) ?? LOCAL_MODELS[0]!;
}
