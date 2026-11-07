import http from 'node:http';
import type { LookupFunction } from 'node:net';
import type { Measurements } from '../sma-core';

/**
 * Fronius Solar API v1 (HTTP JSON, sans authentification) : flux de puissance du site (puissance des panneaux,
 * production du jour et totale), complété au besoin par les données de l'onduleur n° 1 (les GEN24 ne donnent pas
 * toujours la production du jour dans le flux de puissance).
 */

export const FRONIUS_POWER_FLOW = '/solar_api/v1/GetPowerFlowRealtimeData.fcgi';
export const FRONIUS_INVERTER =
  '/solar_api/v1/GetInverterRealtimeData.cgi?Scope=Device&DeviceId=1&DataCollection=CommonInverterData';

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function body(json: unknown): Record<string, unknown> {
  const root = json as { Head?: { Status?: { Code?: number; Reason?: string } }; Body?: { Data?: unknown } } | null;
  const status = root?.Head?.Status;
  if (status && typeof status.Code === 'number' && status.Code !== 0) {
    throw new Error(`L'onduleur Fronius signale une erreur ${status.Code}${status.Reason ? ` (${status.Reason})` : ''}.`);
  }
  const data = root?.Body?.Data;
  if (data === null || typeof data !== 'object') {
    throw new Error("Réponse inattendue de l'onduleur Fronius : la Solar API est-elle activée ?");
  }
  return data as Record<string, unknown>;
}

/** Mesures du flux de puissance (`GetPowerFlowRealtimeData`). */
export function parsePowerFlow(json: unknown): Measurements {
  const site = (body(json)['Site'] ?? null) as Record<string, unknown> | null;
  if (site === null || typeof site !== 'object') {
    throw new Error("Réponse inattendue de l'onduleur Fronius (flux de puissance).");
  }
  const pv = num(site['P_PV']);
  return {
    powerW: pv === null ? null : Math.max(0, pv),
    dayWh: num(site['E_Day']),
    totalWh: num(site['E_Total']),
  };
}

/** Mesures de l'onduleur n° 1 (`GetInverterRealtimeData`, données communes). */
export function parseInverterData(json: unknown): Measurements {
  const data = body(json);
  const value = (key: string): number | null => num((data[key] as { Value?: unknown } | undefined)?.Value);
  const pac = value('PAC');
  return { powerW: pac === null ? null : Math.max(0, pac), dayWh: value('DAY_ENERGY'), totalWh: value('TOTAL_ENERGY') };
}

export interface HttpOptions {
  readonly host: string;
  readonly port: number;
  readonly timeoutMs?: number;
  readonly lookup?: LookupFunction;
}

/** GET HTTP renvoyant le JSON (code HTTP vérifié). */
export function getJson(
  options: HttpOptions,
  path: string,
  networkError: (error: unknown) => Error,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: options.host,
      port: options.port,
      path,
      method: 'GET',
      agent: false,
      lookup: options.lookup,
      timeout: options.timeoutMs ?? 10_000,
      headers: { Accept: 'application/json' },
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (e) => reject(networkError(e)));
    req.on('response', (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        if ((res.statusCode ?? 0) !== 200) {
          reject(new Error(`Réponse HTTP ${res.statusCode} de l'onduleur (${path.split('?')[0]}).`));
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(new Error("Réponse illisible de l'onduleur (JSON attendu)."));
        }
      });
    });
    req.end();
  });
}

export class FroniusReader {
  constructor(
    private readonly options: HttpOptions,
    private readonly networkError: (error: unknown) => Error,
  ) {}

  async read(): Promise<Measurements> {
    const flow = parsePowerFlow(await getJson(this.options, FRONIUS_POWER_FLOW, this.networkError));
    if (flow.dayWh !== null && flow.totalWh !== null) {
      return flow;
    }
    // GEN24 et certains logiciels : production du jour ou totale absente du flux de puissance.
    try {
      const inverter = parseInverterData(await getJson(this.options, FRONIUS_INVERTER, this.networkError));
      return {
        powerW: flow.powerW ?? inverter.powerW,
        dayWh: flow.dayWh ?? inverter.dayWh,
        totalWh: flow.totalWh ?? inverter.totalWh,
      };
    } catch {
      return flow;
    }
  }
}
