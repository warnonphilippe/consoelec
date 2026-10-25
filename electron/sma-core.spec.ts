import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InverterClient } from './inverter';
import {
  SRP_G,
  SRP_N,
  inverterError,
  modPow,
  pad,
  parseMeasurements,
  srpFinish,
  srpStart,
  strip,
  toBn,
  toBuf,
} from './sma-core';

const PSK = 'ABCDEFGH12345678';
const hash = (alg: string, ...parts: Buffer[]): Buffer => {
  const h = crypto.createHash(alg);
  parts.forEach((p) => h.update(p));
  return h.digest();
};

/** Côté onduleur du protocole SRP, écrit d'après la même spécification, pour tester le client. */
function fakeServer(role: string, secret: string) {
  const salt = crypto.randomBytes(16);
  const x = toBn(hash('sha1', strip(salt), hash('sha1', Buffer.from(`${role}:${secret}`))));
  const v = modPow(SRP_G, x, SRP_N);
  const k = toBn(hash('sha1', pad(toBuf(SRP_N)), pad(toBuf(SRP_G))));
  const b = toBn(crypto.randomBytes(48));
  const B = pad(toBuf((k * v + modPow(SRP_G, b, SRP_N)) % SRP_N));
  return {
    first: { B: B.toString('hex'), salt: salt.toString('hex'), id: 7 },
    finish(Ahex: string, M1hex: string): { ok: boolean; M2: string } {
      const A = pad(Buffer.from(Ahex, 'hex'));
      const u = toBn(hash('sha1', A, B));
      const S = modPow((toBn(A) * modPow(v, u, SRP_N)) % SRP_N, b, SRP_N);
      const K = hash('sha256', toBuf(S));
      const hN = hash('sha256', toBuf(SRP_N));
      const hG = hash('sha256', toBuf(SRP_G));
      for (let i = 0; i < hN.length; i++) hN[i] = hN[i]! ^ hG[i]!;
      const M1 = hash(
        'sha256',
        hN,
        hash('sha256', Buffer.from(role)),
        strip(salt),
        strip(A),
        strip(B),
        K,
      );
      const M2 = hash('sha256', strip(A), M1, K);
      return { ok: M1.toString('hex') === M1hex, M2: M2.toString('hex') };
    },
  };
}

const values = (power: number | null) => ({
  result: {
    '017A-xxxxx00D': {
      '6100_40263F00': { '1': [{ val: power }] },
      '6400_00260100': { '1': [{ val: 32070489 }] },
      '6400_00262200': { '1': [{ val: 15727 }] },
    },
  },
});

describe('SRP de l’onduleur', () => {
  it('le client et le serveur calculent la même preuve, et le serveur s’authentifie', () => {
    const server = fakeServer('usr', PSK);
    const start = srpStart('usr');
    const finish = srpFinish(start, 'usr', PSK, server.first);
    const reply = server.finish(start.body.A, finish.body.M1);
    expect(reply.ok).toBe(true);
    expect(reply.M2).toBe(finish.expectedM2);
    expect(finish.body.id).toBe(7);
  });

  it('une mauvaise clé donne une preuve refusée', () => {
    const server = fakeServer('usr', PSK);
    const start = srpStart('usr');
    expect(
      server.finish(start.body.A, srpFinish(start, 'usr', 'FAUX', server.first).body.M1).ok,
    ).toBe(false);
  });

  it('lit les mesures, y compris la nuit', () => {
    expect(parseMeasurements(values(2450))).toEqual({
      powerW: 2450,
      totalWh: 32070489,
      dayWh: 15727,
    });
    expect(parseMeasurements(values(null)).powerW).toBeNull();
    expect(() => parseMeasurements({ result: {} })).toThrow();
  });

  it('traduit les erreurs de l’onduleur', () => {
    expect(inverterError(200, { result: { res: -28607 } })).toContain('WPA2-PSK');
    expect(inverterError(403, null)).toContain('403');
  });
});

describe('client local de l’onduleur (serveur HTTPS simulé)', () => {
  let dir: string;
  let key: string;
  let cert: string;
  let fingerprint: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'consoelec-sma-'));
    execFileSync(
      '/usr/bin/openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=SMA',
        '-keyout',
        join(dir, 'k.pem'),
        '-out',
        join(dir, 'c.pem'),
      ],
      { stdio: 'ignore' },
    );
    key = await readFile(join(dir, 'k.pem'), 'utf-8');
    cert = await readFile(join(dir, 'c.pem'), 'utf-8');
    fingerprint = new crypto.X509Certificate(cert).fingerprint256;
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function start(options: { expireOnce?: boolean } = {}) {
    const srp = fakeServer('usr', PSK);
    const log: string[] = [];
    let pendingA = '';
    let expired = !options.expireOnce;
    let sessions = 0;
    const server = https.createServer({ key, cert }, (req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const path = req.url ?? '';
        log.push(path.split('?')[0]!);
        const json = body ? JSON.parse(body) : {};
        res.setHeader('Content-Type', 'application/json');
        if (path === '/dyn/authYAPStart.json') {
          pendingA = json.A;
          res.end(JSON.stringify(srp.first));
        } else if (path === '/dyn/authYAPFinish.json') {
          const r = srp.finish(pendingA, json.M1);
          sessions++;
          res.end(
            JSON.stringify(
              r.ok
                ? { M2: r.M2, result: { sid: `sid${sessions}` } }
                : { error: { code: -28607 }, result: { res: -28607 } },
            ),
          );
        } else if (path.startsWith('/dyn/getValues.json')) {
          if (!expired) {
            expired = true;
            res.end(JSON.stringify({ err: 401 }));
          } else {
            res.end(JSON.stringify(values(1830)));
          }
        } else {
          res.end('{}');
        }
      });
    });
    return new Promise<{ host: string; port: number; log: string[]; close: () => void }>(
      (resolve) =>
        server.listen(0, '127.0.0.1', () =>
          resolve({
            host: '127.0.0.1',
            port: (server.address() as AddressInfo).port,
            log,
            close: () => server.close(),
          }),
        ),
    );
  }

  it('se connecte, lit les mesures et rapporte l’empreinte du certificat à épingler', async () => {
    const s = await start();
    const client = new InverterClient(() => PSK, 'usr', s.port);
    client.configure({ enabled: true, host: s.host, certFingerprint: null });
    const reading = await client.read();
    expect(reading.error).toBeNull();
    expect(reading).toMatchObject({ powerW: 1830, totalWh: 32070489, dayWh: 15727 });
    expect(reading.certFingerprint).toBe(fingerprint);
    // Deuxième lecture : la session est réutilisée.
    await client.read();
    expect(s.log.filter((p) => p === '/dyn/authYAPStart.json')).toHaveLength(1);
    await client.close();
    expect(s.log).toContain('/dyn/logout.json');
    s.close();
  });

  it('se reconnecte quand la session a expiré', async () => {
    const s = await start({ expireOnce: true });
    const client = new InverterClient(() => PSK, 'usr', s.port);
    client.configure({ enabled: true, host: s.host, certFingerprint: fingerprint });
    expect((await client.read()).powerW).toBe(1830);
    expect(s.log.filter((p) => p === '/dyn/authYAPStart.json')).toHaveLength(2);
    await client.close();
    s.close();
  });

  it('refuse un certificat différent de l’empreinte épinglée, sans rien envoyer', async () => {
    const s = await start();
    const client = new InverterClient(() => PSK, 'usr', s.port);
    client.configure({ enabled: true, host: s.host, certFingerprint: 'AA:'.repeat(31) + 'AA' });
    const reading = await client.read();
    expect(reading.error).toContain('certificat');
    expect(s.log).toEqual([]);
    s.close();
  });

  it('signale une clé refusée et l’absence de clé', async () => {
    const s = await start();
    const wrong = new InverterClient(() => 'MAUVAISE', 'usr', s.port);
    wrong.configure({ enabled: true, host: s.host, certFingerprint: null });
    expect((await wrong.read()).error).toContain('WPA2-PSK');
    const none = new InverterClient(() => null, 'usr', s.port);
    none.configure({ enabled: true, host: s.host, certFingerprint: null });
    expect((await none.read()).error).toContain('coffre');
    s.close();
  });
});
