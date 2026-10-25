import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import type {
  AiStatus,
  AiStreamEvent,
  MeterPhoto,
  PhotoReading,
} from '../../../../electron/shared/ipc-contract';
import { newId } from '../models/normalize';
import { DataStore } from '../services/data-store.service';
import { buildSystemPrompt } from './ai-context';

export interface ChatMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly error?: boolean;
}

/** Assistant Claude : état de la conversation, clé API (jamais lue côté page) et lecture de photos. */
@Injectable({ providedIn: 'root' })
export class AiService {
  private readonly store = inject(DataStore);
  private readonly api = typeof window !== 'undefined' ? (window.consoElec?.ai ?? null) : null;

  /** Les appels à Claude passent par l'application de bureau ; pas disponibles dans un simple navigateur. */
  readonly available = this.api !== null;
  readonly status = signal<AiStatus | null>(null);
  readonly hasKey = computed(() => this.status()?.hasKey === true);

  readonly open = signal(false);
  readonly messages = signal<ChatMessage[]>([]);
  readonly busy = signal(false);
  private currentRequest: string | null = null;

  constructor() {
    if (this.api !== null) {
      const off = this.api.onEvent((event) => this.onEvent(event));
      inject(DestroyRef).onDestroy(off);
      void this.refreshStatus();
    }
  }

  async refreshStatus(): Promise<void> {
    if (this.api !== null) {
      this.status.set(await this.api.status());
    }
  }

  async setKey(key: string): Promise<void> {
    await this.require().setKey(key);
    await this.refreshStatus();
  }

  async clearKey(): Promise<void> {
    await this.require().clearKey();
    await this.refreshStatus();
  }

  test(): Promise<{ ok: boolean; message: string }> {
    return this.require().test(this.store.settings().aiModel);
  }

  async readMeter(photos: readonly MeterPhoto[]): Promise<PhotoReading> {
    return this.require().readMeter(this.store.settings().aiModel, photos);
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
    try {
      await api.chat({
        requestId,
        model: this.store.settings().aiModel,
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
