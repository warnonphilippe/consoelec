import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EncryptedFileSecrets, type Cipher } from './secrets';

const fakeCipher = (available = true): Cipher => ({
  isEncryptionAvailable: () => available,
  encryptString: (plain) => Buffer.from(plain.split('').reverse().join(''), 'utf-8'),
  decryptString: (buffer) => buffer.toString('utf-8').split('').reverse().join(''),
});

describe('EncryptedFileSecrets (repli hors macOS)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'consoelec-secrets-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const KEY = 'sk-ant-api03-exemple-de-cle-assez-longue';

  it('range plusieurs secrets chiffrés, jamais en clair, et supprime le fichier vide', async () => {
    const path = join(dir, 'secrets.bin');
    const store = new EncryptedFileSecrets(path, fakeCipher());
    expect(await store.read('claudeApiKey')).toBeNull();
    await store.write('claudeApiKey', KEY);
    await store.write('inverterPsk', 'ABCDEFGH12345678');
    expect(await store.read('claudeApiKey')).toBe(KEY);
    expect(await store.read('inverterPsk')).toBe('ABCDEFGH12345678');
    expect((await readFile(path)).toString('utf-8')).not.toContain(KEY);
    await store.remove('claudeApiKey');
    expect(await store.read('claudeApiKey')).toBeNull();
    await store.remove('inverterPsk');
    expect(existsSync(path)).toBe(false);
  });

  it('refuse d’écrire sans chiffrement disponible', async () => {
    await expect(
      new EncryptedFileSecrets(join(dir, 'b.bin'), fakeCipher(false)).write('claudeApiKey', KEY),
    ).rejects.toThrow('chiffrement');
  });
});
