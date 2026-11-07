import {
  effectivePort,
  inverterBrand,
  registerTransport,
  type InverterBrandInfo,
} from '../shared/inverter-brands';
import type {
  InverterConfig,
  InverterDayCurve,
  InverterHistory,
  InverterReading,
} from '../shared/ipc-contract';
import { isNameNotFound, lookupIpv4First, NetworkError, networkErrorMessage } from '../inverter';
import type { Measurements } from '../sma-core';
import { EnphaseReader } from './enphase';
import { FroniusReader } from './fronius';
import { ModbusTcpClient, type RegisterReader } from './modbus';
import { readRegisterMap, REGISTER_MAPS } from './register-maps';
import { SunSpecReader } from './sunspec';
import { GoodWeUdpClient, parseLoggerSerial, SolarmanClient } from './transports';

/** Codes d'erreur Node d'une erreur réseau. */
const codesOf = (error: unknown): string[] =>
  (error instanceof AggregateError ? error.errors : [error])
    .map((e) => (e as { code?: string } | null)?.code)
    .filter((c): c is string => typeof c === 'string');

/** Erreur réseau lisible, adaptée au protocole (port fermé = protocole local pas activé). */
export function localNetworkError(error: unknown, host: string, port: number, brand: InverterBrandInfo): NetworkError {
  if (error instanceof NetworkError) {
    return error;
  }
  const codes = codesOf(error);
  if (codes.includes('ECONNREFUSED')) {
    const what =
      brand.protocol === 'sunspec' || brand.protocol === 'registers'
        ? brand.transport === 'goodwe-udp'
          ? 'la lecture locale'
          : 'Modbus TCP'
        : brand.protocol === 'fronius'
          ? 'la Solar API'
          : "l'accès local";
    return new NetworkError(
      `L'onduleur refuse la connexion sur le port ${port} (${host}) : ${what} est-il activé, et le port est-il le bon ?`,
    );
  }
  if (codes.length > 0 && codes.every((c) => c === 'ETIMEDOUT')) {
    return new NetworkError(`L'onduleur ne répond pas (${host}, port ${port}).`);
  }
  return new NetworkError(networkErrorMessage(error, host), isNameNotFound(error));
}

interface Source {
  read(): Promise<Measurements>;
  close(): Promise<void>;
  /** Empreinte du certificat vu (HTTPS). */
  fingerprint(): string | null;
}

/**
 * Lecture locale des onduleurs autres que SMA WebConnect : Fronius, SunSpec, tables de registres propres aux marques,
 * Enphase. Mêmes garanties que le client SMA : une lecture à la fois, jamais d'exception (l'erreur est dans le
 * résultat), signal `troubled` en cas de souci réseau. Ces onduleurs ne donnent pas de journaux : l'historique se
 * construit avec les lectures de ConsoElec.
 */
export class LocalInverterClient {
  private config: InverterConfig = { enabled: false, host: '', certFingerprint: null };
  private source: Source | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private trouble = false;
  private seenFingerprint: string | null = null;

  constructor(
    private readonly secret: () => string | null,
    /** Délais réduits pour les tests. */
    private readonly timeoutMs?: number,
  ) {}

  get brand(): InverterBrandInfo {
    return inverterBrand(this.config.brand);
  }

  configure(config: InverterConfig): void {
    const before = this.config;
    this.config = { ...config };
    if (
      config.brand !== before.brand ||
      config.host !== before.host ||
      config.port !== before.port ||
      config.unitId !== before.unitId ||
      config.loggerSerial !== before.loggerSerial ||
      config.certFingerprint !== before.certFingerprint ||
      !config.enabled
    ) {
      void this.dropSource();
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

  get troubled(): boolean {
    return this.trouble;
  }

  read(): Promise<InverterReading> {
    const run = this.queue.then(() => this.readNow());
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Pas de journaux sur ces onduleurs : historique vide, sans erreur. */
  async history(): Promise<InverterHistory> {
    return { days: [], today: [], error: null };
  }

  async dayCurve(date: string): Promise<InverterDayCurve> {
    return {
      date,
      points: [],
      error: "Cet onduleur ne garde pas de courbe des journées passées : seuls les totaux sont disponibles.",
    };
  }

  async close(): Promise<void> {
    await this.dropSource();
  }

  /** Signale une nouvelle tentative de connexion (réglages changés, secret remplacé). */
  async reset(): Promise<void> {
    await this.dropSource();
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
    try {
      this.source ??= this.createSource();
      const m = await this.source.read();
      this.seenFingerprint = this.source.fingerprint();
      this.trouble = false;
      return { at, ...m, error: null, certFingerprint: this.seenFingerprint };
    } catch (error) {
      this.seenFingerprint = this.source?.fingerprint() ?? this.seenFingerprint;
      await this.dropSource();
      this.trouble = error instanceof NetworkError;
      return fail(error instanceof Error ? error.message : String(error));
    }
  }

  private createSource(): Source {
    const brand = this.brand;
    const host = this.config.host;
    const loggerSerial = this.config.loggerSerial ?? null;
    const port = effectivePort(brand, this.config.port ?? null, loggerSerial);
    const unitId = this.config.unitId ?? brand.defaultUnitId ?? 1;
    const networkError = (e: unknown): Error => localNetworkError(e, host, port, brand);
    const timeoutMs = this.timeoutMs;
    const noFingerprint = (): null => null;
    switch (brand.protocol) {
      case 'fronius': {
        const reader = new FroniusReader({ host, port, timeoutMs, lookup: lookupIpv4First }, networkError);
        return { read: () => reader.read(), close: async () => undefined, fingerprint: noFingerprint };
      }
      case 'enphase': {
        const token = this.secret();
        if (token === null) {
          throw new Error('Jeton Enphase absent : ajoutez-le dans les réglages.');
        }
        const reader = new EnphaseReader(
          { host, port, token, pinned: this.config.certFingerprint, timeoutMs, lookup: lookupIpv4First },
          networkError,
        );
        return { read: () => reader.read(), close: async () => undefined, fingerprint: () => reader.seenFingerprint };
      }
      case 'sunspec': {
        const modbus = new ModbusTcpClient({ host, port, unitId, timeoutMs, lookup: lookupIpv4First }, networkError);
        const reader = new SunSpecReader(modbus);
        return { read: () => reader.read(), close: () => modbus.close(), fingerprint: noFingerprint };
      }
      case 'registers': {
        const map = REGISTER_MAPS[brand.id];
        if (!map) {
          throw new Error(`Table de registres absente pour ${brand.label}.`);
        }
        let registers: RegisterReader;
        const transport = registerTransport(brand, loggerSerial);
        if (transport === 'solarman') {
          registers = new SolarmanClient(
            { host, port, unitId, timeoutMs, lookup: lookupIpv4First },
            parseLoggerSerial(loggerSerial ?? ''),
            networkError,
          );
        } else if (transport === 'goodwe-udp') {
          registers = new GoodWeUdpClient({ host, port, unitId, timeoutMs }, networkError);
        } else {
          registers = new ModbusTcpClient(
            {
              host,
              port,
              unitId,
              timeoutMs,
              lookup: lookupIpv4First,
              // Les SDongle Huawei ignorent une requête envoyée juste après l'ouverture de la connexion.
              waitAfterConnectMs: brand.id === 'huawei' ? (timeoutMs === undefined ? 1000 : 0) : 0,
            },
            networkError,
          );
        }
        return { read: () => readRegisterMap(registers, map), close: () => registers.close(), fingerprint: noFingerprint };
      }
      case 'sma':
        throw new Error('Les onduleurs SMA WebConnect sont lus par le client SMA.');
    }
  }

  private async dropSource(): Promise<void> {
    const source = this.source;
    this.source = null;
    await source?.close().catch(() => undefined);
  }
}
