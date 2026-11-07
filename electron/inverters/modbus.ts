import net from 'node:net';

/**
 * Modbus : trames TCP (MBAP) et RTU (CRC-16), décodage des registres. Seule la lecture est implémentée
 * (fonctions 3 « holding registers » et 4 « input registers ») : ConsoElec n'écrit jamais dans un onduleur.
 */

export type ReadFunction = 3 | 4;

/** Lecture de registres, quel que soit le transport (Modbus TCP, clé Solarman, UDP GoodWe). */
export interface RegisterReader {
  /** Lit `count` registres de 16 bits à partir de `address` (adresse Modbus, comptée depuis 0). */
  read(fn: ReadFunction, address: number, count: number): Promise<number[]>;
  /** Ferme la connexion éventuelle. */
  close(): Promise<void>;
}

/** Réponse d'exception d'un appareil Modbus (fonction + 0x80). */
export class ModbusException extends Error {
  constructor(readonly code: number) {
    super(modbusExceptionMessage(code));
  }
}

export function modbusExceptionMessage(code: number): string {
  switch (code) {
    case 1:
      return "L'onduleur refuse cette fonction Modbus (exception 1).";
    case 2:
      return "Registres absents de cet onduleur (exception Modbus 2) : vérifiez la marque et le modèle choisis.";
    case 3:
      return 'Requête Modbus refusée (exception 3).';
    case 4:
      return "L'onduleur n'a pas pu répondre (exception Modbus 4).";
    case 6:
      return "L'onduleur est occupé (exception Modbus 6) : nouvel essai à la prochaine lecture.";
    case 10:
    case 11:
      return `La passerelle Modbus ne joint pas l'onduleur (exception ${code}) : vérifiez l'identifiant Modbus.`;
    default:
      return `Exception Modbus ${code}.`;
  }
}

/** CRC-16 Modbus (polynôme 0xA001, valeur initiale 0xFFFF). */
export function crc16(data: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }
  return crc;
}

/** Requête RTU de lecture : adresse, fonction, registre de départ, nombre, CRC (octet faible d'abord). */
export function rtuReadRequest(unit: number, fn: ReadFunction, address: number, count: number): Buffer {
  const frame = Buffer.alloc(8);
  frame.writeUInt8(unit & 0xff, 0);
  frame.writeUInt8(fn, 1);
  frame.writeUInt16BE(address, 2);
  frame.writeUInt16BE(count, 4);
  frame.writeUInt16LE(crc16(frame.subarray(0, 6)), 6);
  return frame;
}

/** Valeurs d'une réponse RTU de lecture (adresse, fonction, nombre d'octets, données, CRC). */
export function parseRtuReadResponse(frame: Buffer, fn: ReadFunction, count: number): number[] {
  if (frame.length < 5) {
    throw new Error('Réponse Modbus trop courte.');
  }
  if (crc16(frame.subarray(0, frame.length - 2)) !== frame.readUInt16LE(frame.length - 2)) {
    throw new Error('Réponse Modbus corrompue (CRC).');
  }
  const code = frame.readUInt8(1);
  if (code === (fn | 0x80)) {
    throw new ModbusException(frame.readUInt8(2));
  }
  if (code !== fn) {
    throw new Error(`Réponse Modbus inattendue (fonction ${code}).`);
  }
  return registersFrom(frame.subarray(3, 3 + frame.readUInt8(2)), count);
}

function registersFrom(data: Buffer, count: number): number[] {
  if (data.length !== count * 2) {
    throw new Error(`Réponse Modbus incomplète (${data.length / 2} registres sur ${count}).`);
  }
  const values: number[] = [];
  for (let i = 0; i < count; i++) {
    values.push(data.readUInt16BE(i * 2));
  }
  return values;
}

/** Requête Modbus TCP de lecture (en-tête MBAP + PDU). */
export function tcpReadRequest(
  transaction: number,
  unit: number,
  fn: ReadFunction,
  address: number,
  count: number,
): Buffer {
  const frame = Buffer.alloc(12);
  frame.writeUInt16BE(transaction & 0xffff, 0);
  frame.writeUInt16BE(0, 2);
  frame.writeUInt16BE(6, 4);
  frame.writeUInt8(unit & 0xff, 6);
  frame.writeUInt8(fn, 7);
  frame.writeUInt16BE(address, 8);
  frame.writeUInt16BE(count, 10);
  return frame;
}

/** Longueur d'une trame Modbus TCP complète au début de `buffer`, ou `null` si elle n'est pas encore arrivée. */
export function tcpFrameLength(buffer: Buffer): number | null {
  if (buffer.length < 7) {
    return null;
  }
  const length = 6 + buffer.readUInt16BE(4);
  return buffer.length >= length ? length : null;
}

/** Valeurs d'une réponse Modbus TCP de lecture. */
export function parseTcpReadResponse(
  frame: Buffer,
  transaction: number,
  fn: ReadFunction,
  count: number,
): number[] {
  if (frame.readUInt16BE(0) !== (transaction & 0xffff)) {
    throw new Error('Réponse Modbus hors séquence.');
  }
  const code = frame.readUInt8(7);
  if (code === (fn | 0x80)) {
    throw new ModbusException(frame.readUInt8(8));
  }
  if (code !== fn) {
    throw new Error(`Réponse Modbus inattendue (fonction ${code}).`);
  }
  return registersFrom(frame.subarray(9, 9 + frame.readUInt8(8)), count);
}

// --- Décodage des registres ---

export type RegisterType = 'u16' | 'i16' | 'u32' | 'i32' | 'f32';
/** Ordre des mots d'une valeur de 32 bits : registre de poids fort d'abord (le plus courant) ou l'inverse. */
export type WordOrder = 'high-first' | 'low-first';

export const registerCount = (type: RegisterType): number => (type === 'u16' || type === 'i16' ? 1 : 2);

/** Valeur brute d'un registre (ou d'une paire), sans échelle. */
export function decodeRegisters(
  words: readonly number[],
  offset: number,
  type: RegisterType,
  order: WordOrder = 'high-first',
): number {
  const w0 = words[offset];
  const w1 = words[offset + 1];
  if (w0 === undefined || (registerCount(type) === 2 && w1 === undefined)) {
    throw new Error('Registre hors de la plage lue.');
  }
  if (type === 'u16') {
    return w0;
  }
  if (type === 'i16') {
    return w0 >= 0x8000 ? w0 - 0x10000 : w0;
  }
  const [high, low] = order === 'high-first' ? [w0, w1!] : [w1!, w0];
  const buf = Buffer.alloc(4);
  buf.writeUInt16BE(high, 0);
  buf.writeUInt16BE(low, 2);
  if (type === 'u32') {
    return buf.readUInt32BE(0);
  }
  if (type === 'i32') {
    return buf.readInt32BE(0);
  }
  return buf.readFloatBE(0);
}

// --- Client Modbus TCP ---

export interface ModbusTcpOptions {
  readonly host: string;
  readonly port: number;
  readonly unitId: number;
  readonly timeoutMs?: number;
  /** Pause après l'ouverture de la connexion (les SDongle Huawei ignorent une requête trop rapide). */
  readonly waitAfterConnectMs?: number;
  /** Résolution du nom (IPv4 d'abord). */
  readonly lookup?: net.LookupFunction;
}

/**
 * Client Modbus TCP : une connexion ouverte à la première lecture, gardée tant que l'onduleur répond, refermée à la
 * moindre erreur (la suivante la rouvre). Les lectures passent l'une après l'autre.
 */
export class ModbusTcpClient implements RegisterReader {
  private socket: net.Socket | null = null;
  private connecting: Promise<net.Socket> | null = null;
  private buffer = Buffer.alloc(0);
  private transaction = 0;
  private pending: { resolve: (frame: Buffer) => void; reject: (error: Error) => void } | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly options: ModbusTcpOptions,
    /** Fabrique les erreurs réseau (code Node → message lisible). */
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
    this.transaction = (this.transaction + 1) & 0xffff;
    const transaction = this.transaction;
    const timeout = this.options.timeoutMs ?? 5000;
    try {
      const frame = await new Promise<Buffer>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending = null;
          reject(this.networkError(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
        }, timeout);
        this.pending = {
          resolve: (f) => {
            clearTimeout(timer);
            resolve(f);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        };
        socket.write(tcpReadRequest(transaction, this.options.unitId, fn, address, count));
      });
      return parseTcpReadResponse(frame, transaction, fn, count);
    } catch (error) {
      // Après une exception Modbus, la connexion reste saine ; sinon on repart d'une connexion neuve.
      if (!(error instanceof ModbusException)) {
        this.drop();
      }
      throw error;
    }
  }

  private connect(): Promise<net.Socket> {
    if (this.socket !== null) {
      return Promise.resolve(this.socket);
    }
    if (this.connecting !== null) {
      return this.connecting;
    }
    const { host, port, lookup } = this.options;
    const timeout = this.options.timeoutMs ?? 5000;
    this.connecting = new Promise<net.Socket>((resolve, reject) => {
      const socket = net.connect({ host, port, lookup, autoSelectFamily: false });
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
        socket.on('close', () => this.fail(this.networkError(Object.assign(new Error('closed'), { code: 'ECONNRESET' }))));
        socket.on('data', (chunk: Buffer) => this.onData(chunk));
        const wait = this.options.waitAfterConnectMs ?? 0;
        setTimeout(() => {
          this.socket = socket;
          resolve(socket);
        }, wait);
      });
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const length = tcpFrameLength(this.buffer);
      if (length === null) {
        return;
      }
      const frame = this.buffer.subarray(0, length);
      this.buffer = this.buffer.subarray(length);
      const pending = this.pending;
      this.pending = null;
      pending?.resolve(Buffer.from(frame));
    }
  }

  private fail(error: Error): void {
    const pending = this.pending;
    this.pending = null;
    this.drop();
    pending?.reject(error);
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
