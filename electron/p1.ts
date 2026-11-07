import dns from 'node:dns';
import http from 'node:http';
import type { LookupFunction } from 'node:net';
import { NetworkError, isNameNotFound, networkErrorMessage } from './inverter';
import { P1_DATA_PATH, p1Failure, p1StatusError, parseP1Data } from './p1-core';
import type { P1Config, P1Reading } from './shared/ipc-contract';

const TIMEOUT_MS = 5_000;
/** La réponse du lecteur fait moins de 2 Ko ; au-delà, ce n'est pas lui. */
const MAX_BODY_BYTES = 64 * 1024;

/** Adresse IPv4 d'abord : le lecteur répond en IPv4 (même précaution que pour l'onduleur). */
const lookupIpv4First: LookupFunction = (hostname, options, callback) =>
  dns.lookup(hostname, { ...options, order: 'ipv4first' }, callback);

/**
 * Client local du lecteur P1 HomeWizard : une requête HTTP `GET /api/v1/data` sur le réseau de la maison.
 * Le lecteur renvoie les index et la puissance du compteur, mis à jour chaque seconde.
 */
export class P1Client {
  private config: P1Config = { enabled: false, host: '' };
  private trouble = false;

  constructor(
    /** Port HTTP (80 ; autre valeur pour les tests). */
    private readonly port = 80,
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

  /** La dernière lecture a-t-elle échoué faute de joindre le lecteur (signal pour le rechercher sur le réseau) ? */
  get troubled(): boolean {
    return this.trouble;
  }

  /** Lit le compteur ; ne lève jamais : l'erreur est rapportée dans le résultat. */
  async read(): Promise<P1Reading> {
    const at = Date.now();
    if (!this.config.host) {
      return p1Failure(at, 'Adresse du lecteur P1 non renseignée.');
    }
    this.trouble = false;
    try {
      const res = await this.get(P1_DATA_PATH);
      if (res.status !== 200) {
        return p1Failure(at, p1StatusError(res.status, res.json));
      }
      return (
        parseP1Data(res.json, at) ??
        p1Failure(at, "Réponse inattendue : ce n'est pas un lecteur P1 HomeWizard.")
      );
    } catch (error) {
      this.trouble = error instanceof NetworkError;
      return p1Failure(at, error instanceof Error ? error.message : String(error));
    }
  }

  private get(path: string): Promise<{ status: number; json: unknown }> {
    const host = this.config.host;
    return new Promise((resolve, reject) => {
      const req = http.get({
        host,
        port: this.port,
        path,
        agent: false,
        lookup: lookupIpv4First,
        timeout: TIMEOUT_MS,
        headers: { Accept: 'application/json' },
      });
      req.on('timeout', () =>
        req.destroy(new NetworkError(`Le lecteur P1 ne répond pas (${host}).`)),
      );
      req.on('error', (e) =>
        reject(
          e instanceof NetworkError || !('code' in e || e instanceof AggregateError)
            ? e
            : new NetworkError(networkErrorMessage(e, host, 'Lecteur P1'), isNameNotFound(e)),
        ),
      );
      req.on('response', (res) => {
        let text = '';
        let size = 0;
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            req.destroy(
              new Error("Réponse trop volumineuse : ce n'est pas un lecteur P1 HomeWizard."),
            );
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
          resolve({ status: res.statusCode ?? 0, json });
        });
      });
    });
  }
}
