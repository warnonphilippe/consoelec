import { normalizeData } from './normalize';

describe('normalizeData', () => {
  it('complète les champs manquants par des valeurs par défaut', () => {
    const data = normalizeData({
      readings: [
        {
          id: 'a',
          date: '2025-01-01',
          importPeak: '1 234,5',
          importOff: 800,
          exportPeak: 10,
          exportOff: 0,
        },
      ],
    });
    expect(data.readings).toEqual([
      {
        id: 'a',
        date: '2025-01-01T12:00',
        importPeak: 1234.5,
        importOff: 800,
        exportPeak: 10,
        exportOff: 0,
        pvTotal: null,
        meterChange: false,
        source: 'manual',
        note: '',
      },
    ]);
    expect(data.house.persons).toBe(4);
    expect(data.settings.referenceAnnualKwh).toBe(3500);
  });

  it('écarte les relevés incomplets ou négatifs', () => {
    const data = normalizeData({
      readings: [
        { id: 'a', date: '2025-01-01', importPeak: 1, importOff: 1, exportPeak: 1 },
        { id: 'b', date: '2025-01-01', importPeak: -1, importOff: 1, exportPeak: 1, exportOff: 1 },
        { id: 'c', date: 'hier', importPeak: 1, importOff: 1, exportPeak: 1, exportOff: 1 },
        {
          id: 'd',
          date: '2025-01-02T08:30',
          importPeak: 1,
          importOff: 1,
          exportPeak: 1,
          exportOff: 1,
          pvTotal: 55,
        },
      ],
    });
    expect(data.readings.map((r) => r.id)).toEqual(['d']);
    expect(data.readings[0]?.pvTotal).toBe(55);
  });

  it('refuse un fichier étranger', () => {
    expect(() => normalizeData({ tank: {}, refills: [] })).toThrow();
    expect(() => normalizeData('x')).toThrow();
  });

  it('borne les pourcentages et la voiture électrique', () => {
    const data = normalizeData({
      settings: { offPeakHours: [22, 22, 5, 30, -1, 2.5] },
      house: { ev: { mode: 'owned', homeChargingPct: -5 } },
    });
    expect(data.settings.offPeakHours).toEqual([5, 22]);
    expect(data.house.ev.mode).toBe('owned');
    expect(data.house.ev.homeChargingPct).toBe(0);
  });

  it('migre un ancien fichier : puissance crête seule, parts en pourcentage', () => {
    const data = normalizeData({
      house: { pv: { kWp: 6, orientation: 'Sud' } },
      settings: {
        offPeakSharePct: 40,
        daytimeSharePct: 35,
        exportOffPeakSharePct: 28,
        referenceAnnualKwh: 4200,
      },
    });
    expect(data.house.pv.panelCount).toBe(15);
    expect(data.house.pv.panelWp).toBe(400);
    expect(data.house.pv.inverterKva).toBe(5);
    expect(data.settings.referenceAnnualKwh).toBe(4200);
    expect(data.settings.presence).toBe('partial');
    expect(Object.keys(data.settings)).not.toContain('offPeakSharePct');
  });

  it('lit les panneaux, l’onduleur, le radiateur d’appoint et la voiture', () => {
    const data = normalizeData({
      house: {
        pv: { panelCount: 16, panelWp: 410, inverterKva: 4.6, inverterPhases: 1 },
        surplusHeater: { enabled: false, powerKw: 3, startMonth: 11, endMonth: 3, usagePct: 80 },
        ev: { mode: 'planned', chargerKw: 11 },
      },
    });
    expect(data.house.pv).toMatchObject({
      panelCount: 16,
      panelWp: 410,
      inverterKva: 4.6,
      inverterPhases: 1,
    });
    expect(data.house.surplusHeater).toEqual({
      enabled: false,
      powerKw: 3,
      startMonth: 11,
      endMonth: 3,
      usagePct: 80,
    });
    expect(data.house.ev.chargerKw).toBe(11);
  });

  it('borne le radiateur et la borne de recharge', () => {
    const data = normalizeData({
      house: { surplusHeater: { powerKw: 99, startMonth: 15, usagePct: -4 }, ev: { chargerKw: 0 } },
    });
    expect(data.house.surplusHeater.powerKw).toBe(20);
    expect(data.house.surplusHeater.startMonth).toBe(12);
    expect(data.house.surplusHeater.usagePct).toBe(0);
    expect(data.house.ev.chargerKw).toBe(1.4);
  });

  it('conserve l’indication « nouveau compteur »', () => {
    const base = { date: '2025-01-01', importPeak: 1, importOff: 1, exportPeak: 1, exportOff: 1 };
    const data = normalizeData({
      readings: [
        { ...base, id: 'a', meterChange: true },
        { ...base, id: 'b' },
      ],
    });
    expect(data.readings.map((r) => r.meterChange)).toEqual([true, false]);
  });

  it('convertit l’ancienne plage de nuit en liste d’heures', () => {
    const data = normalizeData({
      settings: { offPeakStartHour: 22, offPeakEndHour: 6, offPeakWeekends: true },
    });
    expect(data.settings.offPeakHours).toEqual([0, 1, 2, 3, 4, 5, 22, 23]);
    expect(data.settings.offPeakWeekends).toBe(true);
  });

  it('adopte par défaut le bihoraire wallon de 2026', () => {
    const data = normalizeData({ readings: [] });
    expect(data.settings.offPeakHours).toEqual([
      0, 1, 2, 3, 4, 5, 6, 11, 12, 13, 14, 15, 16, 22, 23,
    ]);
    expect(data.settings.offPeakWeekends).toBe(false);
  });

  it('lit l’historique de production de l’onduleur, une entrée par jour (la plus tardive)', () => {
    const data = normalizeData({
      pvDaily: [
        { date: '2026-10-25', dayKwh: 10, totalKwh: 32060, at: '2026-10-25T12:00' },
        { date: '2026-10-25', dayKwh: 15.7, totalKwh: 32070.5, at: '2026-10-25T18:00' },
        { date: '2026-10-24', dayKwh: 'x', totalKwh: 1, at: '2026-10-24T18:00' },
        { date: 'hier', dayKwh: 1, totalKwh: 1, at: '2026-10-24T18:00' },
      ],
    });
    expect(data.pvDaily).toEqual([
      { date: '2026-10-25', dayKwh: 15.7, totalKwh: 32070.5, at: '2026-10-25T18:00' },
    ]);
  });

  it('valide les réglages de l’onduleur', () => {
    const data = normalizeData({
      settings: {
        inverter: { enabled: true, host: ' 192.168.1.42 ', certFingerprint: 'pas une empreinte' },
      },
    });
    expect(data.settings.inverter).toEqual({
      enabled: true,
      host: '192.168.1.42',
      certFingerprint: null,
    });
    expect(normalizeData({ readings: [] }).settings.inverter.host).toBe('');
  });
});
