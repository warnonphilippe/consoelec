import type { InverterBrand } from '../../electron/shared/inverter-brands';
import { bankProvider, type BankKind } from './register-banks';
import {
  startEnphase,
  startFronius,
  startGoodWe,
  startModbusTcp,
  startSma,
  startSolarman,
  type Running,
} from './servers';
import { SolarModel } from './solar-model';
import { selfSignedCert } from './tls';

/**
 * Émulateurs prêts à l'emploi, un par variante d'onduleur, avec les réglages à saisir dans ConsoElec pour les lire.
 */

export type EmulatorId =
  | 'sma'
  | 'sma-ancien'
  | 'fronius'
  | 'fronius-gen24'
  | 'solaredge'
  | 'kostal'
  | 'sunspec-float'
  | 'huawei'
  | 'sungrow-sg'
  | 'sungrow-sh'
  | 'solis'
  | 'solis-modbus'
  | 'goodwe-et'
  | 'goodwe-dt'
  | 'deye'
  | 'sofar'
  | 'enphase';

export interface EmulatorSettings {
  readonly brand: InverterBrand;
  readonly host: string;
  readonly port: number;
  readonly unitId: number | null;
  readonly loggerSerial: string | null;
  /** Secret à enregistrer (clé SMA, mot de passe, jeton Enphase). */
  readonly secret: string | null;
  /** Empreinte du certificat présenté (HTTPS). */
  readonly fingerprint: string | null;
}

export interface StartedEmulator {
  readonly id: EmulatorId;
  readonly label: string;
  readonly settings: EmulatorSettings;
  readonly model: SolarModel;
  close(): Promise<void>;
}

export const SMA_EMULATOR_KEY = 'EMULATEURSMA2026';
export const SMA_EMULATOR_PASSWORD = 'motdepasse0000';
export const ENPHASE_EMULATOR_TOKEN =
  'eyJraWQiOiJlbXVsYXRldXIiLCJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJFTVVMQVRFVVIiLCJpc3MiOiJFbnRyZXoifQ.c2lnbmF0dXJlLWVtdWxhdGV1cg';
export const SOLARMAN_EMULATOR_SERIAL = '2712345678';

interface Variant {
  readonly label: string;
  readonly brand: InverterBrand;
  readonly start: (
    model: SolarModel,
    port: number,
    host: string,
  ) => Promise<Omit<EmulatorSettings, 'brand' | 'host'> & { running: Running }>;
}

const modbus =
  (kind: BankKind, unitId: number, delayMs = 0): Variant['start'] =>
  async (model, port, host) => {
    const running = await startModbusTcp(
      { unitId, provider: bankProvider(kind, model), delayMs },
      port,
      host,
    );
    return {
      running,
      port: running.port,
      unitId,
      loggerSerial: null,
      secret: null,
      fingerprint: null,
    };
  };

const solarman =
  (kind: BankKind): Variant['start'] =>
  async (model, port, host) => {
    const running = await startSolarman(
      {
        loggerSerial: Number(SOLARMAN_EMULATOR_SERIAL),
        unitId: 1,
        provider: bankProvider(kind, model),
      },
      port,
      host,
    );
    return {
      running,
      port: running.port,
      unitId: 1,
      loggerSerial: SOLARMAN_EMULATOR_SERIAL,
      secret: null,
      fingerprint: null,
    };
  };

const goodwe =
  (kind: BankKind, unitId: number): Variant['start'] =>
  async (model, port, host) => {
    const running = await startGoodWe({ unitId, provider: bankProvider(kind, model) }, port, host);
    return {
      running,
      port: running.port,
      unitId,
      loggerSerial: null,
      secret: null,
      fingerprint: null,
    };
  };

const sma =
  (auth: 'srp' | 'password'): Variant['start'] =>
  async (model, port, host) => {
    const tls = selfSignedCert('SMA3999999999');
    const secret = auth === 'srp' ? SMA_EMULATOR_KEY : SMA_EMULATOR_PASSWORD;
    const running = await startSma(model, tls, { secret, auth }, port, host);
    return {
      running,
      port: running.port,
      unitId: null,
      loggerSerial: null,
      secret,
      fingerprint: tls.fingerprint,
    };
  };

export const EMULATORS: Record<EmulatorId, Variant> = {
  sma: { label: 'SMA WebConnect (connexion SRP)', brand: 'sma', start: sma('srp') },
  'sma-ancien': {
    label: 'SMA WebConnect ancien (mot de passe)',
    brand: 'sma',
    start: sma('password'),
  },
  fronius: {
    label: 'Fronius Symo (Datamanager)',
    brand: 'fronius',
    start: async (model, port, host) => {
      const running = await startFronius(model, {}, port, host);
      return {
        running,
        port: running.port,
        unitId: null,
        loggerSerial: null,
        secret: null,
        fingerprint: null,
      };
    },
  },
  'fronius-gen24': {
    label: 'Fronius GEN24 (sans production du jour dans le flux)',
    brand: 'fronius',
    start: async (model, port, host) => {
      const running = await startFronius(model, { gen24: true }, port, host);
      return {
        running,
        port: running.port,
        unitId: null,
        loggerSerial: null,
        secret: null,
        fingerprint: null,
      };
    },
  },
  solaredge: {
    label: 'SolarEdge (SunSpec, entiers)',
    brand: 'solaredge',
    start: modbus('sunspec-int', 1),
  },
  kostal: {
    label: 'Kostal Plenticore (SunSpec, identifiant 71)',
    brand: 'kostal',
    start: modbus('sunspec-int', 71),
  },
  'sunspec-float': {
    label: 'SunSpec flottant (modèle 113, type Fronius)',
    brand: 'sunspec',
    start: modbus('sunspec-float', 1),
  },
  huawei: { label: 'Huawei SUN2000 (SDongle)', brand: 'huawei', start: modbus('huawei', 1, 20) },
  'sungrow-sg': {
    label: 'Sungrow SG (WiNet-S)',
    brand: 'sungrow-sg',
    start: modbus('sungrow-sg', 1),
  },
  'sungrow-sh': {
    label: 'Sungrow SH hybride (WiNet-S)',
    brand: 'sungrow-sh',
    start: modbus('sungrow-sh', 1),
  },
  solis: { label: 'Solis par clé Solarman', brand: 'solis', start: solarman('solis') },
  'solis-modbus': { label: 'Solis par Modbus TCP', brand: 'solis', start: modbus('solis', 1) },
  'goodwe-et': {
    label: 'GoodWe ET hybride (UDP)',
    brand: 'goodwe-et',
    start: goodwe('goodwe-et', 0xf7),
  },
  'goodwe-dt': {
    label: 'GoodWe DT réseau (UDP)',
    brand: 'goodwe-dt',
    start: goodwe('goodwe-dt', 0x7f),
  },
  deye: { label: 'Deye SUN-G par clé Solarman', brand: 'deye', start: solarman('deye') },
  sofar: { label: 'Sofar KTL-X par clé LSW-3', brand: 'sofar', start: solarman('sofar') },
  enphase: {
    label: 'Enphase IQ Gateway',
    brand: 'enphase',
    start: async (model, port, host) => {
      const tls = selfSignedCert('envoy');
      const running = await startEnphase(model, tls, ENPHASE_EMULATOR_TOKEN, port, host);
      return {
        running,
        port: running.port,
        unitId: null,
        loggerSerial: null,
        secret: ENPHASE_EMULATOR_TOKEN,
        fingerprint: tls.fingerprint,
      };
    },
  },
};

export const EMULATOR_IDS = Object.keys(EMULATORS) as EmulatorId[];

export async function startEmulator(
  id: EmulatorId,
  options: { port?: number; host?: string; model?: SolarModel } = {},
): Promise<StartedEmulator> {
  const variant = EMULATORS[id];
  const model = options.model ?? new SolarModel();
  const host = options.host ?? '127.0.0.1';
  const { running, ...rest } = await variant.start(model, options.port ?? 0, host);
  return {
    id,
    label: variant.label,
    model,
    settings: { brand: variant.brand, host: host === '0.0.0.0' ? '127.0.0.1' : host, ...rest },
    close: () => running.close(),
  };
}
