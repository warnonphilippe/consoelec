import {
  P1_EMULATOR_IDS,
  startP1Emulator,
  type StartedP1Emulator,
} from '../../scripts/emulators/p1-catalog';
import { buildTelegram, MeterModel } from '../../scripts/emulators/p1-meter';
import { startDsmrTcp, startHomeWizardV1 } from '../../scripts/emulators/p1-servers';
import { SolarModel } from '../../scripts/emulators/solar-model';
import { P1Client, pairHomeWizard, readTelegram } from '../p1';
import type { P1Config } from '../shared/ipc-contract';
import { dsmrCrc, extractTelegram, obisValues, parseTelegram, telegramCrcOk } from './dsmr';
import { parseHomeWizardV2, parseYouLess } from './formats';

/** Un mardi d'été à 13 h 07 : tarif de jour, injection du surplus solaire. */
const NOON = new Date(2026, 5, 23, 13, 7, 0).getTime();
/** Le même mardi à 23 h : tarif de nuit, soutirage. */
const NIGHT = new Date(2026, 5, 23, 23, 0, 0).getTime();
const meterAt = (ms: number) =>
  new MeterModel({ now: () => ms, solar: new SolarModel({ now: () => ms }) });

function configOf(e: StartedP1Emulator, extra: Partial<P1Config> = {}): P1Config {
  return {
    enabled: true,
    kind: e.kind,
    host: e.host,
    port: e.port,
    certFingerprint: null,
    ...extra,
  };
}

describe('lecture de chaque lecteur P1 contre son émulateur', () => {
  it.each(P1_EMULATOR_IDS)('%s', async (id) => {
    for (const at of [NOON, NIGHT]) {
      const e = await startP1Emulator(id, { meter: meterAt(at), autoPressAfter: 0 });
      let token: string | null = null;
      try {
        if (e.v2) {
          token = (await pairHomeWizard(e.host, e.port, 5000, 50)).token;
        }
        const client = new P1Client(() => token);
        client.configure(configOf(e));
        const r = await client.read();
        expect(r.error).toBeNull();
        const s = e.meter.state();
        expect(r.importPeak).toBeCloseTo(s.importT1, 3);
        expect(r.importOff).toBeCloseTo(s.importT2, 3);
        expect(r.exportPeak).toBeCloseTo(s.exportT1, 3);
        expect(r.exportOff).toBeCloseTo(s.exportT2, 3);
        expect(r.powerW).toBe(s.powerW);
        if (at === NOON) {
          expect(r.powerW!).toBeLessThan(0); // injection à midi
        } else {
          expect(r.powerW!).toBeGreaterThan(0);
        }
        if (id !== 'p1-youless') {
          expect(r.tariff).toBe(at === NOON ? 1 : 2);
          expect(r.quarterHourAvgW).toBe(s.quarterHourAvgW);
        }
      } finally {
        await e.close();
      }
    }
  });
});

describe('HomeWizard API v2', () => {
  it('attend l’appui sur le bouton, épingle le certificat et refuse un autre certificat', async () => {
    const e = await startP1Emulator('p1-homewizard-v2', { meter: meterAt(NOON) });
    try {
      setTimeout(() => e.v2!.pressButton(), 300);
      const paired = await pairHomeWizard(e.host, e.port, 5000, 100);
      expect(paired.token).toBe(e.v2!.token());
      expect(paired.fingerprint).toBe(e.fingerprint);
      const client = new P1Client(() => paired.token);
      client.configure(configOf(e, { certFingerprint: paired.fingerprint }));
      expect((await client.read()).error).toBeNull();
      client.configure(configOf(e, { certFingerprint: 'AA:'.repeat(31) + 'AA' }));
      expect((await client.read()).error).toContain('certificat');
    } finally {
      await e.close();
    }
  });

  it('abandonne si le bouton n’est pas pressé à temps', async () => {
    const e = await startP1Emulator('p1-homewizard-v2', { meter: meterAt(NOON) });
    try {
      await expect(pairHomeWizard(e.host, e.port, 300, 100)).rejects.toThrow(
        'Bouton du lecteur non pressé',
      );
    } finally {
      await e.close();
    }
  });

  it('jeton absent ou refusé', async () => {
    const e = await startP1Emulator('p1-homewizard-v2', { meter: meterAt(NOON) });
    try {
      const none = new P1Client(() => null);
      none.configure(configOf(e));
      expect((await none.read()).error).toContain('Associer');
      const wrong = new P1Client(() => '0123456789ABCDEF0123456789ABCDEF');
      wrong.configure(configOf(e));
      expect((await wrong.read()).error).toContain('Jeton refusé');
    } finally {
      await e.close();
    }
  });

  it('format de /api/measurement', () => {
    expect(
      parseHomeWizardV2({ power_w: -1200.4, energy_import_t1_kwh: 12.3456, tariff: 2 }, 1),
    ).toMatchObject({
      powerW: -1200,
      importPeak: 12.346,
      tariff: 2,
    });
    expect(parseHomeWizardV2({ wifi_ssid: 'x' }, 1)).toBeNull();
  });
});

describe('télégramme P1 (e-MUCS / DSMR)', () => {
  const telegram = buildTelegram(meterAt(NOON).state(), NOON);

  it('CRC-16 du télégramme', () => {
    expect(telegramCrcOk(telegram)).toBe(true);
    expect(telegramCrcOk(telegram.replace('1-0:1.8.1(0', '1-0:1.8.1(1'))).toBe(false);
    // Vecteur de contrôle : CRC-16/ARC de « 123456789 ».
    expect(dsmrCrc('123456789')).toBe(0xbb3d);
  });

  it('extrait un télégramme d’un flux commencé en cours de route', () => {
    const found = extractTelegram(`2.7.0(00.000*kW)\r\n!1A2B\r\n${telegram}/FLU5`);
    expect(found?.telegram.trim()).toBe(telegram.trim());
    expect(found?.rest).toContain('/FLU5');
  });

  it('codes OBIS belges : tarif 1 = jour, puissance nette, moyenne du quart d’heure', () => {
    const v = obisValues(telegram);
    expect(v.get('0-0:96.14.0')).toBe('0001');
    const r = parseTelegram(telegram, NOON)!;
    const s = meterAt(NOON).state();
    expect(r.tariff).toBe(1);
    expect(r.importPeak).toBe(s.importT1);
    expect(r.powerW).toBe(s.powerW);
    expect(r.meterModel).toBe('FLU5\\253769484_A');
  });

  it('accepte un ancien télégramme sans CRC (DSMR 2/3)', () => {
    expect(telegramCrcOk('/ISK5\r\n1-0:1.8.1(00001.000*kWh)\r\n!')).toBe(true);
  });

  it('signale des télégrammes corrompus', async () => {
    const server = await startDsmrTcp(meterAt(NOON), { corrupt: true, intervalMs: 50 });
    try {
      await expect(readTelegram('127.0.0.1', server.port, 600)).rejects.toThrow('CRC');
    } finally {
      await server.close();
    }
  });

  it('signale un port muet', async () => {
    const net = await import('node:net');
    const silent = net.createServer(() => undefined);
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()));
    const port = (silent.address() as import('node:net').AddressInfo).port;
    try {
      await expect(readTelegram('127.0.0.1', port, 300)).rejects.toThrow("n'envoie rien");
    } finally {
      silent.close();
    }
  });
});

describe('YouLess', () => {
  it('format de /e', () => {
    expect(parseYouLess([{ p1: 1.5, p2: 2.5, n1: 0.5, n2: 0.25, pwr: -300 }], 1)).toMatchObject({
      importPeak: 1.5,
      exportOff: 0.25,
      powerW: -300,
    });
    expect(parseYouLess([{ cs0: 1 }], 1)).toBeNull();
  });
});

describe('erreurs compréhensibles', () => {
  it('API v1 désactivée dans l’app HomeWizard', async () => {
    const server = await startHomeWizardV1(meterAt(NOON), { apiEnabled: false });
    try {
      const c = new P1Client();
      c.configure({ enabled: true, kind: 'homewizard', host: '127.0.0.1', port: server.port });
      expect((await c.read()).error).toContain('API locale du lecteur est désactivée');
    } finally {
      await server.close();
    }
  });

  it('mauvais type de lecteur choisi', async () => {
    const e = await startP1Emulator('p1-youless', { meter: meterAt(NOON) });
    try {
      const c = new P1Client();
      c.configure({ ...configOf(e), kind: 'homewizard' });
      expect((await c.read()).error).toMatch(/inattendue/);
    } finally {
      await e.close();
    }
  });
});
