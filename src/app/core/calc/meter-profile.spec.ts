import type { MeterLogPoint } from '../models/app-data.model';
import { normalizeData } from '../models/normalize';
import { parseHomeWizardCsv } from './homewizard-csv';
import {
  PROFILE_DETAIL_DAYS,
  addSamples,
  dailyEnergy,
  dayQuarters,
  mergeProfiles,
  profileFromLog,
  pruneProfile,
  samplesBetween,
} from './meter-profile';

/** Lecture P1 : soutirage et injection totaux (kWh) répartis sur HP. */
const point = (at: string, importKwh: number, exportKwh: number): MeterLogPoint => ({
  at,
  importPeak: importKwh,
  importOff: 0,
  exportPeak: exportKwh,
  exportOff: 0,
});

describe('profil au quart d’heure', () => {
  it('interpole les index aux quarts d’heure entre deux lectures rapprochées (mesuré)', () => {
    const samples = samplesBetween(point('2026-11-07T10:14', 100, 50), point('2026-11-07T10:16', 100.002, 50.004));
    expect(samples).toEqual([
      { minute: expect.any(Number), importWh: 100_001, exportWh: 50_002, estimated: false },
    ]);
    const day = addSamples([], samples)[0]!;
    expect(day.date).toBe('2026-11-07');
    expect(day.importWh[41]).toBe(100_001); // 10:15 = 41e quart
  });

  it('marque estimés les index interpolés sur un trou de lecture, mais pas ses bornes', () => {
    const samples = samplesBetween(point('2026-11-07T08:00', 100, 50), point('2026-11-07T09:00', 101, 50));
    expect(samples.map((s) => s.estimated)).toEqual([false, true, true, true, false]);
    expect(samples.map((s) => s.importWh)).toEqual([100_000, 100_250, 100_500, 100_750, 101_000]);
  });

  it('ignore un index qui recule (changement de compteur)', () => {
    expect(samplesBetween(point('2026-11-07T08:00', 100, 50), point('2026-11-07T08:30', 0, 0))).toEqual([]);
  });

  it('donne l’énergie de chaque quart d’heure, y compris celui qui finit à minuit', () => {
    const profile = profileFromLog({
      minutes: [],
      hours: [],
      days: [point('2026-11-06T23:30', 100, 50), point('2026-11-07T00:15', 100.3, 50)],
    });
    const quarters = dayQuarters(profile, '2026-11-06');
    expect(quarters.map((q) => [q.at, q.importWh, q.estimated])).toEqual([
      ['2026-11-06T23:30', 100, true],
      ['2026-11-06T23:45', 100, true],
    ]);
    expect(dayQuarters(profile, '2026-11-07')[0]).toMatchObject({ at: '2026-11-07T00:00', importWh: 100 });
  });

  it('une valeur mesurée remplace une estimée, jamais l’inverse, et rien ne compte double', () => {
    const estimated = addSamples([], samplesBetween(point('2026-11-07T08:00', 100, 50), point('2026-11-07T09:00', 101, 50)));
    const csv = parseHomeWizardCsv(
      'time,Import T1 kWh,Import T2 kWh,Export T1 kWh,Export T2 kWh\n2026-11-07 08:15,90,10.9,40,10\n',
    );
    const merged = mergeProfiles(estimated, csv.days);
    expect(merged[0]!.importWh[33]).toBe(100_900);
    expect(merged[0]!.estimated).toEqual([34, 35]);
    // Réimporter le même fichier ne change rien.
    expect(mergeProfiles(merged, csv.days)).toBe(merged);
    // Une estimation ne remplace pas une mesure.
    const again = addSamples(merged, samplesBetween(point('2026-11-07T07:00', 99, 50), point('2026-11-07T09:00', 101, 50)));
    expect(again[0]!.importWh[33]).toBe(100_900);
  });

  it('totalise les journées complètes et signale les partielles', () => {
    const profile = profileFromLog({
      minutes: [],
      hours: [],
      days: [
        point('2026-11-05T00:00', 100, 50),
        point('2026-11-06T00:00', 110, 58),
        point('2026-11-07T00:00', 125, 60),
        point('2026-11-07T10:00', 127, 70),
      ],
    });
    const days = dailyEnergy(profile, '2026-11-04', '2026-11-07');
    expect(days.map((d) => [d.date, d.importKwh, d.exportKwh, d.partial])).toEqual([
      ['2026-11-05', 10, 8, false],
      ['2026-11-06', 15, 2, false],
      ['2026-11-07', 2, 10, true],
    ]);
    expect(days[0]!.estimated).toBe(true);
  });

  it(`ne garde que l’index de minuit au-delà de ${PROFILE_DETAIL_DAYS} jours`, () => {
    const old = profileFromLog({
      minutes: [],
      hours: [],
      days: [point('2025-01-01T00:00', 100, 50), point('2025-01-01T01:00', 101, 50)],
    });
    const recent = profileFromLog({
      minutes: [],
      hours: [],
      days: [point('2026-11-07T00:00', 5000, 50), point('2026-11-07T00:15', 5000.1, 50)],
    });
    const pruned = pruneProfile([...old, ...recent]);
    expect(pruned[0]!.importWh.filter((v) => v !== null)).toEqual([100_000]);
    expect(pruned[1]!.importWh.filter((v) => v !== null)).toHaveLength(2);
  });

  it('est tiré du journal P1 au premier chargement, puis relu tel quel', () => {
    const data = normalizeData({
      readings: [],
      meterLog: { days: [{ at: '2026-11-06T22:00', importPeak: 1, importOff: 0, exportPeak: 1, exportOff: 0 }, { at: '2026-11-06T22:30', importPeak: 1.5, importOff: 0, exportPeak: 1, exportOff: 0 }] },
    });
    expect(dayQuarters(data.meterProfile, '2026-11-06').map((q) => q.importWh)).toEqual([250, 250]);
    const again = normalizeData(JSON.parse(JSON.stringify(data)));
    expect(again.meterProfile).toEqual(data.meterProfile);
    expect(normalizeData({ readings: [], meterProfile: [{ date: 'x' }, { date: '2026-11-06', importWh: [1, -2], exportWh: [3, 4], estimated: [0, 5] }] }).meterProfile).toEqual([
      expect.objectContaining({ date: '2026-11-06', estimated: [0] }),
    ]);
  });
});

describe('export CSV de l’app HomeWizard', () => {
  const header = 'time,Import T1 kWh,Import T2 kWh,Export T1 kWh,Export T2 kWh,L1 max W,L2 max W,L3 max W';

  it('lit l’export au quart d’heure (T1 + T2, colonnes de puissance ignorées)', () => {
    const r = parseHomeWizardCsv(
      [header, '2026-11-06 23:45,858.000,512.000,1183.000,2606.000,1200,300,200', '2026-11-07 00:00,858.000,512.250,1183.000,2606.000,900,,'].join('\n'),
    );
    expect(r.error).toBeNull();
    expect(r).toMatchObject({ rows: 2, from: '2026-11-06T23:45', to: '2026-11-07T00:00', daily: false });
    expect(dayQuarters(r.days, '2026-11-06')).toEqual([
      { at: '2026-11-06T23:45', importWh: 250, exportWh: 0, estimated: false },
    ]);
  });

  it('accepte le point-virgule, la virgule décimale et l’export journalier', () => {
    const r = parseHomeWizardCsv(
      ['time;Import T1 kWh;Import T2 kWh;Export T1 kWh;Export T2 kWh', '01-11-2026 00:00;10,5;1;2;3', '02-11-2026 00:00;12;1;2;8'].join('\r\n'),
    );
    expect(r.daily).toBe(true);
    expect(dailyEnergy(r.days, '2026-11-01', '2026-11-01')).toEqual([
      { date: '2026-11-01', importKwh: 1.5, exportKwh: 5, estimated: false, partial: false },
    ]);
  });

  it('refuse un fichier qui n’est pas un export HomeWizard', () => {
    expect(parseHomeWizardCsv('date;HP;HC\n2026-01-01;1;2').error).toContain('export HomeWizard');
    expect(parseHomeWizardCsv('').error).toBe('Fichier vide.');
    expect(parseHomeWizardCsv(`${header}\nn'importe quoi`).error).toContain('Aucune ligne');
  });
});
