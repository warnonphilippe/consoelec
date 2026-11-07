import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Keychain, isSafeSecret, type KeychainItem } from './keychain';
import type { EncryptedFileSecrets } from './secrets';
import type { SecretName, SecretsStatus } from './shared/ipc-contract';
import { Vault, signChallenge } from './vault';

export const SECRET_NAMES: readonly SecretName[] = ['claudeApiKey', 'inverterPsk', 'p1Token'];

/** Où les secrets sont rangés : lecture, écriture et suppression par nom. */
export interface SecretBackend {
  readonly kind: SecretsStatus['storage'];
  read(name: SecretName): Promise<string | null>;
  write(name: SecretName, value: string): Promise<void>;
  remove(name: SecretName): Promise<void>;
}

const SERVICE = 'io.github.warnonphilippe.consoelec';
const ITEMS: Record<SecretName, KeychainItem> = {
  claudeApiKey: { service: SERVICE, account: 'claude-api-key', label: 'ConsoElec — clé API Claude' },
  inverterPsk: { service: SERVICE, account: 'inverter-psk', label: 'ConsoElec — clé de l’onduleur' },
  p1Token: { service: SERVICE, account: 'p1-token', label: 'ConsoElec — jeton du lecteur P1' },
};

/** Trousseau macOS : un élément visible dans Trousseau d'accès par secret. */
export function keychainBackend(keychain = new Keychain()): SecretBackend {
  return {
    kind: 'keychain',
    read: (name) => keychain.get(ITEMS[name]),
    write: (name, value) => keychain.set(ITEMS[name], value),
    remove: (name) => keychain.delete(ITEMS[name]),
  };
}

/** Repli hors macOS : fichier chiffré par le système. */
export function fileBackend(file: EncryptedFileSecrets): SecretBackend {
  return {
    kind: 'file',
    read: (name) => file.read(name),
    write: (name, value) => file.write(name, value),
    remove: (name) => file.remove(name),
  };
}

/**
 * Secrets de l'application (clé API Claude, clé de l'onduleur), lus au démarrage et gardés en mémoire pour le process
 * principal ; ils ne sont jamais renvoyés à la page. Reprend une seule fois les secrets de l'ancien coffre chiffré
 * par la clé SSH (`secrets.vault`), puis le supprime.
 */
export class Secrets {
  private readonly cache = new Map<SecretName, string>();

  constructor(
    private readonly backend: SecretBackend,
    /** Ancien coffre chiffré par la clé SSH. */
    private readonly vaultPath: string,
    private readonly workDir: string,
    private readonly sign: typeof signChallenge = signChallenge,
  ) {}

  /** Lit tous les secrets ; une erreur de lecture laisse le secret absent (rapportée par `status`). */
  async load(): Promise<void> {
    for (const name of SECRET_NAMES) {
      const value = await this.backend.read(name).catch(() => null);
      if (value) {
        this.cache.set(name, value);
      } else {
        this.cache.delete(name);
      }
    }
  }

  get(name: SecretName): string | null {
    return this.cache.get(name) ?? null;
  }

  has(name: SecretName): boolean {
    return this.cache.has(name);
  }

  /** Enregistre (espaces retirés) ou efface un secret. */
  async set(name: SecretName, value: string | null): Promise<void> {
    const cleaned = (value ?? '').replace(/\s+/g, '');
    if (cleaned === '') {
      await this.backend.remove(name);
      this.cache.delete(name);
      return;
    }
    if (!isSafeSecret(cleaned)) {
      throw new Error('Cette clé contient des caractères inattendus ou n’a pas la bonne longueur.');
    }
    await this.backend.write(name, cleaned);
    this.cache.set(name, cleaned);
  }

  status(): SecretsStatus {
    return {
      storage: this.backend.kind,
      secrets: {
        claudeApiKey: this.has('claudeApiKey'),
        inverterPsk: this.has('inverterPsk'),
        p1Token: this.has('p1Token'),
      },
      legacyVault: existsSync(this.vaultPath),
    };
  }

  /**
   * Import unique depuis l'ancien coffre : ouvre `secrets.vault` avec la phrase de passe de la clé SSH, range ses
   * secrets ici, puis supprime le coffre. Renvoie les noms des secrets repris.
   */
  async importVault(passphrase: string): Promise<SecretName[]> {
    const vault = new Vault(this.vaultPath, this.workDir, this.sign);
    await vault.unlock(passphrase);
    const imported: SecretName[] = [];
    try {
      // L'ancien coffre ne connaissait que la clé Claude et celle de l'onduleur.
      for (const name of ['claudeApiKey', 'inverterPsk'] as const) {
        const value = vault.get(name);
        if (value) {
          await this.set(name, value);
          imported.push(name);
        }
      }
    } finally {
      vault.lock();
    }
    await rm(this.vaultPath, { force: true });
    return imported;
  }
}
