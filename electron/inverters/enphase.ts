import https from 'node:https';
import type { LookupFunction } from 'node:net';
import type { TLSSocket } from 'node:tls';
import type { Measurements } from '../sma-core';

/**
 * Passerelle Enphase IQ Gateway (Envoy) : API locale HTTPS `/api/v1/production`, avec le jeton du propriétaire
 * (logiciel 7 et suivants). Le certificat auto-signé de la passerelle est épinglé comme celui d'un onduleur SMA.
 */

export const ENPHASE_PRODUCTION = '/api/v1/production';

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Mesures de `/api/v1/production` (`wattsNow`, `wattHoursToday`, `wattHoursLifetime`). */
export function parseEnphaseProduction(json: unknown): Measurements {
  const p = json as Record<string, unknown> | null;
  if (p === null || typeof p !== 'object' || !('wattsNow' in p)) {
    throw new Error('Réponse inattendue de la passerelle Enphase.');
  }
  const w = num(p['wattsNow']);
  return {
    powerW: w === null ? null : Math.max(0, w),
    dayWh: num(p['wattHoursToday']),
    totalWh: num(p['wattHoursLifetime']),
  };
}

const normalize = (f: string): string => f.replace(/:/g, '').toUpperCase();

export interface EnphaseOptions {
  readonly host: string;
  readonly port: number;
  readonly token: string;
  /** Empreinte épinglée, ou `null` à la première connexion. */
  readonly pinned: string | null;
  readonly timeoutMs?: number;
  readonly lookup?: LookupFunction;
}

export class EnphaseReader {
  /** Empreinte du certificat présenté à la dernière connexion. */
  seenFingerprint: string | null = null;

  constructor(
    private readonly options: EnphaseOptions,
    private readonly networkError: (error: unknown) => Error,
  ) {}

  read(): Promise<Measurements> {
    const { host, port, token, pinned, lookup } = this.options;
    return new Promise((resolve, reject) => {
      const options: https.RequestOptions & { autoSelectFamily: boolean } = {
        host,
        port,
        path: ENPHASE_PRODUCTION,
        method: 'GET',
        // Certificat auto-signé : vérifié par épinglage ci-dessous.
        rejectUnauthorized: false,
        agent: false,
        lookup,
        autoSelectFamily: false,
        timeout: this.options.timeoutMs ?? 10_000,
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      };
      const req = https.request(options);
      req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
      req.on('error', (e) => reject('code' in e || e instanceof AggregateError ? this.networkError(e) : e));
      req.on('socket', (socket) => {
        (socket as TLSSocket).once('secureConnect', () => {
          const fingerprint = (socket as TLSSocket).getPeerCertificate()?.fingerprint256 ?? '';
          this.seenFingerprint = fingerprint || null;
          if (pinned && normalize(pinned) !== normalize(fingerprint)) {
            req.destroy(
              new Error(
                "Le certificat de la passerelle Enphase a changé : connexion refusée. Réinitialisez l'empreinte dans les réglages si c'est normal.",
              ),
            );
            return;
          }
          req.end();
        });
      });
      req.on('response', (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status === 401 || status === 403) {
            reject(new Error(`Jeton refusé par la passerelle Enphase (${status}) : créez-en un nouveau sur entrez.enphaseenergy.com.`));
            return;
          }
          if (status !== 200) {
            reject(new Error(`Réponse HTTP ${status} de la passerelle Enphase.`));
            return;
          }
          try {
            resolve(parseEnphaseProduction(JSON.parse(text)));
          } catch (error) {
            reject(error instanceof SyntaxError ? new Error('Réponse illisible de la passerelle Enphase.') : error);
          }
        });
      });
    });
  }
}
