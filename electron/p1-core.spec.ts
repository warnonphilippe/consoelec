import { p1StatusError, parseP1Data } from './p1-core';

/** Réponse type de `GET /api/v1/data` (valeurs fictives). */
const SAMPLE = {
  wifi_ssid: 'Maison',
  wifi_strength: 80,
  meter_model: 'ISKRA 2MIE5T-200',
  unique_id: '3132333435363738',
  active_tariff: 1,
  total_power_import_kwh: 1500.5,
  total_power_import_t1_kwh: 900.25,
  total_power_import_t2_kwh: 600.25,
  total_power_import_t3_kwh: 0,
  total_power_import_t4_kwh: 0,
  total_power_export_kwh: 3000,
  total_power_export_t1_kwh: 1000.1234,
  total_power_export_t2_kwh: 1999.8766,
  total_power_export_t3_kwh: 0,
  total_power_export_t4_kwh: 0,
  active_power_w: 1234.4,
  active_power_average_w: 1100,
  external: [],
};

describe('lecture du lecteur P1 HomeWizard', () => {
  it('lit les quatre index, la puissance et le tarif', () => {
    expect(parseP1Data(SAMPLE, 42)).toEqual({
      at: 42,
      powerW: 1234,
      quarterHourAvgW: 1100,
      tariff: 1,
      importPeak: 900.25,
      importOff: 600.25,
      exportPeak: 1000.123,
      exportOff: 1999.877,
      meterModel: 'ISKRA 2MIE5T-200',
      error: null,
    });
  });

  it('garde une puissance négative quand la maison injecte', () => {
    expect(parseP1Data({ ...SAMPLE, active_power_w: -2500 }, 0)?.powerW).toBe(-2500);
  });

  it('accepte une réponse partielle et ignore un tarif inconnu', () => {
    const reading = parseP1Data({ active_power_w: 300, active_tariff: 3 }, 0);
    expect(reading).toMatchObject({ powerW: 300, tariff: null, importPeak: null, exportOff: null });
  });

  it("refuse ce qui n'est pas la réponse d'un lecteur", () => {
    expect(parseP1Data(null, 0)).toBeNull();
    expect(parseP1Data([], 0)).toBeNull();
    expect(parseP1Data({ product_name: 'autre' }, 0)).toBeNull();
    expect(
      parseP1Data({ total_power_import_t1_kwh: 'beaucoup', active_power_w: Number.NaN }, 0),
    ).toBeNull();
  });
});

describe('erreurs du lecteur P1', () => {
  it("explique comment activer l'API locale", () => {
    expect(p1StatusError(403, { error: 'api:disabled' })).toMatch(/API locale/);
    expect(p1StatusError(401, { error: 'user:unauthorized' })).toMatch(/API locale/);
  });

  it('rapporte le code des autres réponses', () => {
    expect(p1StatusError(500, null)).toBe('Réponse inattendue du lecteur P1 (code 500).');
  });
});
