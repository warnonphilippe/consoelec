import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Secrets, type SecretBackend } from './secret-store';
import type { SecretName } from './shared/ipc-contract';
import { Vault } from './vault';

const PASS = 'phrase-de-test-42';

/** Faux Trousseau en mémoire. */
function memoryBackend(initial: Partial<Record<SecretName, string>> = {}) {
  const items = new Map<SecretName, string>(Object.entries(initial) as [SecretName, string][]);
  const backend: SecretBackend = {
    kind: 'keychain',
    read: async (name) => items.get(name) ?? null,
    write: async (name, value) => void items.set(name, value),
    remove: async (name) => void items.delete(name),
  };
  return { backend, items };
}

describe('Secrets', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'consoelec-secret-store-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('lit les secrets au démarrage, les garde en mémoire et les met à jour', async () => {
    const { backend, items } = memoryBackend({ inverterPsk: 'ABCDEFGH12345678' });
    const secrets = new Secrets(backend, join(dir, 'secrets.vault'), dir);
    await secrets.load();
    expect(secrets.get('inverterPsk')).toBe('ABCDEFGH12345678');
    expect(secrets.status()).toEqual({
      storage: 'keychain',
      secrets: { claudeApiKey: false, inverterPsk: true, p1Token: false, openaiApiKey: false },
      legacyVault: false,
    });
    await secrets.set('claudeApiKey', '  sk-ant-api03-AbC_dEf-123456\n');
    expect(items.get('claudeApiKey')).toBe('sk-ant-api03-AbC_dEf-123456');
    expect(secrets.has('claudeApiKey')).toBe(true);
    await secrets.set('inverterPsk', null);
    expect(items.has('inverterPsk')).toBe(false);
    expect(secrets.get('inverterPsk')).toBeNull();
  });

  it('refuse une valeur au format inattendu sans rien écrire', async () => {
    const { backend, items } = memoryBackend();
    const secrets = new Secrets(backend, join(dir, 'secrets.vault'), dir);
    await expect(secrets.set('claudeApiKey', 'court')).rejects.toThrow('caractères');
    await expect(secrets.set('claudeApiKey', 'clé"avec-guillemet-assez-longue')).rejects.toThrow();
    expect(items.size).toBe(0);
  });

  it('importe une fois l’ancien coffre SSH, puis le supprime', async () => {
    const key = join(dir, 'k_ed25519');
    execFileSync('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', PASS, '-f', key]);
    const vaultPath = join(dir, 'secrets.vault');
    const vault = new Vault(vaultPath, dir);
    await vault.create(key, PASS, { claudeApiKey: 'sk-ant-api03-secret-de-test', inverterPsk: 'ABCD1234EFGH5678' });
    vault.lock();

    const { backend, items } = memoryBackend();
    const secrets = new Secrets(backend, vaultPath, dir);
    await secrets.load();
    expect(secrets.status().legacyVault).toBe(true);
    await expect(secrets.importVault('mauvaise')).rejects.toThrow('incorrecte');
    expect(existsSync(vaultPath)).toBe(true);

    expect(await secrets.importVault(PASS)).toEqual(['claudeApiKey', 'inverterPsk']);
    expect(items.get('claudeApiKey')).toBe('sk-ant-api03-secret-de-test');
    expect(items.get('inverterPsk')).toBe('ABCD1234EFGH5678');
    expect(existsSync(vaultPath)).toBe(false);
    expect(secrets.status()).toMatchObject({ legacyVault: false, secrets: { claudeApiKey: true, inverterPsk: true } });
  });
});
