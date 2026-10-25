import https from 'node:https';
import type { TLSSocket } from 'node:tls';
import {
  inverterError,
  isSessionExpired,
  MEASUREMENT_KEYS,
  parseMeasurements,
  srpFinish,
  srpStart,
  type InverterRole,
} from './sma-core';
import type { InverterConfig, InverterReading } from './shared/ipc-contract';

interface Response {
  readonly status: number;
  readonly json: unknown;
}

const TIMEOUT_MS = 15_000;

const normalizeFingerprint = (f: string): string => f.replace(/:/g, '').toUpperCase();

/**
 * Client local de l'onduleur (WebConnect) : connexion SRP avec la clé de la plaque, lecture des mesures, session réutilisée.
 * Le certificat auto-signé de l'onduleur est épinglé : la première empreinte vue est mémorisée par l'application,
 * toute empreinte différente ensuite est refusée avant d'envoyer quoi que ce soit.
 */
export class InverterClient {
  private config: InverterConfig = { enabled: false, host: '', certFingerprint: null };
  private sid: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private seenFingerprint: string | null = null;

  constructor(
    private readonly secret: () => string | null,
    private readonly role: InverterRole = 'usr',
    /** Port HTTPS (443 ; autre valeur pour les tests). */
    private readonly port = 443,
  ) {}

  configure(config: InverterConfig): void {
    const changed =
      config.host !== this.config.host || config.certFingerprint !== this.config.certFingerprint;
    this.config = { ...config };
    if (changed || !config.enabled) {
      void this.logout();
    }
  }

  get enabled(): boolean {
    return this.config.enabled && this.config.host.length > 0;
  }

  /** Lit les mesures ; ne lève jamais : l'erreur est rapportée dans le résultat. */
  read(): Promise<InverterReading> {
    const run = this.queue.then(() => this.readNow());
    this.queue = run.catch(() => undefined);
    return run;
  }

  async close(): Promise<void> {
    await this.logout();
  }

  private async readNow(): Promise<InverterReading> {
    const at = Date.now();
    const fail = (error: string): InverterReading => ({
      at,
      powerW: null,
      dayWh: null,
      totalWh: null,
      error,
      certFingerprint: this.seenFingerprint,
    });
    if (!this.config.host) {
      return fail("Adresse de l'onduleur non renseignée.");
    }
    const secret = this.secret();
    if (secret === null) {
      return fail("Clé de l'onduleur absente ou coffre verrouillé.");
    }
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (this.sid === null) {
          this.sid = await this.login(secret);
        }
        const keys = Object.values(MEASUREMENT_KEYS);
        const res = await this.post(`/dyn/getValues.json?sid=${encodeURIComponent(this.sid)}`, {
          destDev: [],
          keys,
        });
        if (isSessionExpired(res.status, res.json)) {
          this.sid = null;
          continue;
        }
        const m = parseMeasurements(res.json);
        return { at, ...m, error: null, certFingerprint: this.seenFingerprint };
      }
      return fail("La session de l'onduleur expire sans cesse.");
    } catch (error) {
      this.sid = null;
      return fail(error instanceof Error ? error.message : String(error));
    }
  }

  private async login(secret: string): Promise<string> {
    const start = srpStart(this.role);
    const first = await this.post('/dyn/authYAPStart.json', start.body);
    const server = first.json as { B?: string; salt?: string; id?: unknown } | null;
    if (!server?.B || !server.salt) {
      throw new Error(inverterError(first.status, first.json));
    }
    const finish = srpFinish(start, this.role, secret, {
      B: server.B,
      salt: server.salt,
      id: server.id,
    });
    const second = await this.post('/dyn/authYAPFinish.json', finish.body);
    const reply = second.json as { M2?: string; result?: { sid?: string }; sid?: string } | null;
    if (!reply?.M2) {
      throw new Error(inverterError(second.status, second.json));
    }
    if (String(reply.M2).toLowerCase() !== finish.expectedM2) {
      throw new Error("L'onduleur n'a pas pu être authentifié.");
    }
    const sid = reply.result?.sid ?? reply.sid;
    if (!sid) {
      throw new Error("Connexion acceptée mais l'onduleur n'a pas ouvert de session.");
    }
    return sid;
  }

  private async logout(): Promise<void> {
    const sid = this.sid;
    this.sid = null;
    if (sid !== null && this.config.host) {
      await this.post(`/dyn/logout.json?sid=${encodeURIComponent(sid)}`, {}).catch(() => undefined);
    }
  }

  private post(path: string, body: unknown): Promise<Response> {
    const data = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = https.request({
        host: this.config.host,
        port: this.port,
        path,
        method: 'POST',
        // Certificat auto-signé : il est vérifié par épinglage ci-dessous, pas par une autorité.
        rejectUnauthorized: false,
        agent: false,
        timeout: TIMEOUT_MS,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      });
      req.on('timeout', () => req.destroy(new Error("L'onduleur ne répond pas.")));
      req.on('error', (e) =>
        reject(
          /ENOTFOUND|EHOSTUNREACH|ECONNREFUSED|ETIMEDOUT/.test(String(e))
            ? new Error(`Onduleur injoignable (${this.config.host}).`)
            : e,
        ),
      );
      req.on('response', (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          let json: unknown = null;
          try {
            json = JSON.parse(text);
          } catch {
            // corps non JSON : on se contente du code
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      });
      req.on('socket', (socket) => {
        (socket as TLSSocket).once('secureConnect', () => {
          const fingerprint = (socket as TLSSocket).getPeerCertificate()?.fingerprint256 ?? '';
          this.seenFingerprint = fingerprint || null;
          const pinned = this.config.certFingerprint;
          if (pinned && normalizeFingerprint(pinned) !== normalizeFingerprint(fingerprint)) {
            req.destroy(
              new Error(
                "Le certificat de l'onduleur a changé : connexion refusée. Réinitialisez l'empreinte dans les réglages si c'est normal.",
              ),
            );
            return;
          }
          req.end(data);
        });
      });
    });
  }
}
