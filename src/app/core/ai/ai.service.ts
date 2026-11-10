import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { LOCAL_MODELS, localModelInfo } from '../../../../electron/shared/ai-models';
import type {
  AiProvider,
  AiStreamEvent,
  LocalModelStatus,
  MeterPhoto,
  PhotoReading,
} from '../../../../electron/shared/ipc-contract';
import { newId } from '../models/normalize';
import { DataStore } from '../services/data-store.service';
import { SecretsService } from '../services/secrets.service';
import { buildSystemPrompt } from './ai-context';

export interface ChatMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly error?: boolean;
}

export const PROVIDER_LABELS: Readonly<Record<AiProvider, string>> = {
  claude: 'Claude',
  openai: 'OpenAI',
  qwen: 'Qwen',
};

/**
 * Assistant IA : état de la conversation, clés API (jamais lues côté page), modèle Qwen local et lecture de photos.
 * Moteurs : Claude (recommandé), OpenAI, ou Qwen exécuté sur l'ordinateur sans clé.
 */
@Injectable({ providedIn: 'root' })
export class AiService {
  private readonly store = inject(DataStore);
  private readonly secrets = inject(SecretsService);
  private readonly api = typeof window !== 'undefined' ? (window.consoElec?.ai ?? null) : null;

  /** Les appels à Claude passent par l'application de bureau ; pas disponibles dans un simple navigateur. */
  readonly available = this.api !== null;
  /** Une clé API Claude est enregistrée dans le Trousseau. */
  readonly hasKey = computed(() => this.secrets.has('claudeApiKey'));
  /** Une clé API OpenAI est enregistrée dans le Trousseau. */
  readonly hasOpenAiKey = computed(() => this.secrets.has('openaiApiKey'));
  /** État de chaque modèle Qwen local, par identifiant. */
  readonly localStatuses = signal<Readonly<Record<string, LocalModelStatus>>>({});
  /** Modèle Qwen choisi. */
  readonly localModel = computed(() => localModelInfo(this.store.settings().localModel));
  /** État du modèle Qwen choisi (`null` tant qu'il n'est pas connu). */
  readonly localStatus = computed(() => this.localStatuses()[this.localModel().id] ?? null);
  /** Modèle Qwen en cours de téléchargement, s'il y en a un. */
  readonly downloading = computed(
    () => Object.values(this.localStatuses()).find((s) => s.downloading) ?? null,
  );

  /** Moteur choisi dans les réglages (Claude par défaut). */
  readonly provider = computed<AiProvider>(() => this.store.settings().aiProvider);
  readonly providerLabel = computed(() => PROVIDER_LABELS[this.provider()]);
  /** Le moteur choisi peut répondre : clé enregistrée, ou modèle Qwen téléchargé et utilisable. */
  readonly ready = computed(() => {
    switch (this.provider()) {
      case 'claude':
        return this.hasKey();
      case 'openai':
        return this.hasOpenAiKey();
      case 'qwen': {
        const status = this.localStatus();
        return status !== null && status.installed && status.supported;
      }
    }
  });
  /** La lecture des photos demande Claude ou OpenAI (le modèle Qwen local ne lit pas les images). */
  readonly canReadPhoto = computed(() => this.ready() && this.provider() !== 'qwen');

  readonly open = signal(false);
  readonly messages = signal<ChatMessage[]>([]);
  readonly busy = signal(false);
  private currentRequest: string | null = null;

  constructor() {
    if (this.api !== null) {
      const api = this.api;
      const off = api.onEvent((event) => this.onEvent(event));
      const offLocal = api.local.onStatus((status) => this.setLocalStatus(status));
      const destroyRef = inject(DestroyRef);
      destroyRef.onDestroy(off);
      destroyRef.onDestroy(offLocal);
      // État de chaque modèle Qwen (téléchargé ou non), pour les cartes des réglages.
      for (const m of LOCAL_MODELS) {
        void api.local.status(m.id).then(
          (status) => this.setLocalStatus(status),
          () => undefined,
        );
      }
    }
  }

  async setKey(key: string, provider: 'claude' | 'openai' = 'claude'): Promise<void> {
    await this.secrets.setSecret(provider === 'openai' ? 'openaiApiKey' : 'claudeApiKey', key.trim());
  }

  async clearKey(provider: 'claude' | 'openai' = 'claude'): Promise<void> {
    await this.secrets.setSecret(provider === 'openai' ? 'openaiApiKey' : 'claudeApiKey', null);
  }

  /** Teste le moteur donné (par défaut celui qui est utilisé). */
  test(provider: AiProvider = this.provider()): Promise<{ ok: boolean; message: string }> {
    if (provider === 'claude') {
      return this.require().test(this.store.settings().aiModel);
    }
    return this.require().test(this.modelOf(provider), provider);
  }

  async readMeter(photos: readonly MeterPhoto[]): Promise<PhotoReading> {
    const provider = this.provider();
    if (provider === 'claude') {
      return this.require().readMeter(this.store.settings().aiModel, photos);
    }
    return this.require().readMeter(this.modelOf(provider), photos, provider);
  }

  async downloadLocal(): Promise<void> {
    this.setLocalStatus(await this.require().local.download(this.localModel().id));
  }

  async cancelLocal(): Promise<void> {
    const id = this.downloading()?.id ?? this.localModel().id;
    this.setLocalStatus(await this.require().local.cancel(id));
  }

  async removeLocal(): Promise<void> {
    this.setLocalStatus(await this.require().local.remove(this.localModel().id));
  }

  private setLocalStatus(status: LocalModelStatus): void {
    this.localStatuses.update((all) => ({ ...all, [status.id]: status }));
  }

  /** Modèle du moteur donné, choisi dans les réglages. */
  private modelOf(provider: AiProvider): string {
    const settings = this.store.settings();
    switch (provider) {
      case 'openai':
        return settings.openaiModel;
      case 'qwen':
        return settings.localModel;
      default:
        return settings.aiModel;
    }
  }

  async send(text: string): Promise<void> {
    const api = this.require();
    const content = text.trim();
    if (content === '' || this.busy()) {
      return;
    }
    const requestId = newId();
    this.currentRequest = requestId;
    this.messages.update((list) => [
      ...list,
      { id: newId(), role: 'user', content },
      { id: requestId, role: 'assistant', content: '' },
    ]);
    this.busy.set(true);
    const history = this.messages()
      .filter((m) => !m.error && m.id !== requestId)
      .map((m) => ({ role: m.role, content: m.content }));
    const provider = this.provider();
    try {
      await api.chat({
        requestId,
        ...(provider === 'claude' ? {} : { provider }),
        model: this.modelOf(provider),
        system: buildSystemPrompt(this.store.data(), this.store.analysis(), this.store.now()),
        messages: history,
      });
    } catch (error) {
      this.fail(requestId, error instanceof Error ? error.message : String(error));
    }
  }

  stop(): void {
    if (this.currentRequest !== null) {
      void this.api?.abort(this.currentRequest);
    }
  }

  newConversation(): void {
    this.stop();
    this.messages.set([]);
    this.busy.set(false);
  }

  private onEvent(event: AiStreamEvent): void {
    if (event.requestId !== this.currentRequest) {
      return;
    }
    if (event.type === 'delta') {
      this.messages.update((list) =>
        list.map((m) => (m.id === event.requestId ? { ...m, content: m.content + event.text } : m)),
      );
    } else if (event.type === 'error') {
      this.fail(event.requestId, event.message);
    } else {
      this.busy.set(false);
      this.currentRequest = null;
      this.messages.update((list) =>
        list.filter((m) => m.id !== event.requestId || m.content !== ''),
      );
    }
  }

  private fail(requestId: string, message: string): void {
    this.busy.set(false);
    this.currentRequest = null;
    this.messages.update((list) =>
      list.map((m) =>
        m.id === requestId
          ? {
              ...m,
              content: m.content ? `${m.content}\n\n⚠ ${message}` : message,
              error: m.content === '',
            }
          : m,
      ),
    );
  }

  private require(): NonNullable<typeof this.api> {
    if (this.api === null) {
      throw new Error('L’assistant IA n’est disponible que dans l’application de bureau.');
    }
    return this.api;
  }
}
