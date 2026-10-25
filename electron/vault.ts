import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  VAULT_CHALLENGE,
  VAULT_NAMESPACE,
  assertDeterministicKeyType,
  deriveKey,
  newSalt,
  openSecrets,
  parseSshSignature,
  parseVaultFile,
  sealSecrets,
  type SecretName,
  type SshSignature,
  type VaultFile,
  type VaultSecrets,
} from './vault-core';

export const DEFAULT_SSH_KEY = '~/.ssh/id_rsa';
const SSH_KEYGEN = '/usr/bin/ssh-keygen';

export function expandHome(path: string): string {
  return path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

/**
 * Signe le défi du coffre avec la clé SSH. La phrase de passe est passée à `ssh-keygen` par un petit programme
 * « askpass » temporaire qui la lit dans une variable d'environnement du seul processus fils ; rien n'est écrit sur disque.
 */
export async function signChallenge(
  sshKeyPath: string,
  passphrase: string,
  workDir: string,
): Promise<SshSignature> {
  const keyFile = expandHome(sshKeyPath);
  if (!existsSync(keyFile)) {
    throw new Error(`Clé SSH introuvable : ${sshKeyPath}`);
  }
  const dir = await mkdtemp(join(workDir, 'askpass-'));
  const askpass = join(dir, 'askpass.sh');
  try {
    await writeFile(askpass, '#!/bin/sh\nprintf \'%s\\n\' "$CONSOELEC_SSH_PASSPHRASE"\n', {
      mode: 0o700,
    });
    await chmod(askpass, 0o700);
    const armored = await new Promise<string>((resolve, reject) => {
      const child = spawn(SSH_KEYGEN, ['-q', '-Y', 'sign', '-f', keyFile, '-n', VAULT_NAMESPACE], {
        env: {
          PATH: '/usr/bin:/bin',
          HOME: homedir(),
          SSH_ASKPASS: askpass,
          SSH_ASKPASS_REQUIRE: 'force',
          DISPLAY: ':0',
          CONSOELEC_SSH_PASSPHRASE: passphrase,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('ssh-keygen ne répond pas.'));
      }, 20_000);
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`ssh-keygen introuvable : ${e.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve(out);
        } else if (/incorrect passphrase|bad passphrase/i.test(err)) {
          reject(new Error('Phrase de passe de la clé SSH incorrecte.'));
        } else {
          reject(new Error(`ssh-keygen a échoué : ${err.trim() || `code ${code}`}`));
        }
      });
      child.stdin.end(VAULT_CHALLENGE);
    });
    const signature = parseSshSignature(armored);
    assertDeterministicKeyType(signature.keyType);
    return signature;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export type VaultState = 'absent' | 'locked' | 'unlocked';

/** Coffre des secrets de l'application, chiffré par la clé SSH de l'utilisateur et gardé en mémoire une fois ouvert. */
export class Vault {
  private key: Buffer | null = null;
  private secrets: VaultSecrets | null = null;
  private file: VaultFile | null = null;
  private signature: SshSignature | null = null;
  private salt: Buffer | null = null;

  constructor(
    readonly path: string,
    private readonly workDir: string,
    private readonly sign: typeof signChallenge = signChallenge,
  ) {}

  async state(): Promise<VaultState> {
    if (this.secrets !== null) {
      return 'unlocked';
    }
    return existsSync(this.path) ? 'locked' : 'absent';
  }

  async sshKeyPath(): Promise<string | null> {
    return (await this.readFile())?.sshKeyPath ?? null;
  }

  has(name: SecretName): boolean {
    return typeof this.secrets?.[name] === 'string';
  }

  get(name: SecretName): string | null {
    return this.secrets?.[name] ?? null;
  }

  /** Crée le coffre (ou le recrée avec une autre clé SSH) en y plaçant les secrets donnés. */
  async create(sshKeyPath: string, passphrase: string, initial: VaultSecrets = {}): Promise<void> {
    const signature = await this.sign(sshKeyPath, passphrase, this.workDir);
    const salt = newSalt();
    this.signature = signature;
    this.salt = salt;
    this.key = deriveKey(signature.signature, salt);
    this.secrets = { ...(this.secrets ?? {}), ...initial };
    await this.persist(sshKeyPath);
  }

  async unlock(passphrase: string): Promise<void> {
    const file = await this.readFile();
    if (file === null) {
      throw new Error("Aucun coffre n'a encore été créé.");
    }
    const signature = await this.sign(file.sshKeyPath, passphrase, this.workDir);
    if (signature.fingerprint !== file.sshKeyFingerprint) {
      throw new Error(`La clé SSH ${file.sshKeyPath} n'est plus celle qui a créé le coffre.`);
    }
    const salt = Buffer.from(file.salt, 'hex');
    const key = deriveKey(signature.signature, salt);
    this.secrets = openSecrets(file, key);
    this.key = key;
    this.signature = signature;
    this.salt = salt;
    this.file = file;
  }

  lock(): void {
    this.key?.fill(0);
    this.key = null;
    this.secrets = null;
    this.signature = null;
  }

  async set(name: SecretName, value: string | null): Promise<void> {
    if (this.secrets === null || this.file === null) {
      throw new Error('Le coffre est verrouillé.');
    }
    const next = { ...this.secrets };
    if (value === null || value === '') {
      delete next[name];
    } else {
      next[name] = value;
    }
    this.secrets = next;
    await this.persist(this.file.sshKeyPath);
  }

  private async readFile(): Promise<VaultFile | null> {
    if (this.file !== null) {
      return this.file;
    }
    if (!existsSync(this.path)) {
      return null;
    }
    this.file = parseVaultFile(await readFile(this.path, 'utf-8'));
    return this.file;
  }

  private async persist(sshKeyPath: string): Promise<void> {
    if (
      this.key === null ||
      this.signature === null ||
      this.salt === null ||
      this.secrets === null
    ) {
      throw new Error('Le coffre est verrouillé.');
    }
    const file = sealSecrets(this.secrets, this.key, {
      sshKeyPath,
      signature: this.signature,
      salt: this.salt,
    });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    await rename(tmp, this.path);
    this.file = file;
  }
}
