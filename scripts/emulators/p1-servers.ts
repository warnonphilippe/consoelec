import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { buildTelegram, type MeterModel } from './p1-meter';
import type { Running } from './servers';

/**
 * Lecteurs P1 émulés, écrits d'après la documentation de chaque fabricant : HomeWizard API v1 et v2 (avec
 * association par le bouton), Chargee (API compatible HomeWizard v1), YouLess LS120, et un lecteur qui diffuse le
 * télégramme brut du compteur sur TCP.
 */

const listen = (server: net.Server, port: number, host: string): Promise<Running> =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () =>
      resolve({
        port: (server.address() as net.AddressInfo).port,
        close: () =>
          new Promise<void>((done) => {
            (server as net.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
            server.close(() => done());
          }),
      }),
    );
  });

const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
};

/** Réponse `GET /api/v1/data` d'un HomeWizard P1 (et d'un Chargee), forme de la documentation v1. */
export function homeWizardV1Data(meter: MeterModel): Record<string, unknown> {
  const s = meter.state();
  return {
    wifi_ssid: 'Maison',
    wifi_strength: 84,
    smr_version: 50,
    meter_model: 'ISKRA 2M550E-1012',
    unique_id: '3153414733313031303231363035',
    active_tariff: s.tariff,
    total_power_import_kwh: Math.round((s.importT1 + s.importT2) * 1000) / 1000,
    total_power_import_t1_kwh: s.importT1,
    total_power_import_t2_kwh: s.importT2,
    total_power_export_kwh: Math.round((s.exportT1 + s.exportT2) * 1000) / 1000,
    total_power_export_t1_kwh: s.exportT1,
    total_power_export_t2_kwh: s.exportT2,
    active_power_w: s.powerW,
    active_power_l1_w: s.powerW,
    active_power_average_w: s.quarterHourAvgW,
    montly_power_peak_w: 4321,
  };
}

export function startHomeWizardV1(
  meter: MeterModel,
  options: { apiEnabled?: boolean; product?: 'homewizard' | 'chargee' } = {},
  port = 0,
  host = '127.0.0.1',
): Promise<Running> {
  const chargee = options.product === 'chargee';
  const server = http.createServer((req, res) => {
    if (options.apiEnabled === false) {
      json(res, 403, { error: 'api:disabled' });
    } else if (req.url === '/api') {
      json(res, 200, {
        product_type: chargee ? 'SPARKY' : 'HWE-P1',
        product_name: chargee ? 'Sparky' : 'P1 meter',
        serial: '3c39e7aabbcc',
        firmware_version: chargee ? '1.4.0' : '5.18',
        api_version: 'v1',
      });
    } else if (req.url === '/api/v1/data') {
      json(res, 200, homeWizardV1Data(meter));
    } else {
      json(res, 404, { error: 'request:not-found' });
    }
  });
  return listen(server, port, host);
}

export interface HomeWizardV2Emulator extends Running {
  /** Appui sur le bouton du lecteur : la prochaine demande de jeton dans les 30 s réussit. */
  pressButton(): void;
  /** Jeton délivré (le dernier). */
  readonly token: () => string | null;
}

/**
 * HomeWizard API v2 : HTTPS (certificat fourni), `POST /api/user` renvoie 403 tant que le bouton n'a pas été pressé,
 * puis le jeton ; `GET /api/measurement` exige ce jeton et l'en-tête `X-Api-Version: 2`.
 * `autoPressAfter` : nombre de demandes refusées avant un appui simulé (CLI, tests).
 */
export function startHomeWizardV2(
  meter: MeterModel,
  tls: { key: string; cert: string },
  options: { autoPressAfter?: number } = {},
  port = 0,
  host = '127.0.0.1',
): Promise<HomeWizardV2Emulator> {
  let pressedUntil = 0;
  let token: string | null = null;
  let refused = 0;
  const server = https.createServer(tls, (req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.headers['x-api-version'] !== '2') {
        json(res, 400, { error: 'request:api-version-not-supported' });
        return;
      }
      if (req.method === 'POST' && req.url === '/api/user') {
        let name = '';
        try {
          name = String((JSON.parse(body) as { name?: unknown }).name ?? '');
        } catch {
          json(res, 400, { error: 'request:invalid-json' });
          return;
        }
        if (!/^local\/[a-zA-Z0-9\-_/\\# ]{1,40}$/.test(name)) {
          json(res, 400, { error: 'request:invalid-value' });
          return;
        }
        if (options.autoPressAfter !== undefined && ++refused > options.autoPressAfter) {
          pressedUntil = Date.now() + 30_000;
        }
        if (Date.now() > pressedUntil) {
          json(res, 403, { error: 'user:creation-not-enabled' });
          return;
        }
        token = crypto.randomBytes(16).toString('hex').toUpperCase();
        pressedUntil = 0;
        refused = 0;
        json(res, 200, { token, name });
        return;
      }
      if (token === null || req.headers.authorization !== `Bearer ${token}`) {
        json(res, 401, { error: 'user:unauthorized' });
        return;
      }
      if (req.method === 'GET' && req.url === '/api/measurement') {
        const s = meter.state();
        json(res, 200, {
          protocol_version: 50,
          meter_model: 'ISKRA 2M550E-1012',
          unique_id: '3153414733313031303231363035',
          tariff: s.tariff,
          energy_import_kwh: Math.round((s.importT1 + s.importT2) * 1000) / 1000,
          energy_import_t1_kwh: s.importT1,
          energy_import_t2_kwh: s.importT2,
          energy_export_kwh: Math.round((s.exportT1 + s.exportT2) * 1000) / 1000,
          energy_export_t1_kwh: s.exportT1,
          energy_export_t2_kwh: s.exportT2,
          power_w: s.powerW,
          power_l1_w: s.powerW,
          average_power_15m_w: s.quarterHourAvgW,
          monthly_power_peak_w: 4321,
        });
        return;
      }
      if (req.method === 'GET' && req.url === '/api') {
        json(res, 200, {
          product_name: 'P1 Meter',
          product_type: 'HWE-P1',
          serial: '5c2fafaabbcc',
          firmware_version: '6.00',
          api_version: '2.0.0',
        });
        return;
      }
      json(res, 404, { error: 'request:not-found' });
    });
  });
  return listen(server, port, host).then((running) => ({
    ...running,
    pressButton: () => {
      pressedUntil = Date.now() + 30_000;
    },
    token: () => token,
  }));
}

/** YouLess LS120 : `GET /e` (tableau d'un objet, index en kWh, puissance nette en W). */
export function startYouLess(meter: MeterModel, port = 0, host = '127.0.0.1'): Promise<Running> {
  const server = http.createServer((req, res) => {
    if (req.url === '/e' || req.url === '/e?f=j') {
      const s = meter.state();
      json(res, 200, [
        {
          tm: Math.floor(meter.now() / 1000),
          net: Math.round((s.importT1 + s.importT2 - s.exportT1 - s.exportT2) * 1000) / 1000,
          pwr: s.powerW,
          ts0: Math.floor(meter.now() / 1000),
          cs0: 0,
          ps0: 0,
          p1: s.importT1,
          p2: s.importT2,
          n1: s.exportT1,
          n2: s.exportT2,
          gas: 0,
          gts: 0,
        },
      ]);
    } else if (req.url === '/d') {
      json(res, 200, { mac: '72:b8:ad:14:16:2e' });
    } else {
      res.statusCode = 404;
      res.end('Not found');
    }
  });
  return listen(server, port, host);
}

/**
 * Lecteur qui relaie le port P1 tel quel sur TCP (ESPHome, ser2net…) : un télégramme par seconde, comme un compteur
 * belge. `corrupt` : CRC faux (câble défectueux) ; la connexion commence au milieu d'un télégramme.
 */
export function startDsmrTcp(
  meter: MeterModel,
  options: { intervalMs?: number; corrupt?: boolean } = {},
  port = 0,
  host = '127.0.0.1',
): Promise<Running> {
  const server = net.createServer((socket) => {
    socket.on('error', () => undefined);
    const send = (): void => {
      let telegram = buildTelegram(meter.state(), meter.now());
      if (options.corrupt) {
        telegram = telegram.replace('1-0:1.8.1(', '1-0:1.8.1(9');
      }
      socket.write(Buffer.from(telegram, 'latin1'));
    };
    // Fin d'un télégramme précédent, comme quand on se branche au milieu d'un envoi.
    socket.write('1-0:2.7.0(00.000*kW)\r\n!1A2B\r\n');
    send();
    const timer = setInterval(send, options.intervalMs ?? 1000);
    socket.on('close', () => clearInterval(timer));
  });
  return listen(server, port, host);
}
