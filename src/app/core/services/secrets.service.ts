import { Injectable, computed, signal } from '@angular/core';
import type { SecretName, SecretsStatus } from '../../../../electron/shared/ipc-contract';

/**
 * Clés de l'application (clé API Claude, clé de l'onduleur), rangées par le process principal dans le Trousseau
 * macOS. La page ne voit jamais les clés : seulement leur présence.
 */
@Injectable({ providedIn: 'root' })
export class SecretsService {
  private readonly api = typeof window !== 'undefined' ? (window.consoElec?.secrets ?? null) : null;

  readonly available = this.api !== null;
  readonly status = signal<SecretsStatus | null>(null);
  /** L'ancien coffre chiffré par la clé SSH attend d'être importé. */
  readonly legacyVault = computed(() => this.status()?.legacyVault === true);
  readonly inKeychain = computed(() => this.status()?.storage !== 'file');

  async refresh(): Promise<void> {
    if (this.api !== null) {
      this.status.set(await this.api.status());
    }
  }

  has(name: SecretName): boolean {
    return this.status()?.secrets[name] === true;
  }

  async setSecret(name: SecretName, value: string | null): Promise<void> {
    this.status.set(await this.require().setSecret(name, value));
  }

  /** Reprend les clés de l'ancien coffre (phrase de passe de la clé SSH), puis le supprime. */
  async importVault(passphrase: string): Promise<void> {
    this.status.set(await this.require().importVault(passphrase));
  }

  private require(): NonNullable<typeof this.api> {
    if (this.api === null) {
      throw new Error('Les clés ne sont disponibles que dans l’application de bureau.');
    }
    return this.api;
  }
}
