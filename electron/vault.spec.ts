import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault, signChallenge } from './vault';
import { deriveKey, openSecrets, parseVaultFile } from './vault-core';

const PASS = 'phrase-de-test-42';

function makeKey(dir: string, name: string, type: 'rsa' | 'ed25519' | 'ecdsa'): string {
  const path = join(dir, name);
  const args = ['-q', '-t', type, '-N', PASS, '-f', path];
  if (type === 'rsa') {
    args.push('-b', '2048');
  }
  execFileSync('/usr/bin/ssh-keygen', args);
  return path;
}

describe('coffre chiffré par une clé SSH', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'consoelec-vault-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.each(['rsa', 'ed25519'] as const)(
    'la signature d’une clé %s est déterministe',
    async (type) => {
      const key = makeKey(dir, `k_${type}`, type);
      const a = await signChallenge(key, PASS, dir);
      const b = await signChallenge(key, PASS, dir);
      expect(a.signature.equals(b.signature)).toBe(true);
      expect(a.fingerprint).toMatch(/^SHA256:/);
    },
  );

  it('refuse une mauvaise phrase de passe et une clé ECDSA', async () => {
    const rsa = makeKey(dir, 'k_rsa', 'rsa');
    await expect(signChallenge(rsa, 'faux', dir)).rejects.toThrow('incorrecte');
    const ecdsa = makeKey(dir, 'k_ecdsa', 'ecdsa');
    await expect(signChallenge(ecdsa, PASS, dir)).rejects.toThrow('ECDSA');
    await expect(signChallenge(join(dir, 'absente'), PASS, dir)).rejects.toThrow('introuvable');
  });

  it('chiffre les secrets, les retrouve après verrouillage, et ne les écrit jamais en clair', async () => {
    const key = makeKey(dir, 'k_rsa', 'rsa');
    const path = join(dir, 'secrets.vault');
    const vault = new Vault(path, dir);
    expect(await vault.state()).toBe('absent');
    await vault.create(key, PASS, { claudeApiKey: 'sk-ant-api03-secret-de-test' });
    await vault.set('inverterPsk', 'ABCD1234EFGH5678');
    expect(await vault.state()).toBe('unlocked');
    const text = await readFile(path, 'utf-8');
    expect(text).not.toContain('sk-ant-api03');
    expect(text).not.toContain('ABCD1234');

    vault.lock();
    expect(await vault.state()).toBe('locked');
    expect(vault.get('claudeApiKey')).toBeNull();

    const reopened = new Vault(path, dir);
    await expect(reopened.unlock('faux')).rejects.toThrow('incorrecte');
    await reopened.unlock(PASS);
    expect(reopened.get('claudeApiKey')).toBe('sk-ant-api03-secret-de-test');
    expect(reopened.get('inverterPsk')).toBe('ABCD1234EFGH5678');
    await reopened.set('inverterPsk', null);
    expect(reopened.has('inverterPsk')).toBe(false);
  });

  it('détecte que la clé SSH a été remplacée', async () => {
    const key = makeKey(dir, 'k', 'ed25519');
    const path = join(dir, 'secrets.vault');
    await new Vault(path, dir).create(key, PASS, { inverterPsk: 'X' });
    await rm(key);
    await rm(`${key}.pub`);
    makeKey(dir, 'k', 'ed25519');
    await expect(new Vault(path, dir).unlock(PASS)).rejects.toThrow("n'est plus celle");
  });

  it('un coffre altéré ne se déchiffre pas', async () => {
    const key = makeKey(dir, 'k', 'ed25519');
    const path = join(dir, 'secrets.vault');
    await new Vault(path, dir).create(key, PASS, { inverterPsk: 'X' });
    const file = parseVaultFile(await readFile(path, 'utf-8'));
    const signature = await signChallenge(key, PASS, dir);
    const k = deriveKey(signature.signature, Buffer.from(file.salt, 'hex'));
    expect(openSecrets(file, k)).toEqual({ inverterPsk: 'X' });
    const tampered = { ...file, data: Buffer.from('falsifié').toString('base64') };
    expect(() => openSecrets(tampered, k)).toThrow('déchiffré');
  });
});
