import { readingsCsv } from './csv';
import { parseCsvDate, parseCsvNumber, parseReadingsCsv } from './csv-import';
import type { MeterReading } from '../models/app-data.model';

const reading = (over: Partial<MeterReading>): MeterReading => ({
  id: 'x',
  date: '2025-03-01T08:00',
  importPeak: 1000.5,
  importOff: 500,
  exportPeak: 2000,
  exportOff: 120.25,
  pvTotal: null,
  meterChange: false,
  source: 'manual',
  note: '',
  ...over,
});

describe('CSV des relevés', () => {
  it('relit ce qu’il a exporté', () => {
    const csv = readingsCsv([
      reading({ pvTotal: 3000.1, note: 'à « vérifier »; ok' }),
      reading({ date: '2025-02-01T08:00' }),
    ]);
    const parsed = parseReadingsCsv(csv);
    expect(parsed.errors).toEqual([]);
    expect(parsed.readings.map((r) => r.date)).toEqual(['2025-02-01T08:00', '2025-03-01T08:00']);
    expect(parsed.readings[1]).toMatchObject({
      importPeak: 1000.5,
      exportOff: 120.25,
      pvTotal: 3000.1,
      note: 'à « vérifier »; ok',
      source: 'csv',
    });
    expect(parsed.readings[0]?.pvTotal).toBeNull();
  });

  it('accepte les dates et nombres à la belge, sans en-tête', () => {
    const parsed = parseReadingsCsv('01/03/2025;1 234,5;800;10;0\n02/03/2025 18:30;1 240;801;11;0');
    expect(parsed.errors).toEqual([]);
    expect(parsed.readings.map((r) => [r.date, r.importPeak])).toEqual([
      ['2025-03-01T12:00', 1234.5],
      ['2025-03-02T18:30', 1240],
    ]);
  });

  it('signale les lignes invalides sans bloquer les autres', () => {
    const parsed = parseReadingsCsv(
      'Date;a;b;c;d\n2025-01-01;1;2;3;4\n31/02/2025;1;2;3;4\n2025-01-03;1;2;3\n2025-01-04;1;x;3;4',
    );
    expect(parsed.readings).toHaveLength(1);
    expect(parsed.errors.map((e) => e.line)).toEqual([3, 4, 5]);
  });

  it('analyse dates et nombres', () => {
    expect(parseCsvDate('2025-1-5')).toBe('2025-01-05T12:00');
    expect(parseCsvDate('5.1.2025 7:05')).toBe('2025-01-05T07:05');
    expect(parseCsvDate('hier')).toBeNull();
    expect(parseCsvNumber('1.234,5')).toBe(1234.5);
    expect(parseCsvNumber('12345.6')).toBe(12345.6);
    expect(parseCsvNumber('')).toBeNull();
    expect(parseCsvNumber('abc')).toBeNaN();
  });
});
