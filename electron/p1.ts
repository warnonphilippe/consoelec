import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net, { type LookupFunction } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { NetworkError, isNameNotFound, networkErrorMessage } from './inverter';
import { P1_DATA_PATH, p1Failure, p1StatusError, parseP1Data } from './p1-core';
import { extractTelegram, parseTelegram, telegramCrcOk } from './p1-readers/dsmr';
import { parseHomeWizardV2, parseYouLess } from './p1-readers/formats';
import { p1Reader, type P1ReaderKind } from './shared/p1-readers';
import type { P1Config, P1Reading } from './shared/ipc-contract';

const TIMEOUT_MS = 5_000;
/** Un compteur envoie un télégramme chaque seconde (Belgique) à dix secondes (anciens compteurs). */
const TELEGRAM_TIMEOUT_MS = 15_000;
/** Les réponses des lecteurs font quelques Ko ; au-delà, ce n'est pas un lecteur. */
const MAX_BODY_BYTES = 64 * 1024;
const PAIRING_NAME = 'local/consoelec';
const PAIRING_INTERVAL_MS = 1_000;

/** Adresse IPv4 d'abord : les lecteurs répondent en IPv4 (même précaution que pour l'onduleur). */
const lookupIpv4First: LookupFunction = (hostname, options, callback) =>
  dns.lookup(hostname, { ...options, order: 'ipv4first' }, callback);

const normalizeFingerprint = (f: string): string => f.replace(/:/g, '').toUpperCase();

interface HttpResult {
  readonly status: number;
  readonly json: unknown;
  readonly fingerprint: string | null;
}

interface HttpRequest {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly method?: 'GET' | 'POST';
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  /** HTTPS : empreinte épinglée (`null` : la première vue est acceptée et rapportée). */
  readonly tls?: { readonly pinned: string | null };
  readonly timeoutMs?: number;
}

const toNetworkError = (e: unknown, host: string): Error =>
  e instanceof NetworkError ||
  !(e instanceof Error) ||
  !('code' in e || e instanceof AggregateError)
    ? (e as Error)
    : new NetworkError(networkErrorMessage(e, host, 'Lecteur P1'), isNameNotFound(e));

/** Requête HTTP ou HTTPS (certificat épinglé) au lecteur, réponse JSON. */
function request(r: HttpRequest): Promise<HttpResult> {
  const data = r.body === undefined ? null : JSON.stringify(r.body);
  return new Promise((resolve, reject) => {
    let fingerprint: string | null = null;
    const options: https.RequestOptions & { autoSelectFamily: boolean } = {
      host: r.host,
      port: r.port,
      path: r.path,
      method: r.method ?? 'GET',
      agent: false,
      lookup: lookupIpv4First,
      autoSelectFamily: false,
      timeout: r.timeoutMs ?? TIMEOUT_MS,
      // Certificat du lecteur signé par HomeWizard, pas par une autorité du système : vérifié par épinglage.
      rejectUnauthorized: false,
      headers: {
        Accept: 'application/json',
        ...(data === null
          ? {}
          : {
              'Content-Type': 'application/json',
              'Content-Length': String(Buffer.byteLength(data)),
            }),
        ...r.headers,
      },
    };
    const req = r.tls ? https.request(options) : http.request(options);
    req.on('timeout', () =>
      req.destroy(new NetworkError(`Le lecteur P1 ne répond pas (${r.host}).`)),
    );
    req.on('error', (e) => reject(toNetworkError(e, r.host)));
    if (r.tls) {
      const pinned = r.tls.pinned;
      req.on('socket', (socket) => {
        (socket as TLSSocket).once('secureConnect', () => {
          fingerprint = (socket as TLSSocket).getPeerCertificate()?.fingerprint256 || null;
          if (pinned && normalizeFingerprint(pinned) !== normalizeFingerprint(fingerprint ?? '')) {
            req.destroy(
              new Error(
                'Le certificat du lecteur P1 a changé : connexion refusée. Associez de nouveau le lecteur si c’est normal.',
              ),
            );
            return;
          }
          req.end(data ?? undefined);
        });
      });
    }
    req.on('response', (res) => {
      let text = '';
      let size = 0;
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          req.destroy(new Error("Réponse trop volumineuse : ce n'est pas un lecteur P1."));
          return;
        }
        text += chunk;
      });
      res.on('end', () => {
        let json: unknown = null;
        try {
          json = JSON.parse(text);
        } catch {
          // corps non JSON : on se contente du code
        }
        resolve({ status: res.statusCode ?? 0, json, fingerprint });
      });
    });
    if (!r.tls) {
      req.end(data ?? undefined);
    }
  });
}

/** Lit un télégramme complet et valide sur une connexion TCP qui diffuse le port P1. */
export function readTelegram(
  host: string,
  port: number,
  timeoutMs = TELEGRAM_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let badCrc = 0;
    const socket = net.connect({ host, port, lookup: lookupIpv4First, autoSelectFamily: false });
    const done = (error: Error | null, telegram?: string): void => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.on('error', () => undefined);
      socket.destroy();
      if (telegram !== undefined) {
        resolve(telegram);
      } else {
        reject(error);
      }
    };
    const timer = setTimeout(
      () =>
        done(
          badCrc > 0
            ? new Error(
                'Télégrammes P1 reçus mais corrompus (CRC) : vérifiez le câble et la vitesse du lecteur.',
              )
            : buffer.length > 0
              ? new Error(
                  'Données reçues, mais pas de télégramme P1 complet : est-ce bien le flux brut du compteur ?',
                )
              : new NetworkError(`Le lecteur P1 n'envoie rien sur le port ${port} (${host}).`),
        ),
      timeoutMs,
    );
    socket.setEncoding('latin1');
    socket.on('error', (e) => done(toNetworkError(e, host)));
    socket.on('close', () =>
      done(new NetworkError(`Le lecteur P1 a fermé la connexion (${host}).`)),
    );
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const found = extractTelegram(buffer);
        if (found === null) {
          break;
        }
        buffer = found.rest;
        if (telegramCrcOk(found.telegram)) {
          done(null, found.telegram);
          return;
        }
        badCrc++;
      }
      if (buffer.length > MAX_BODY_BYTES) {
        buffer = buffer.slice(-8192);
      }
    });
  });
}

export interface PairingResult {
  readonly token: string;
  readonly fingerprint: string | null;
}

/**
 * Associe ConsoElec à un lecteur HomeWizard (API v2) : `POST /api/user` répété chaque seconde jusqu'à l'appui sur le
 * bouton du lecteur (réponse 200 avec le jeton), au plus `timeoutMs`.
 */
export async function pairHomeWizard(
  host: string,
  port = 443,
  timeoutMs = 60_000,
  intervalMs = PAIRING_INTERVAL_MS,
): Promise<PairingResult> {
  const end = Date.now() + timeoutMs;
  let fingerprint: string | null = null;
  for (;;) {
    const res = await request({
      host,
      port,
      path: '/api/user',
      method: 'POST',
      body: { name: PAIRING_NAME },
      headers: { 'X-Api-Version': '2' },
      tls: { pinned: fingerprint },
    });
    fingerprint = res.fingerprint ?? fingerprint;
    const token = (res.json as { token?: unknown } | null)?.token;
    if (res.status === 200 && typeof token === 'string' && /^[A-Fa-f0-9]{16,64}$/.test(token)) {
      return { token, fingerprint };
    }
    if (res.status !== 403) {
      throw new Error(
        `Réponse inattendue du lecteur à l'association (code ${res.status}) : l'API v2 est-elle disponible ?`,
      );
    }
    if (Date.now() + intervalMs > end) {
      throw new Error(
        "Bouton du lecteur non pressé à temps : relancez l'association et appuyez sur le bouton.",
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Client local du lecteur P1. Selon le lecteur : API locale HomeWizard v1 (`GET /api/v1/data`) ou v2 (HTTPS, jeton,
 * `GET /api/measurement`), Chargee (même API que HomeWizard v1), YouLess (`GET /e`) ou télégramme brut sur TCP.
 */
export class P1Client {
  private config: P1Config = { enabled: false, host: '' };
  private trouble = false;
  private seenFingerprint: string | null = null;

  constructor(
    /** Jeton de l'API v2 HomeWizard. */
    private readonly token: () => string | null = () => null,
    /** Port par défaut imposé (tests) ; sinon celui du réglage ou du lecteur. */
    private readonly portOverride: number | null = null,
  ) {}

  configure(config: P1Config): void {
    this.config = { ...config };
  }

  get enabled(): boolean {
    return this.config.enabled && this.config.host.length > 0;
  }

  get host(): string {
    return this.config.host;
  }

  get kind(): P1ReaderKind {
    return p1Reader(this.config.kind).id;
  }

  get settings(): P1Config {
    return this.config;
  }

  /** La dernière lecture a-t-elle échoué faute de joindre le lecteur (signal pour le rechercher sur le réseau) ? */
  get troubled(): boolean {
    return this.trouble;
  }

  private get port(): number {
    return this.config.port ?? this.portOverride ?? p1Reader(this.config.kind).defaultPort;
  }

  /** Lit le compteur ; ne lève jamais : l'erreur est rapportée dans le résultat. */
  async read(): Promise<P1Reading> {
    const at = Date.now();
    if (!this.config.host) {
      return p1Failure(at, 'Adresse du lecteur P1 non renseignée.');
    }
    this.trouble = false;
    try {
      const reading = await this.readNow(at);
      return this.seenFingerprint === null
        ? reading
        : { ...reading, certFingerprint: this.seenFingerprint };
    } catch (error) {
      this.trouble = error instanceof NetworkError;
      return p1Failure(at, error instanceof Error ? error.message : String(error));
    }
  }

  private async readNow(at: number): Promise<P1Reading> {
    const host = this.config.host;
    const port = this.port;
    switch (this.kind) {
      case 'homewizard':
      case 'chargee': {
        const res = await request({ host, port, path: P1_DATA_PATH });
        if (res.status !== 200) {
          return p1Failure(at, p1StatusError(res.status, res.json));
        }
        return (
          parseP1Data(res.json, at) ??
          p1Failure(at, "Réponse inattendue : ce n'est pas un lecteur P1 compatible HomeWizard.")
        );
      }
      case 'homewizard-v2': {
        const token = this.token();
        if (token === null) {
          return p1Failure(
            at,
            'Lecteur pas encore associé : cliquez sur « Associer » dans les réglages.',
          );
        }
        const res = await request({
          host,
          port,
          path: '/api/measurement',
          headers: { Authorization: `Bearer ${token}`, 'X-Api-Version': '2' },
          tls: { pinned: this.config.certFingerprint ?? null },
        });
        this.seenFingerprint = res.fingerprint;
        if (res.status === 401 || res.status === 403) {
          return p1Failure(
            at,
            'Jeton refusé par le lecteur P1 : associez-le de nouveau dans les réglages.',
          );
        }
        if (res.status !== 200) {
          return p1Failure(at, `Réponse inattendue du lecteur P1 (code ${res.status}).`);
        }
        return (
          parseHomeWizardV2(res.json, at) ??
          p1Failure(at, "Réponse inattendue : ce n'est pas un lecteur HomeWizard v2.")
        );
      }
      case 'youless': {
        const res = await request({ host, port, path: '/e' });
        if (res.status === 403 || res.status === 401) {
          return p1Failure(
            at,
            'Le YouLess demande un mot de passe : retirez-le dans son interface web.',
          );
        }
        if (res.status !== 200) {
          return p1Failure(at, `Réponse inattendue du YouLess (code ${res.status}).`);
        }
        return (
          parseYouLess(res.json, at) ??
          p1Failure(at, "Réponse inattendue : ce n'est pas un YouLess LS120 avec P1.")
        );
      }
      case 'dsmr-tcp': {
        const telegram = await readTelegram(host, port);
        return (
          parseTelegram(telegram, at) ?? p1Failure(at, 'Télégramme P1 sans index de compteur.')
        );
      }
    }
  }
}
