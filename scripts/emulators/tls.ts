import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Certificat auto-signé jetable (openssl), comme ceux des onduleurs SMA et des passerelles Enphase. */
export function selfSignedCert(commonName: string): {
  key: string;
  cert: string;
  fingerprint: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'consoelec-emu-'));
  try {
    execFileSync(
      '/usr/bin/openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '30',
        '-subj',
        `/CN=${commonName}`,
        '-keyout',
        join(dir, 'k.pem'),
        '-out',
        join(dir, 'c.pem'),
      ],
      { stdio: 'ignore' },
    );
    const key = readFileSync(join(dir, 'k.pem'), 'utf-8');
    const cert = readFileSync(join(dir, 'c.pem'), 'utf-8');
    return { key, cert, fingerprint: new crypto.X509Certificate(cert).fingerprint256 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
