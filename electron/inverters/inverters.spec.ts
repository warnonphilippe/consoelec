import {
  EMULATOR_IDS,
  ENPHASE_EMULATOR_TOKEN,
  SMA_EMULATOR_KEY,
  SOLARMAN_EMULATOR_SERIAL,
  startEmulator,
  type EmulatorId,
  type StartedEmulator,
} from '../../scripts/emulators/catalog';
import { startModbusTcp, startWifikit } from '../../scripts/emulators/servers';
import { SolarModel } from '../../scripts/emulators/solar-model';
import { bankProvider } from '../../scripts/emulators/register-banks';
import type { InverterConfig } from '../shared/ipc-contract';
import { InverterHub } from './hub';
import { LocalInverterClient } from './local-client';
import { crc16, decodeRegisters, ModbusTcpClient, rtuReadRequest, parseRtuReadResponse } from './modbus';
import { REGISTER_MAPS } from './register-maps';
import { broadcastWifikit, localNetworks, parseWifikitReply, scanInverters } from './scan';
import { parseSunSpecInverter } from './sunspec';
import { parseLoggerSerial, v5FrameLength, v5Request, v5ResponseRtu } from './transports';
import { parsePowerFlow } from './fronius';
import { parseEnphaseProduction } from './enphase';

/** Midi d'un jour d'été : production en cours, valeurs connues. */
const NOON = new Date(2026, 5, 21, 13, 7, 0).getTime();
const model = () => new SolarModel({ now: () => NOON });

/** Résolution des registres de chaque variante : écart toléré entre la lecture et l'émulateur. */
const RESOLUTION: Record<EmulatorId, { power: number; day: number | null; total: number }> = {
  sma: { power: 0, day: 0, total: 0 },
  'sma-ancien': { power: 0, day: 0, total: 0 },
  fronius: { power: 0, day: 0, total: 0 },
  'fronius-gen24': { power: 0, day: 0, total: 0 },
  solaredge: { power: 1, day: null, total: 1 },
  kostal: { power: 1, day: null, total: 1 },
  'sunspec-float': { power: 1, day: null, total: 2 },
  huawei: { power: 1, day: 10, total: 10 },
  'sungrow-sg': { power: 1, day: 100, total: 1000 },
  'sungrow-sh': { power: 1, day: 100, total: 100 },
  solis: { power: 1, day: 100, total: 1000 },
  'solis-modbus': { power: 1, day: 100, total: 1000 },
  'goodwe-et': { power: 1, day: 100, total: 100 },
  'goodwe-dt': { power: 1, day: 100, total: 100 },
  deye: { power: 1, day: 100, total: 100 },
  sofar: { power: 10, day: 10, total: 1000 },
  enphase: { power: 0, day: 0, total: 0 },
};

function configOf(e: StartedEmulator): InverterConfig {
  return {
    enabled: true,
    brand: e.settings.brand,
    host: e.settings.host,
    port: e.settings.port,
    unitId: e.settings.unitId,
    loggerSerial: e.settings.loggerSerial,
    certFingerprint: null,
  };
}

describe('lecture de chaque marque contre son émulateur', () => {
  it.each(EMULATOR_IDS)('%s', async (id) => {
    const emulator = await startEmulator(id, { model: model() });
    const hub = new InverterHub(() => emulator.settings.secret);
    try {
      hub.configure(configOf(emulator));
      const reading = await hub.read();
      expect(reading.error).toBeNull();
      const expected = emulator.model.state();
      const tolerance = RESOLUTION[id];
      expect(expected.powerW).toBeGreaterThan(1000);
      expect(Math.abs(reading.powerW! - expected.powerW)).toBeLessThanOrEqual(tolerance.power);
      expect(Math.abs(reading.totalWh! - expected.totalWh)).toBeLessThanOrEqual(tolerance.total);
      if (tolerance.day === null) {
        expect(reading.dayWh).toBeNull();
      } else {
        expect(Math.abs(reading.dayWh! - expected.dayWh)).toBeLessThanOrEqual(tolerance.day);
      }
      // Seconde lecture sur la même connexion (Modbus TCP, clé Solarman) ou la même session (SMA).
      expect((await hub.read()).error).toBeNull();
      if (emulator.settings.fingerprint !== null) {
        expect(reading.certFingerprint).toBe(emulator.settings.fingerprint);
      }
    } finally {
      await hub.close();
      await emulator.close();
    }
  });
});

describe('SMA par le routeur de marques', () => {
  it('lit les journaux SRP (historique et courbe du jour)', async () => {
    const emulator = await startEmulator('sma', { model: model() });
    const hub = new InverterHub(() => SMA_EMULATOR_KEY);
    try {
      hub.configure(configOf(emulator));
      const history = await hub.history(new Date(NOON));
      expect(history.error).toBeNull();
      expect(history.days.length).toBeGreaterThan(20);
      expect(history.today.length).toBeGreaterThan(50);
    } finally {
      await hub.close();
      await emulator.close();
    }
  });

  it('refuse un mauvais mot de passe sur un ancien SMA', async () => {
    const emulator = await startEmulator('sma-ancien', { model: model() });
    const hub = new InverterHub(() => 'mauvais');
    try {
      hub.configure(configOf(emulator));
      expect((await hub.read()).error).toContain('Mot de passe refusé');
    } finally {
      await hub.close();
      await emulator.close();
    }
  });

  it('passe d’une marque à l’autre sans garder l’ancienne connexion', async () => {
    const sma = await startEmulator('sma', { model: model() });
    const fronius = await startEmulator('fronius', { model: model() });
    const hub = new InverterHub(() => SMA_EMULATOR_KEY);
    try {
      hub.configure(configOf(sma));
      expect((await hub.read()).error).toBeNull();
      hub.configure(configOf(fronius));
      const r = await hub.read();
      expect(r.error).toBeNull();
      expect(hub.brand.id).toBe('fronius');
      expect((await hub.history()).days).toEqual([]);
      expect((await hub.dayCurve('2026-06-20')).error).toContain('totaux');
    } finally {
      await hub.close();
      await sma.close();
      await fronius.close();
    }
  });
});

describe('erreurs compréhensibles', () => {
  const read = async (config: InverterConfig, secret: string | null = null) => {
    const client = new LocalInverterClient(() => secret, 1500);
    client.configure(config);
    try {
      return { reading: await client.read(), troubled: client.troubled };
    } finally {
      await client.close();
    }
  };

  it('mauvais identifiant Modbus derrière une passerelle', async () => {
    const e = await startEmulator('huawei', { model: model() });
    try {
      const { reading } = await read({ ...configOf(e), unitId: 3 });
      expect(reading.error).toContain('identifiant Modbus');
    } finally {
      await e.close();
    }
  });

  it('mauvaise marque choisie : registres absents', async () => {
    const e = await startEmulator('huawei', { model: model() });
    try {
      const { reading } = await read({ ...configOf(e), brand: 'solis', loggerSerial: null });
      expect(reading.error).toContain('Registres absents');
    } finally {
      await e.close();
    }
  });

  it('Modbus TCP non activé : port fermé', async () => {
    const e = await startEmulator('solaredge', { model: model() });
    const port = e.settings.port;
    await e.close();
    const { reading, troubled } = await read({ ...configOf(e), port });
    expect(reading.error).toContain('refuse la connexion');
    expect(reading.error).toContain('Modbus TCP');
    expect(troubled).toBe(true);
  });

  it('SunSpec absent', async () => {
    const e = await startEmulator('huawei', { model: model() });
    try {
      const { reading } = await read({ ...configOf(e), brand: 'sunspec' });
      expect(reading.error).toContain('SunSpec');
    } finally {
      await e.close();
    }
  });

  it('mauvais numéro de série de clé Solarman', async () => {
    const e = await startEmulator('deye', { model: model() });
    try {
      const { reading } = await read({ ...configOf(e), loggerSerial: '1111111111' });
      expect(reading.error).toContain('numéro de série');
    } finally {
      await e.close();
    }
  });

  it('jeton Enphase refusé, puis certificat épinglé changé', async () => {
    const e = await startEmulator('enphase', { model: model() });
    try {
      expect((await read(configOf(e), 'jeton-perime')).reading.error).toContain('Jeton refusé');
      const pinned = await read({ ...configOf(e), certFingerprint: 'AA:'.repeat(31) + 'AA' }, ENPHASE_EMULATOR_TOKEN);
      expect(pinned.reading.error).toContain('certificat');
      const ok = await read({ ...configOf(e), certFingerprint: e.settings.fingerprint }, ENPHASE_EMULATOR_TOKEN);
      expect(ok.reading.error).toBeNull();
    } finally {
      await e.close();
    }
  });

  it('GoodWe muet : onduleur qui ne répond pas', async () => {
    const e = await startEmulator('goodwe-dt', { model: model() });
    try {
      // Mauvaise adresse d'onduleur : la clé ne répond pas.
      const { reading, troubled } = await read({ ...configOf(e), unitId: 0x11 });
      expect(reading.error).toContain('ne répond pas');
      expect(troubled).toBe(true);
    } finally {
      await e.close();
    }
  });
});

describe('Modbus', () => {
  it('CRC-16 du vecteur classique', () => {
    expect(crc16(Buffer.from([0x01, 0x03, 0x00, 0x00, 0x00, 0x01]))).toBe(0x0a84);
    expect(rtuReadRequest(1, 3, 0, 1).toString('hex')).toBe('010300000001840a');
  });

  it('décode les entiers, l’ordre des mots et les flottants', () => {
    expect(decodeRegisters([0xffff], 0, 'i16')).toBe(-1);
    expect(decodeRegisters([0x0001, 0x0002], 0, 'u32')).toBe(0x10002);
    expect(decodeRegisters([0x0002, 0x0001], 0, 'u32', 'low-first')).toBe(0x10002);
    expect(decodeRegisters([0xffff, 0xfffe], 0, 'i32')).toBe(-2);
    expect(decodeRegisters([0x4248, 0x0000], 0, 'f32')).toBe(50);
  });

  it('rejette une réponse RTU corrompue', () => {
    const reply = Buffer.from('0103020001', 'hex');
    const crc = Buffer.alloc(2);
    crc.writeUInt16LE(crc16(reply));
    expect(parseRtuReadResponse(Buffer.concat([reply, crc]), 3, 1)).toEqual([1]);
    crc[0] = crc[0]! ^ 0xff;
    expect(() => parseRtuReadResponse(Buffer.concat([reply, crc]), 3, 1)).toThrow('CRC');
  });

  it('client TCP : lectures successives et reconnexion après fermeture', async () => {
    const running = await startModbusTcp({ unitId: 1, provider: bankProvider('huawei', model()) });
    const client = new ModbusTcpClient({ host: '127.0.0.1', port: running.port, unitId: 1, timeoutMs: 1000 });
    try {
      const [a, b] = await Promise.all([client.read(3, 32080, 2), client.read(3, 32114, 2)]);
      expect(decodeRegisters(a, 0, 'i32')).toBeGreaterThan(1000);
      expect(b).toHaveLength(2);
      await client.close();
      expect(await client.read(3, 32080, 2)).toHaveLength(2);
    } finally {
      await client.close();
      await running.close();
    }
  });

  it('toutes les plages des tables tiennent dans une requête', () => {
    for (const map of Object.values(REGISTER_MAPS)) {
      for (const block of map!.blocks) {
        expect(block.count).toBeGreaterThan(0);
        expect(block.count).toBeLessThanOrEqual(125);
      }
    }
  });
});

describe('Solarman V5', () => {
  it('trame de requête : en-tête, numéro de série, somme et fin', () => {
    const frame = v5Request(2712345678, 0x42, rtuReadRequest(1, 4, 3004, 11));
    expect(frame[0]).toBe(0xa5);
    expect(frame.readUInt16LE(3)).toBe(0x4510);
    expect(frame.readUInt32LE(7)).toBe(2712345678);
    expect(frame.at(-1)).toBe(0x15);
    expect(v5FrameLength(frame)).toBe(frame.length);
  });

  it('ignore les battements de cœur et les réponses d’une autre séquence', () => {
    const response = Buffer.from(v5Request(1, 7, Buffer.alloc(8)));
    response.writeUInt16LE(0x4710, 3);
    let sum = 0;
    for (let i = 1; i < response.length - 2; i++) sum = (sum + response[i]!) & 0xff;
    response[response.length - 2] = sum;
    expect(v5ResponseRtu(response, 7)).toBeNull();
  });

  it('numéro de série de la clé', () => {
    expect(parseLoggerSerial(SOLARMAN_EMULATOR_SERIAL)).toBe(2712345678);
    expect(() => parseLoggerSerial('abc')).toThrow('invalide');
    expect(() => parseLoggerSerial('99999999999')).toThrow('invalide');
  });
});

describe('réponses HTTP', () => {
  it('Fronius : nuit (P_PV null) et erreur signalée', () => {
    const body = (site: unknown, code = 0) => ({ Head: { Status: { Code: code } }, Body: { Data: { Site: site } } });
    expect(parsePowerFlow(body({ P_PV: null, E_Day: 12000, E_Total: 5e6 }))).toEqual({
      powerW: null,
      dayWh: 12000,
      totalWh: 5e6,
    });
    expect(() => parsePowerFlow(body({}, 8))).toThrow('erreur 8');
  });

  it('Enphase : réponse inattendue', () => {
    expect(() => parseEnphaseProduction({ error: 'x' })).toThrow('inattendue');
    expect(parseEnphaseProduction({ wattsNow: -3, wattHoursToday: 5, wattHoursLifetime: 9 }).powerW).toBe(0);
  });

  it('SunSpec : valeurs absentes la nuit', () => {
    const data = new Array(25).fill(0);
    data[12] = 0x8000;
    data[13] = 0;
    data[24] = 0;
    expect(parseSunSpecInverter(103, data)).toEqual({ powerW: null, dayWh: null, totalWh: null });
  });
});

describe('recherche sur le réseau', () => {
  it('réseaux locaux /24 et adresse de diffusion', () => {
    const networks = localNetworks({
      en0: [
        { address: '192.168.1.20', netmask: '255.255.255.0', family: 'IPv4', internal: false, mac: '', cidr: null },
        { address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true, mac: '', cidr: null },
      ],
    });
    expect(networks).toHaveLength(1);
    expect(networks[0]!.broadcast).toBe('192.168.1.255');
    expect(networks[0]!.hosts).toHaveLength(254);
    expect(networks[0]!.hosts.at(-1)).toBe('192.168.1.254');
  });

  it('réponse WIFIKIT', () => {
    expect(parseWifikitReply('192.168.1.50,ACCF23123456,2712345678')).toEqual({
      host: '192.168.1.50',
      loggerSerial: '2712345678',
    });
    expect(parseWifikitReply('192.168.1.51,ACCF23123456,Solar-WiFi')).toEqual({ host: '192.168.1.51' });
    expect(parseWifikitReply('n’importe quoi')).toBeNull();
  });

  it('trouve une clé Solarman par diffusion, avec son numéro de série', async () => {
    const emulator = await startEmulator('deye', { model: model() });
    const wifikit = await startWifikit(
      { ip: '127.0.0.1', mac: 'ACCF23000001', serial: SOLARMAN_EMULATOR_SERIAL },
      0,
      '127.0.0.1',
    );
    try {
      expect(await broadcastWifikit(['127.0.0.1'], wifikit.port, 500)).toEqual([
        { host: '127.0.0.1', loggerSerial: SOLARMAN_EMULATOR_SERIAL },
      ]);
      const found = await scanInverters('deye', {
        hosts: [],
        broadcasts: ['127.0.0.1'],
        port: emulator.settings.port,
        wifikitPort: wifikit.port,
      });
      expect(found).toEqual([{ host: '127.0.0.1', loggerSerial: SOLARMAN_EMULATOR_SERIAL }]);
    } finally {
      await wifikit.close();
      await emulator.close();
    }
  });

  it('trouve un onduleur Modbus par balayage et écarte un appareil d’une autre marque', async () => {
    const solaredge = await startEmulator('solaredge', { model: model() });
    try {
      const options = { hosts: ['127.0.0.1'], broadcasts: [], port: solaredge.settings.port };
      expect(await scanInverters('solaredge', options)).toEqual([{ host: '127.0.0.1' }]);
      expect(await scanInverters('huawei', options)).toEqual([]);
    } finally {
      await solaredge.close();
    }
  });
});
