import https from 'node:https';
import type { TLSSocket } from 'node:tls';
import {
  dailyFromLogger,
  inverterError,
  isSessionExpired,
  LOGGER_KEYS,
  MEASUREMENT_KEYS,
  parseLogger,
  parseMeasurements,
  powerFromLogger,
  srpFinish,
  srpStart,
  type InverterRole,
  type LoggerDay,
  type LoggerPoint,
} from './sma-core';
import type {
  InverterConfig,
  InverterDayCurve,
  InverterHistory,
  InverterReading,
} from './shared/ipc-contract';

interface Response {
  readonly status: number;
  readonly json: unknown;
}

const TIMEOUT_MS = 15_000;

const normalizeFingerprint = (f: string): string => f.replace(/:/g, '').toUpperCase();

const DAY_S = 86_400;
/** Après une session neuve sans valeurs (la nuit), on ne rouvre pas de session avant ce délai. */
const EMPTY_RETRY_MS = 15 * 60 * 1000;
/** Le journal quotidien est lu année par année, au plus loin 20 ans en arrière. */
const HISTORY_MAX_YEARS = 20;

const two = (n: number): string => String(n).padStart(2, '0');
const localDate = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
};

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
  /** Dernière fois qu'une session neuve a répondu sans aucune valeur (ms). */
  private emptyFreshAt = 0;

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

  /** Lit les journaux de production (jours passés, courbe du jour) ; ne lève jamais. */
  history(now: Date = new Date()): Promise<InverterHistory> {
    const run = this.queue.then(() => this.historyNow(now));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Courbe de puissance d'une journée (`AAAA-MM-JJ`, heure locale) ; ne lève jamais. */
  dayCurve(date: string): Promise<InverterDayCurve> {
    const run = this.queue.then(() => this.dayCurveNow(date));
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
        const reused = this.sid !== null;
        const res = await this.request(secret, (sid) =>
          this.post(`/dyn/getValues.json?sid=${encodeURIComponent(sid)}`, {
            destDev: [],
            keys: Object.values(MEASUREMENT_KEYS),
          }),
        );
        const m = parseMeasurements(res.json);
        // L'index total ne disparaît jamais, même la nuit : une session ouverte avant la mise en veille nocturne de
        // l'onduleur peut continuer à répondre sans aucune valeur. On la ferme et on relit dans une session neuve.
        if (m.totalWh === null) {
          if (reused && Date.now() - this.emptyFreshAt >= EMPTY_RETRY_MS) {
            await this.logout();
            continue;
          }
          if (!reused) {
            this.emptyFreshAt = Date.now();
          }
        }
        return { at, ...m, error: null, certFingerprint: this.seenFingerprint };
      }
      return fail("L'onduleur ne renvoie aucune mesure.");
    } catch (error) {
      this.sid = null;
      return fail(error instanceof Error ? error.message : String(error));
    }
  }

  private async historyNow(now: Date): Promise<InverterHistory> {
    const fail = (error: string): InverterHistory => ({ days: [], today: [], error });
    if (!this.config.host) {
      return fail("Adresse de l'onduleur non renseignée.");
    }
    const secret = this.secret();
    if (secret === null) {
      return fail("Clé de l'onduleur absente ou coffre verrouillé.");
    }
    try {
      const end = Math.floor(now.getTime() / 1000);
      const days = new Map<string, LoggerDay>();
      let found = false;
      for (let year = 0; year < HISTORY_MAX_YEARS; year++) {
        const to = end - year * 365 * DAY_S;
        // Deux jours de recouvrement : la première journée de chaque tranche a besoin du point de la veille.
        const points = await this.logger(secret, LOGGER_KEYS.daily, to - 367 * DAY_S, to);
        for (const day of dailyFromLogger(points, localDate)) {
          days.set(day.date, day);
        }
        if (points.length > 0) {
          found = true;
        } else if (found || year >= 1) {
          break;
        }
      }
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
      const five = await this.logger(secret, LOGGER_KEYS.fiveMinutes, midnight - 300, end);
      return {
        days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
        today: powerFromLogger(five),
        error: null,
      };
    } catch (error) {
      this.sid = null;
      return fail(error instanceof Error ? error.message : String(error));
    }
  }

  private async dayCurveNow(date: string): Promise<InverterDayCurve> {
    const fail = (error: string): InverterDayCurve => ({ date, points: [], error });
    const [y, m, d] = date.split('-').map(Number) as [number, number, number];
    const start = new Date(y, m - 1, d).getTime() / 1000;
    const end = new Date(y, m - 1, d + 1).getTime() / 1000;
    if (!Number.isFinite(start)) {
      return fail('Date invalide.');
    }
    if (!this.config.host) {
      return fail("Adresse de l'onduleur non renseignée.");
    }
    const secret = this.secret();
    if (secret === null) {
      return fail("Clé de l'onduleur absente ou coffre verrouillé.");
    }
    try {
      const points = await this.logger(secret, LOGGER_KEYS.fiveMinutes, start - 300, end);
      return { date, points: powerFromLogger(points).filter((p) => localDate(p.at - 1) === date), error: null };
    } catch (error) {
      this.sid = null;
      return fail(error instanceof Error ? error.message : String(error));
    }
  }

  private async logger(secret: string, key: number, tStart: number, tEnd: number): Promise<LoggerPoint[]> {
    const res = await this.request(secret, (sid) =>
      this.post(`/dyn/getLogger.json?sid=${encodeURIComponent(sid)}`, { destDev: [], key, tStart, tEnd }),
    );
    if (res.status !== 200) {
      throw new Error(inverterError(res.status, res.json));
    }
    return parseLogger(res.json);
  }

  /** Envoie une requête dans la session ouverte, en se reconnectant une fois si elle a expiré. */
  private async request(secret: string, send: (sid: string) => Promise<Response>): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.sid === null) {
        this.sid = await this.login(secret);
      }
      const res = await send(this.sid);
      if (isSessionExpired(res.status, res.json)) {
        this.sid = null;
        continue;
      }
      return res;
    }
    throw new Error("La session de l'onduleur expire sans cesse.");
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
