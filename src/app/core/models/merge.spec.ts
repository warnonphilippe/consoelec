import { emptyData, type AppData, type MeterReading } from './app-data.model';
import { mergeData } from './merge';

const reading = (id: string, date: string, importPeak: number, note = ''): MeterReading => ({
  id,
  date,
  importPeak,
  importOff: 0,
  exportPeak: 0,
  exportOff: 0,
  pvTotal: null,
  meterChange: false,
  source: 'manual',
  note,
});

const withReadings = (readings: MeterReading[]): AppData => ({ ...emptyData(), readings });

describe('mergeData', () => {
  it('ajoute seulement les relevés absents', () => {
    const local = withReadings([reading('a', '2025-01-01T09:00', 100)]);
    const incoming = withReadings([
      reading('a', '2025-01-01T09:00', 100),
      reading('b', '2025-02-01T09:00', 200),
    ]);
    const { data, report } = mergeData(local, incoming);
    expect(data.readings.map((r) => r.id)).toEqual(['a', 'b']);
    expect(report).toMatchObject({ addedReadings: 1, duplicateReadings: 1, conflicts: 0 });
  });

  it('reconnaît le même relevé encodé séparément (autre identifiant)', () => {
    const local = withReadings([reading('a', '2025-01-01T09:00', 100)]);
    const incoming = withReadings([reading('z', '2025-01-01T09:00', 100)]);
    const { data, report } = mergeData(local, incoming);
    expect(data.readings).toHaveLength(1);
    expect(report.duplicateReadings).toBe(1);
  });

  it('garde la version locale en cas de conflit', () => {
    const local = withReadings([reading('a', '2025-01-01T09:00', 100, 'local')]);
    const incoming = withReadings([reading('a', '2025-01-01T09:00', 100, 'distant')]);
    const { data, report } = mergeData(local, incoming);
    expect(data.readings[0]?.note).toBe('local');
    expect(report.conflicts).toBe(1);
  });

  it('reprend la maison du fichier seulement si la locale est restée par défaut', () => {
    const incoming = withReadings([]);
    incoming.house.pv.panelCount = 20;
    expect(mergeData(emptyData(), incoming, true).data.house.pv.panelCount).toBe(20);
    const kept = mergeData(emptyData(), incoming, false);
    expect(kept.data.house.pv.panelCount).toBe(16);
    expect(kept.report.houseDiffers).toBe(true);
  });

  it('fusionne la production de l’onduleur par jour, en gardant la lecture la plus tardive', () => {
    const local = {
      ...withReadings([]),
      pvDaily: [
        { date: '2026-10-24', dayKwh: 12, totalKwh: 32054, at: '2026-10-24T20:00' },
        { date: '2026-10-25', dayKwh: 8, totalKwh: 32062, at: '2026-10-25T13:00' },
      ],
    };
    const incoming = {
      ...withReadings([]),
      pvDaily: [
        { date: '2026-10-25', dayKwh: 9.9, totalKwh: 12345, at: '2026-10-25T19:00' },
        { date: '2026-10-23', dayKwh: 9, totalKwh: 32042, at: '2026-10-23T19:00' },
        { date: '2026-10-24', dayKwh: 11, totalKwh: 32053, at: '2026-10-24T17:00' },
      ],
    };
    const { data, report } = mergeData(local, incoming);
    expect(data.pvDaily.map((d) => [d.date, d.dayKwh])).toEqual([
      ['2026-10-23', 9],
      ['2026-10-24', 12],
      ['2026-10-25', 9.9],
    ]);
    expect(report.addedPvDays).toBe(2);
  });

  it('ajoute les factures annuelles d’une période absente, sans toucher aux locales', () => {
    const bill = (from: string, to: string, netPeak: number) => ({
      id: from,
      from,
      to,
      netPeak,
      netOff: 10,
      schedule: 'legacy' as const,
      note: '',
    });
    const local: AppData = { ...emptyData(), annualBills: [bill('2020-11-01', '2021-11-01', 100)] };
    const incoming: AppData = {
      ...emptyData(),
      annualBills: [bill('2020-11-01', '2021-11-01', 999), bill('2021-11-01', '2022-11-01', 200)],
    };
    const { data, report } = mergeData(local, incoming);
    expect(report.addedBills).toBe(1);
    expect(data.annualBills.map((b) => b.netPeak)).toEqual([100, 200]);
  });

  it('ajoute les jours d’index du compteur P1 absents ou plus complets', () => {
    const p = (at: string) => ({ at, importPeak: 1, importOff: 2, exportPeak: 3, exportOff: 4 });
    const local: AppData = {
      ...emptyData(),
      meterLog: { minutes: [p('2026-10-28T08:00')], hours: [], days: [p('2026-10-27T12:00')] },
    };
    const incoming: AppData = {
      ...emptyData(),
      meterLog: { minutes: [], hours: [], days: [p('2026-10-26T23:59'), p('2026-10-27T23:59')] },
    };
    const { data, report } = mergeData(local, incoming);
    expect(report.addedMeterDays).toBe(2);
    expect(data.meterLog.days.map((d) => d.at)).toEqual(['2026-10-26T23:59', '2026-10-27T23:59']);
    expect(data.meterLog.minutes).toEqual(local.meterLog.minutes);
  });
});
