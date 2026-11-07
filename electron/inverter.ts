import dns from 'node:dns';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
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

/**
 * Résolution du nom de l'onduleur, adresse IPv4 d'abord. L'onduleur s'annonce aussi en IPv6 mais y refuse les
 * connexions ; avec l'essai en parallèle de Node (250 ms pour l'IPv4), une réponse Wi-Fi un peu lente faisait
 * échouer toute la connexion.
 */
const lookupIpv4First: LookupFunction = (hostname, options, callback) =>
  dns.lookup(hostname, { ...options, order: 'ipv4first' }, callback);

/** Codes d'erreur d'une erreur réseau de Node (une `AggregateError` en regroupe plusieurs). */
function errorCodes(error: unknown): string[] {
  const errors = error instanceof AggregateError ? error.errors : [error];
  return errors
    .map((e) => (e as { code?: string } | null)?.code)
    .filter((c): c is string => typeof c === 'string');
}

/** Le nom de l'appareil ne se résout plus sur le réseau ? */
export const isNameNotFound = (error: unknown): boolean =>
  errorCodes(error).some((c) => /ENOTFOUND|EAI_AGAIN/.test(c));

/**
 * Échec réseau (appareil introuvable, injoignable ou muet), par opposition à un refus de l'appareil lui-même.
 * `notFound` : le nom ne se résout plus.
 */
export class NetworkError extends Error {
  constructor(
    message: string,
    readonly notFound = false,
  ) {
    super(message);
  }
}

/** Message lisible d'une erreur réseau (une `AggregateError` de Node n'a pas de message propre). */
export function networkErrorMessage(error: unknown, host: string, subject = 'Onduleur'): string {
  const codes = errorCodes(error);
  if (isNameNotFound(error)) {
    return `${subject} introuvable sur le réseau (${host}).`;
  }
  if (codes.length > 0) {
    return `${subject} injoignable (${host} : ${[...new Set(codes)].join(', ')}).`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message || `Connexion à l'onduleur impossible (${host}).`;
}
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
  /** Dernière adresse IP où l'onduleur épinglé a répondu : repli quand son nom ne se résout plus. */
  private lastAddress: string | null = null;
  /** Adresse IP utilisée à la place du nom pendant l'opération en cours (nom introuvable). */
  private viaAddress: string | null = null;
  private trouble = false;

  constructor(
    private readonly secret: () => string | null,
    private readonly role: InverterRole = 'usr',
    /** Port HTTPS (443 ; autre valeur pour les tests). */
    private readonly port = 443,
  ) {}

  configure(config: InverterConfig): void {
    const changed =
      config.host !== this.config.host || config.certFingerprint !== this.config.certFingerprint;
    if (config.certFingerprint !== this.config.certFingerprint) {
      this.lastAddress = null;
    }
    this.config = { ...config };
    if (changed || !config.enabled) {
      void this.logout();
    }
  }

  get enabled(): boolean {
    return this.config.enabled && this.config.host.length > 0;
  }

  get host(): string {
    return this.config.host;
  }

  get certFingerprint(): string | null {
    return this.config.certFingerprint;
  }

  /**
   * La dernière lecture a-t-elle eu un souci réseau : onduleur injoignable, ou joint seulement par sa dernière
   * adresse IP parce que son nom ne se résout plus ? (Signal pour le rechercher sur le réseau.)
   */
  get troubled(): boolean {
    return this.trouble;
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
      return fail("Clé de l'onduleur absente : ajoutez-la dans les réglages.");
    }
    this.viaAddress = null;
    try {
      const res = await this.request(secret, (sid) =>
        this.post(`/dyn/getValues.json?sid=${encodeURIComponent(sid)}`, {
          destDev: [],
          keys: Object.values(MEASUREMENT_KEYS),
        }),
      );
      const m = parseMeasurements(res.json);
      this.trouble = this.viaAddress !== null;
      return { at, ...m, error: null, certFingerprint: this.seenFingerprint };
    } catch (error) {
      this.sid = null;
      this.trouble = error instanceof NetworkError;
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
      return fail("Clé de l'onduleur absente : ajoutez-la dans les réglages.");
    }
    this.viaAddress = null;
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
      return fail("Clé de l'onduleur absente : ajoutez-la dans les réglages.");
    }
    this.viaAddress = null;
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

  /**
   * Envoie une requête à l'onduleur. Si son nom ne se résout plus (mDNS capricieux, ou onduleur renommé après un
   * conflit de nom), la requête est refaite sur sa dernière adresse IP connue : sans risque, puisque le certificat
   * épinglé est vérifié avant tout envoi.
   */
  private async post(path: string, body: unknown): Promise<Response> {
    if (this.viaAddress !== null) {
      return this.postTo(this.viaAddress, path, body);
    }
    try {
      return await this.postTo(this.config.host, path, body);
    } catch (error) {
      const fallback = this.lastAddress;
      if (
        error instanceof NetworkError &&
        error.notFound &&
        fallback !== null &&
        fallback !== this.config.host &&
        this.config.certFingerprint
      ) {
        this.viaAddress = fallback;
        return this.postTo(fallback, path, body);
      }
      throw error;
    }
  }

  private postTo(host: string, path: string, body: unknown): Promise<Response> {
    const data = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      // `autoSelectFamily` est transmis à la connexion TCP mais absent du type des options HTTPS.
      const options: https.RequestOptions & { autoSelectFamily: boolean } = {
        host,
        port: this.port,
        path,
        method: 'POST',
        // Certificat auto-signé : il est vérifié par épinglage ci-dessous, pas par une autorité.
        rejectUnauthorized: false,
        agent: false,
        lookup: lookupIpv4First,
        autoSelectFamily: false,
        timeout: TIMEOUT_MS,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      };
      const req = https.request(options);
      req.on('timeout', () => req.destroy(new NetworkError(`L'onduleur ne répond pas (${host}).`)));
      req.on('error', (e) =>
        reject(
          e instanceof NetworkError || !('code' in e || e instanceof AggregateError)
            ? e
            : new NetworkError(networkErrorMessage(e, host), isNameNotFound(e)),
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
          if (socket.remoteAddress) {
            this.lastAddress = socket.remoteAddress;
          }
          req.end(data);
        });
      });
    });
  }
}
