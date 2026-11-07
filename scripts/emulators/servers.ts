import crypto from 'node:crypto';
import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { crc16 } from '../../electron/inverters/modbus';
import { SRP_G, SRP_N, modPow, pad, strip, toBn, toBuf } from '../../electron/sma-core';
import type { SolarModel } from './solar-model';

/**
 * Serveurs émulant les onduleurs sur la machine : Modbus TCP, clé Solarman (V5), clé GoodWe (UDP), Fronius Solar
 * API, passerelle Enphase, SMA WebConnect (connexion SRP ou ancienne connexion par mot de passe). Chacun écoute sur
 * le port demandé (0 : port libre au hasard) et renvoie son port réel.
 */

export type RegisterProvider = (fn: number, address: number, count: number) => number[] | null;

export interface Running {
  readonly port: number;
  close(): Promise<void>;
}

const listenTcp = (
  server: net.Server | http.Server,
  port: number,
  host: string,
): Promise<Running> =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address() as net.AddressInfo;
      resolve({
        port: address.port,
        close: () =>
          new Promise<void>((done) => {
            (server as net.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });

const listenUdp = (socket: dgram.Socket, port: number, host: string): Promise<Running> =>
  new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(port, host, () =>
      resolve({
        port: socket.address().port,
        close: () => new Promise<void>((done) => socket.close(() => done())),
      }),
    );
  });

/** Réponse Modbus (PDU) à une lecture : données ou exception. */
function modbusPdu(fn: number, address: number, count: number, provider: RegisterProvider): Buffer {
  if (fn !== 3 && fn !== 4) {
    return Buffer.from([fn | 0x80, 1]);
  }
  if (count < 1 || count > 125) {
    return Buffer.from([fn | 0x80, 3]);
  }
  const values = provider(fn, address, count);
  if (values === null) {
    return Buffer.from([fn | 0x80, 2]);
  }
  const pdu = Buffer.alloc(2 + count * 2);
  pdu.writeUInt8(fn, 0);
  pdu.writeUInt8(count * 2, 1);
  values.forEach((v, i) => pdu.writeUInt16BE(v, 2 + i * 2));
  return pdu;
}

/** Réponse RTU complète (adresse + PDU + CRC) à une requête RTU, ou `null` si elle ne s'adresse pas à cet appareil. */
export function rtuReply(
  request: Buffer,
  unitId: number,
  provider: RegisterProvider,
): Buffer | null {
  if (request.length < 8 || crc16(request.subarray(0, 6)) !== request.readUInt16LE(6)) {
    return null;
  }
  if (request.readUInt8(0) !== unitId) {
    return null;
  }
  const pdu = modbusPdu(
    request.readUInt8(1),
    request.readUInt16BE(2),
    request.readUInt16BE(4),
    provider,
  );
  const frame = Buffer.concat([Buffer.from([unitId]), pdu, Buffer.alloc(2)]);
  frame.writeUInt16LE(crc16(frame.subarray(0, frame.length - 2)), frame.length - 2);
  return frame;
}

export interface ModbusTcpEmulator {
  readonly unitId: number;
  readonly provider: RegisterProvider;
  /** Délai avant de répondre (ms). */
  readonly delayMs?: number;
}

/** Serveur Modbus TCP : répond aux lectures de l'identifiant `unitId` (exception 11 pour un autre). */
export function startModbusTcp(
  options: ModbusTcpEmulator,
  port = 0,
  host = '127.0.0.1',
): Promise<Running> {
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 7 && buffer.length >= 6 + buffer.readUInt16BE(4)) {
        const length = 6 + buffer.readUInt16BE(4);
        const frame = buffer.subarray(0, length);
        buffer = buffer.subarray(length);
        const transaction = frame.readUInt16BE(0);
        const unit = frame.readUInt8(6);
        const fn = frame.readUInt8(7);
        const pdu =
          unit !== options.unitId
            ? Buffer.from([fn | 0x80, 11])
            : modbusPdu(fn, frame.readUInt16BE(8), frame.readUInt16BE(10), options.provider);
        const reply = Buffer.alloc(7 + pdu.length);
        reply.writeUInt16BE(transaction, 0);
        reply.writeUInt16BE(0, 2);
        reply.writeUInt16BE(pdu.length + 1, 4);
        reply.writeUInt8(unit, 6);
        pdu.copy(reply, 7);
        setTimeout(() => socket.write(reply), options.delayMs ?? 0);
      }
    });
  });
  return listenTcp(server, port, host);
}

// --- Clé Solarman (protocole V5) ---

const v5Checksum = (frame: Buffer): number => {
  let sum = 0;
  for (let i = 1; i < frame.length - 2; i++) {
    sum = (sum + frame[i]!) & 0xff;
  }
  return sum;
};

function v5Frame(control: number, sequence: number, serial: number, payload: Buffer): Buffer {
  const frame = Buffer.alloc(11 + payload.length + 2);
  frame.writeUInt8(0xa5, 0);
  frame.writeUInt16LE(payload.length, 1);
  frame.writeUInt16LE(control, 3);
  frame.writeUInt16LE(sequence, 5);
  frame.writeUInt32LE(serial >>> 0, 7);
  payload.copy(frame, 11);
  frame.writeUInt8(v5Checksum(frame), frame.length - 2);
  frame.writeUInt8(0x15, frame.length - 1);
  return frame;
}

export interface SolarmanEmulator {
  readonly loggerSerial: number;
  readonly unitId: number;
  readonly provider: RegisterProvider;
}

/**
 * Clé Wi-Fi Solarman : trames V5 enveloppant du Modbus RTU. Envoie un « battement de cœur » à la connexion, comme
 * les vraies clés. Un numéro de série erroné reçoit une réponse sans trame Modbus.
 */
export function startSolarman(
  options: SolarmanEmulator,
  port = 0,
  host = '127.0.0.1',
): Promise<Running> {
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('error', () => undefined);
    socket.write(v5Frame(0x4710, 0, options.loggerSerial, Buffer.from([0x00])));
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 13 && buffer.length >= 13 + buffer.readUInt16LE(1)) {
        const length = 13 + buffer.readUInt16LE(1);
        const frame = buffer.subarray(0, length);
        buffer = buffer.subarray(length);
        if (frame.readUInt16LE(3) !== 0x4510) {
          continue;
        }
        const sequence = frame.readUInt16LE(5);
        const serial = frame.readUInt32LE(7);
        const header = Buffer.alloc(14);
        header.writeUInt8(0x02, 0);
        header.writeUInt8(0x01, 1);
        let rtu: Buffer | null = null;
        if (serial === options.loggerSerial) {
          rtu = rtuReply(frame.subarray(26, length - 2), options.unitId, options.provider);
        }
        socket.write(
          v5Frame(
            0x1510,
            sequence,
            options.loggerSerial,
            Buffer.concat([header, rtu ?? Buffer.alloc(0)]),
          ),
        );
      }
    });
  });
  return listenTcp(server, port, host);
}

// --- Clé GoodWe (Modbus RTU sur UDP) ---

export function startGoodWe(
  options: { unitId: number; provider: RegisterProvider },
  port = 0,
  host = '127.0.0.1',
): Promise<Running> {
  const socket = dgram.createSocket('udp4');
  socket.on('message', (msg, from) => {
    const reply = rtuReply(msg, options.unitId, options.provider);
    if (reply !== null) {
      socket.send(Buffer.concat([Buffer.from([0xaa, 0x55]), reply]), from.port, from.address);
    }
  });
  return listenUdp(socket, port, host);
}

/** Répond à la diffusion « WIFIKIT-214028-READ » par « ip,mac,numéro de série ». */
export function startWifikit(
  reply: { ip: string; mac: string; serial: string },
  port = 48899,
  host = '0.0.0.0',
): Promise<Running> {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  socket.on('message', (msg, from) => {
    if (msg.toString('utf8') === 'WIFIKIT-214028-READ') {
      socket.send(`${reply.ip},${reply.mac},${reply.serial}`, from.port, from.address);
    }
  });
  return listenUdp(socket, port, host);
}

// --- Fronius Solar API ---

export function startFronius(
  model: SolarModel,
  options: { gen24?: boolean } = {},
  port = 0,
  host = '127.0.0.1',
): Promise<Running> {
  const head = {
    RequestArguments: {},
    Status: { Code: 0, Reason: '', UserMessage: '' },
    Timestamp: new Date().toISOString(),
  };
  const server = http.createServer((req, res) => {
    const s = model.state();
    const night = s.powerW === 0;
    const url = req.url ?? '';
    res.setHeader('Content-Type', 'application/json');
    if (url.startsWith('/solar_api/GetAPIVersion.cgi')) {
      res.end(
        JSON.stringify({ APIVersion: 1, BaseURL: '/solar_api/v1/', CompatibilityRange: '1.8-1' }),
      );
    } else if (url.startsWith('/solar_api/v1/GetPowerFlowRealtimeData.fcgi')) {
      res.end(
        JSON.stringify({
          Head: head,
          Body: {
            Data: {
              Site: {
                Mode: 'produce-only',
                P_PV: night ? null : s.powerW,
                P_Grid: null,
                P_Load: null,
                E_Day: options.gen24 ? null : s.dayWh,
                E_Year: options.gen24 ? null : s.dayWh * 120,
                E_Total: s.totalWh,
              },
              Inverters: {
                '1': {
                  DT: 1,
                  P: s.powerW,
                  E_Day: options.gen24 ? null : s.dayWh,
                  E_Total: s.totalWh,
                },
              },
              Version: '12',
            },
          },
        }),
      );
    } else if (url.startsWith('/solar_api/v1/GetInverterRealtimeData.cgi')) {
      res.end(
        JSON.stringify({
          Head: head,
          Body: {
            Data: {
              PAC: { Unit: 'W', Value: s.powerW },
              DAY_ENERGY: { Unit: 'Wh', Value: s.dayWh },
              TOTAL_ENERGY: { Unit: 'Wh', Value: s.totalWh },
              DeviceStatus: { StatusCode: night ? 3 : 7 },
            },
          },
        }),
      );
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  return listenTcp(server, port, host);
}

// --- Passerelle Enphase ---

export function startEnphase(
  model: SolarModel,
  tls: { key: string; cert: string },
  token: string,
  port = 0,
  host = '127.0.0.1',
): Promise<Running> {
  const server = https.createServer(tls, (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.statusCode = 401;
      res.end('{"error":"unauthorized"}');
      return;
    }
    if (req.url === '/api/v1/production') {
      const s = model.state();
      res.end(
        JSON.stringify({
          wattHoursToday: s.dayWh,
          wattHoursSevenDays: s.dayWh * 6,
          wattHoursLifetime: s.totalWh,
          wattsNow: s.powerW,
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  return listenTcp(server, port, host);
}

// --- SMA WebConnect ---

const hash = (alg: string, ...parts: Buffer[]): Buffer => {
  const h = crypto.createHash(alg);
  parts.forEach((p) => h.update(p));
  return h.digest();
};

/** Côté onduleur du protocole SRP SMA (même spécification que le client). */
function srpServer(role: string, secret: string) {
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

export interface SmaEmulator {
  readonly secret: string;
  /** `password` : ancien logiciel (`/dyn/login.json`), sans connexion SRP. */
  readonly auth: 'srp' | 'password';
}

/** Onduleur SMA WebConnect : mesures et journaux (5 minutes et quotidien) tirés du modèle solaire. */
export function startSma(
  model: SolarModel,
  tls: { key: string; cert: string },
  options: SmaEmulator,
  port = 0,
  host = '127.0.0.1',
): Promise<Running> {
  const sessions = new Set<string>();
  let pendingA = '';
  let srp = srpServer('usr', options.secret);
  const server = https.createServer(tls, (req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0]!;
      const sid = new URL(req.url ?? '/', 'https://x').searchParams.get('sid') ?? '';
      let json: Record<string, unknown> = {};
      try {
        json = body ? JSON.parse(body) : {};
      } catch {
        // corps illisible : traité comme vide
      }
      res.setHeader('Content-Type', 'application/json');
      const send = (status: number, payload: unknown): void => {
        res.statusCode = status;
        res.end(JSON.stringify(payload));
      };
      const open = (): string => {
        const id = crypto.randomBytes(12).toString('base64url');
        sessions.add(id);
        return id;
      };
      if (path === '/dyn/authYAPStart.json' && options.auth === 'srp') {
        srp = srpServer('usr', options.secret);
        pendingA = String(json['A'] ?? '');
        send(200, srp.first);
      } else if (path === '/dyn/authYAPFinish.json' && options.auth === 'srp') {
        const r = srp.finish(pendingA, String(json['M1'] ?? ''));
        send(
          200,
          r.ok
            ? { M2: r.M2, result: { sid: open() } }
            : { error: { code: -28607 }, result: { res: -28607 } },
        );
      } else if (path === '/dyn/login.json' && options.auth === 'password') {
        send(200, json['pass'] === options.secret ? { result: { sid: open() } } : { err: 401 });
      } else if (path === '/dyn/logout.json') {
        sessions.delete(sid);
        send(200, { result: { isLogin: false } });
      } else if (path === '/dyn/getValues.json' || path === '/dyn/getLogger.json') {
        if (!sessions.has(sid)) {
          send(200, { err: 401 });
          return;
        }
        if (path === '/dyn/getValues.json') {
          const s = model.state();
          send(200, {
            result: {
              '017A-xxxxx00D': {
                '6100_40263F00': { '1': [{ val: s.powerW === 0 ? null : s.powerW }] },
                '6400_00260100': { '1': [{ val: s.totalWh }] },
                '6400_00262200': { '1': [{ val: s.dayWh }] },
              },
            },
          });
          return;
        }
        // Journaux : index de production toutes les 5 minutes (28672) ou chaque jour à minuit (28704), sur 30 jours.
        const step = json['key'] === 28704 ? 86_400 : 300;
        const now = Math.floor(model.now() / 1000);
        const tStart = Math.max(Number(json['tStart'] ?? 0), now - 30 * 86_400);
        const tEnd = Math.min(Number(json['tEnd'] ?? now), now);
        const points = [];
        for (let t = Math.ceil(tStart / step) * step; t <= tEnd; t += step) {
          points.push({ t, v: model.state(t * 1000).totalWh });
        }
        send(200, { result: { '017A-xxxxx00D': points } });
      } else {
        send(404, { err: 404 });
      }
    });
  });
  return listenTcp(server, port, host);
}
