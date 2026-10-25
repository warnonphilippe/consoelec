/**
 * Partie pure du coffre chiffré (aucune dépendance à Electron) : dérivation de la clé à partir d'une signature SSH,
 * chiffrement AES-256-GCM, format du fichier. Testée sans réseau.
 */
import crypto from 'node:crypto';

/** Défi signé par la clé SSH : la signature (déterministe en RSA et Ed25519) sert de matière à la clé du coffre. */
export const VAULT_CHALLENGE = 'consoelec-vault-v1';
export const VAULT_NAMESPACE = 'consoelec';

export interface VaultSecrets {
  claudeApiKey?: string;
  inverterPsk?: string;
}

export type SecretName = keyof VaultSecrets;
export const SECRET_NAMES: readonly SecretName[] = ['claudeApiKey', 'inverterPsk'];

export interface VaultFile {
  readonly version: 1;
  readonly sshKeyPath: string;
  /** Empreinte de la clé publique (format `SHA256:…` d'OpenSSH) : détecte un changement de clé SSH. */
  readonly sshKeyFingerprint: string;
  readonly sshKeyType: string;
  readonly salt: string;
  readonly iv: string;
  readonly tag: string;
  readonly data: string;
}

export interface SshSignature {
  readonly keyType: string;
  readonly fingerprint: string;
  /** Champ « signature » de la structure SSHSIG. */
  readonly signature: Buffer;
}

function readString(buf: Buffer, offset: number): { value: Buffer; next: number } {
  if (offset + 4 > buf.length) {
    throw new Error('Signature SSH tronquée.');
  }
  const length = buf.readUInt32BE(offset);
  const start = offset + 4;
  if (start + length > buf.length) {
    throw new Error('Signature SSH tronquée.');
  }
  return { value: buf.subarray(start, start + length), next: start + length };
}

/** Lit la signature « armurée » produite par `ssh-keygen -Y sign` (format SSHSIG). */
export function parseSshSignature(armored: string): SshSignature {
  const body = armored
    .replace(/-----BEGIN SSH SIGNATURE-----/, '')
    .replace(/-----END SSH SIGNATURE-----/, '')
    .replace(/\s+/g, '');
  const blob = Buffer.from(body, 'base64');
  if (blob.subarray(0, 6).toString('latin1') !== 'SSHSIG') {
    throw new Error("La sortie de ssh-keygen n'est pas une signature SSH.");
  }
  let offset = 10; // « SSHSIG » + version (uint32)
  const publicKey = readString(blob, offset);
  offset = publicKey.next;
  offset = readString(blob, offset).next; // espace de noms
  offset = readString(blob, offset).next; // réservé
  offset = readString(blob, offset).next; // algorithme de hachage
  const signature = readString(blob, offset).value;
  const keyType = readString(publicKey.value, 0).value.toString('latin1');
  const fingerprint =
    'SHA256:' +
    crypto.createHash('sha256').update(publicKey.value).digest('base64').replace(/=+$/, '');
  return { keyType, fingerprint, signature };
}

/** Les signatures ECDSA sont aléatoires : elles ne peuvent pas redonner la même clé à chaque déverrouillage. */
export function assertDeterministicKeyType(keyType: string): void {
  if (/ecdsa/i.test(keyType)) {
    throw new Error(
      'Les clés SSH ECDSA ne conviennent pas (signature aléatoire) : utilisez une clé RSA ou Ed25519.',
    );
  }
}

export function deriveKey(signature: Buffer, salt: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', signature, salt, 'consoelec vault key', 32));
}

export function newSalt(): Buffer {
  return crypto.randomBytes(16);
}

export function sealSecrets(
  secrets: VaultSecrets,
  key: Buffer,
  meta: { sshKeyPath: string; signature: SshSignature; salt: Buffer },
): VaultFile {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(meta.signature.fingerprint));
  const data = Buffer.concat([
    cipher.update(JSON.stringify(cleanSecrets(secrets)), 'utf-8'),
    cipher.final(),
  ]);
  return {
    version: 1,
    sshKeyPath: meta.sshKeyPath,
    sshKeyFingerprint: meta.signature.fingerprint,
    sshKeyType: meta.signature.keyType,
    salt: meta.salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    data: data.toString('base64'),
  };
}

export function openSecrets(file: VaultFile, key: Buffer): VaultSecrets {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(file.iv, 'hex'));
  decipher.setAAD(Buffer.from(file.sshKeyFingerprint));
  decipher.setAuthTag(Buffer.from(file.tag, 'hex'));
  let plain: string;
  try {
    plain = Buffer.concat([
      decipher.update(Buffer.from(file.data, 'base64')),
      decipher.final(),
    ]).toString('utf-8');
  } catch {
    throw new Error('Le coffre ne peut pas être déchiffré avec cette clé SSH.');
  }
  return cleanSecrets(JSON.parse(plain) as VaultSecrets);
}

export function parseVaultFile(text: string): VaultFile {
  const raw = JSON.parse(text) as Partial<VaultFile>;
  const fields = [
    'sshKeyPath',
    'sshKeyFingerprint',
    'sshKeyType',
    'salt',
    'iv',
    'tag',
    'data',
  ] as const;
  if (raw.version !== 1 || fields.some((f) => typeof raw[f] !== 'string')) {
    throw new Error('Fichier de coffre illisible.');
  }
  return raw as VaultFile;
}

function cleanSecrets(secrets: VaultSecrets): VaultSecrets {
  const out: VaultSecrets = {};
  for (const name of SECRET_NAMES) {
    const value = secrets[name];
    if (typeof value === 'string' && value.length > 0) {
      out[name] = value;
    }
  }
  return out;
}
