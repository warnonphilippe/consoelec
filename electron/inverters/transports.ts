import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import net from 'node:net';
import {
  ModbusTcpClient,
  parseRtuReadResponse,
  rtuReadRequest,
  type ReadFunction,
  type RegisterReader,
} from './modbus';

/**
 * Transports des registres Modbus autres que Modbus TCP : clés Wi-Fi Solarman (protocole « V5 », Solis, Deye, Sofar)
 * et clés GoodWe (Modbus RTU sur UDP).
 */

// --- Solarman V5 ---

const V5_START = 0xa5;
const V5_END = 0x15;
const V5_REQUEST = 0x4510;
const V5_RESPONSE = 0x1510;
/** En-tête (début, longueur, code, séquence, numéro de série de la clé). */
const V5_HEADER = 11;

/** Somme des octets de la trame, du champ longueur à la fin des données, sur 8 bits. */
const v5Checksum = (frame: Buffer, end: number): number => {
  let sum = 0;
  for (let i = 1; i < end; i++) {
    sum = (sum + frame[i]!) & 0xff;
  }
  return sum;
};

/** Numéro de série de la clé Solarman (étiquette, 10 chiffres) en entier ; erreur s'il n'est pas valide. */
export function parseLoggerSerial(serial: string): number {
  const digits = serial.trim();
  if (!/^\d{1,10}$/.test(digits) || Number(digits) > 0xffffffff) {
    throw new Error('Numéro de série de la clé Wi-Fi invalide (jusqu’à 10 chiffres, sur son étiquette).');
  }
  return Number(digits);
}

/** Trame V5 de requête enveloppant une trame Modbus RTU. */
export function v5Request(loggerSerial: number, sequence: number, rtu: Buffer): Buffer {
  const payload = Buffer.alloc(15 + rtu.length);
  payload.writeUInt8(0x02, 0); // trame « données »
  // capteur (2 octets) et trois horodatages (12 octets) à zéro
  rtu.copy(payload, 15);
  const frame = Buffer.alloc(V5_HEADER + payload.length + 2);
  frame.writeUInt8(V5_START, 0);
  frame.writeUInt16LE(payload.length, 1);
  frame.writeUInt16LE(V5_REQUEST, 3);
  frame.writeUInt16LE(sequence & 0xffff, 5);
  frame.writeUInt32LE(loggerSerial >>> 0, 7);
  payload.copy(frame, V5_HEADER);
  frame.writeUInt8(v5Checksum(frame, V5_HEADER + payload.length), frame.length - 2);
  frame.writeUInt8(V5_END, frame.length - 1);
  return frame;
}

/** Longueur de la trame V5 complète au début de `buffer` (`null` si incomplète) ; les octets parasites sont sautés. */
export function v5FrameLength(buffer: Buffer): number | null {
  if (buffer.length < V5_HEADER + 2) {
    return null;
  }
  const length = V5_HEADER + buffer.readUInt16LE(1) + 2;
  return buffer.length >= length ? length : null;
}

/** Trame Modbus RTU contenue dans une réponse V5, après contrôle de la trame. */
export function v5ResponseRtu(frame: Buffer, sequence: number): Buffer | null {
  if (frame.readUInt8(0) !== V5_START || frame.readUInt8(frame.length - 1) !== V5_END) {
    throw new Error('Réponse inattendue de la clé Solarman.');
  }
  if (v5Checksum(frame, frame.length - 2) !== frame.readUInt8(frame.length - 2)) {
    throw new Error('Réponse de la clé Solarman corrompue (somme de contrôle).');
  }
  if (frame.readUInt16LE(3) !== V5_RESPONSE) {
    return null; // battement de cœur ou autre trame spontanée de la clé : ignorée
  }
  if ((frame.readUInt16LE(5) & 0xff) !== (sequence & 0xff)) {
    return null;
  }
  // Données : type (1), état (1), trois horodatages (12), puis la trame Modbus RTU.
  const rtu = frame.subarray(V5_HEADER + 14, frame.length - 2);
  if (rtu.length < 5) {
    throw new Error(
      "La clé Solarman n'a pas transmis de réponse de l'onduleur : vérifiez le numéro de série de la clé et l'identifiant Modbus.",
    );
  }
  return rtu;
}

export interface StreamOptions {
  readonly host: string;
  readonly port: number;
  readonly unitId: number;
  readonly timeoutMs?: number;
  readonly lookup?: net.LookupFunction;
}

/** Lecture des registres par une clé Wi-Fi Solarman (TCP, port 8899). */
export class SolarmanClient implements RegisterReader {
  private socket: net.Socket | null = null;
  private buffer = Buffer.alloc(0);
  private sequence = Math.floor(Math.random() * 0xff);
  private waiting: { sequence: number; resolve: (rtu: Buffer) => void; reject: (e: Error) => void } | null =
    null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly options: StreamOptions,
    private readonly loggerSerial: number,
    private readonly networkError: (error: unknown) => Error = (e) =>
      e instanceof Error ? e : new Error(String(e)),
  ) {}

  read(fn: ReadFunction, address: number, count: number): Promise<number[]> {
    const run = this.queue.then(() => this.readNow(fn, address, count));
    this.queue = run.catch(() => undefined);
    return run;
  }

  async close(): Promise<void> {
    this.drop();
  }

  private async readNow(fn: ReadFunction, address: number, count: number): Promise<number[]> {
    const socket = await this.connect();
    this.sequence = (this.sequence + 1) & 0xffff;
    const sequence = this.sequence;
    const timeout = this.options.timeoutMs ?? 8000;
    try {
      const rtu = await new Promise<Buffer>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.waiting = null;
          reject(this.networkError(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
        }, timeout);
        this.waiting = {
          sequence,
          resolve: (r) => {
            clearTimeout(timer);
            resolve(r);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        };
        socket.write(v5Request(this.loggerSerial, sequence, rtuReadRequest(this.options.unitId, fn, address, count)));
      });
      return parseRtuReadResponse(rtu, fn, count);
    } catch (error) {
      this.drop();
      throw error;
    }
  }

  private connect(): Promise<net.Socket> {
    if (this.socket !== null) {
      return Promise.resolve(this.socket);
    }
    const timeout = this.options.timeoutMs ?? 8000;
    return new Promise<net.Socket>((resolve, reject) => {
      const socket = net.connect({
        host: this.options.host,
        port: this.options.port,
        lookup: this.options.lookup,
        autoSelectFamily: false,
      });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(this.networkError(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
      }, timeout);
      socket.once('error', (e) => {
        clearTimeout(timer);
        reject(this.networkError(e));
      });
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.removeAllListeners('error');
        socket.on('error', (e) => this.fail(this.networkError(e)));
        socket.on('close', () =>
          this.fail(this.networkError(Object.assign(new Error('closed'), { code: 'ECONNRESET' }))),
        );
        socket.on('data', (chunk: Buffer) => this.onData(chunk));
        this.socket = socket;
        resolve(socket);
      });
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const start = this.buffer.indexOf(V5_START);
      if (start < 0) {
        this.buffer = Buffer.alloc(0);
        return;
      }
      this.buffer = this.buffer.subarray(start);
      const length = v5FrameLength(this.buffer);
      if (length === null) {
        return;
      }
      const frame = Buffer.from(this.buffer.subarray(0, length));
      this.buffer = this.buffer.subarray(length);
      const waiting = this.waiting;
      if (waiting === null) {
        continue;
      }
      try {
        const rtu = v5ResponseRtu(frame, waiting.sequence);
        if (rtu !== null) {
          this.waiting = null;
          waiting.resolve(rtu);
        }
      } catch (error) {
        this.waiting = null;
        waiting.reject(error as Error);
      }
    }
  }

  private fail(error: Error): void {
    const waiting = this.waiting;
    this.waiting = null;
    this.drop();
    waiting?.reject(error);
  }

  private drop(): void {
    const socket = this.socket;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    if (socket !== null) {
      socket.removeAllListeners();
      socket.on('error', () => undefined);
      socket.destroy();
    }
  }
}

// --- GoodWe (Modbus RTU sur UDP) ---

/** Trame RTU d'une réponse GoodWe : la clé la précède de 0xAA 0x55. */
export function goodweResponseRtu(packet: Buffer): Buffer {
  if (packet.length < 7 || packet[0] !== 0xaa || packet[1] !== 0x55) {
    throw new Error('Réponse inattendue de l’onduleur GoodWe.');
  }
  return packet.subarray(2);
}

const GOODWE_ATTEMPTS = 3;

/** Lecture des registres d'un onduleur GoodWe par sa clé Wi-Fi ou LAN (UDP, port 8899). */
export class GoodWeUdpClient implements RegisterReader {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly options: StreamOptions,
    private readonly networkError: (error: unknown) => Error = (e) =>
      e instanceof Error ? e : new Error(String(e)),
  ) {}

  read(fn: ReadFunction, address: number, count: number): Promise<number[]> {
    const run = this.queue.then(() => this.readNow(fn, address, count));
    this.queue = run.catch(() => undefined);
    return run;
  }

  async close(): Promise<void> {
    // sans connexion
  }

  private async readNow(fn: ReadFunction, address: number, count: number): Promise<number[]> {
    let address4: string;
    try {
      address4 = net.isIP(this.options.host)
        ? this.options.host
        : (await dns.lookup(this.options.host, { family: 4 })).address;
    } catch (error) {
      throw this.networkError(error);
    }
    const request = rtuReadRequest(this.options.unitId, fn, address, count);
    let lastError: unknown = null;
    for (let attempt = 0; attempt < GOODWE_ATTEMPTS; attempt++) {
      try {
        const packet = await this.exchange(address4, request);
        return parseRtuReadResponse(goodweResponseRtu(packet), fn, count);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error && !('code' in lastError) ? lastError : this.networkError(lastError);
  }

  private exchange(host: string, request: Buffer): Promise<Buffer> {
    const timeout = this.options.timeoutMs ?? 2000;
    return new Promise<Buffer>((resolve, reject) => {
      const socket = dgram.createSocket('udp4');
      const done = (error: unknown, packet?: Buffer): void => {
        clearTimeout(timer);
        socket.close();
        if (packet) {
          resolve(packet);
        } else {
          reject(error);
        }
      };
      const timer = setTimeout(
        () => done(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })),
        timeout,
      );
      socket.on('error', (e) => done(e));
      socket.on('message', (packet) => done(null, packet));
      socket.send(request, this.options.port, host, (e) => {
        if (e) {
          done(e);
        }
      });
    });
  }
}
