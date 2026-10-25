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
});
