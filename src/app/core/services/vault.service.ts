import { Injectable, computed, signal } from '@angular/core';
import type { SecretName, VaultStatus } from '../../../../electron/shared/ipc-contract';

/**
 * Coffre des secrets (clé API Claude, clé de l'onduleur), chiffré par la clé SSH de l'utilisateur dans le process
 * principal. La page ne voit jamais les secrets : seulement l'état du coffre et la présence de chaque secret.
 */
@Injectable({ providedIn: 'root' })
export class VaultService {
  private readonly api = typeof window !== 'undefined' ? (window.consoElec?.vault ?? null) : null;

  readonly available = this.api !== null;
  readonly status = signal<VaultStatus | null>(null);
  readonly state = computed(() => this.status()?.state ?? 'absent');
  readonly unlocked = computed(() => this.state() === 'unlocked');
  /** Le coffre existe mais n'est pas encore ouvert dans cette session. */
  readonly locked = computed(() => this.state() === 'locked');
  /** L'utilisateur a choisi « Plus tard » au démarrage. */
  readonly postponed = signal(false);

  async refresh(): Promise<void> {
    if (this.api !== null) {
      this.status.set(await this.api.status());
    }
  }

  has(name: SecretName): boolean {
    return this.unlocked() && this.status()?.secrets[name] === true;
  }

  async create(sshKeyPath: string, passphrase: string): Promise<void> {
    this.status.set(await this.require().create(sshKeyPath, passphrase));
  }

  async unlock(passphrase: string): Promise<void> {
    this.status.set(await this.require().unlock(passphrase));
    this.postponed.set(false);
  }

  async lock(): Promise<void> {
    this.status.set(await this.require().lock());
  }

  async setSecret(name: SecretName, value: string | null): Promise<void> {
    this.status.set(await this.require().setSecret(name, value));
  }

  private require(): NonNullable<typeof this.api> {
    if (this.api === null) {
      throw new Error('Le coffre n’est disponible que dans l’application de bureau.');
    }
    return this.api;
  }
}
