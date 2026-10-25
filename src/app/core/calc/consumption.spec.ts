import {
  DEFAULT_HOUSE,
  DEFAULT_SETTINGS,
  emptyData,
  type MeterReading,
} from '../models/app-data.model';
import { referenceProfile, seriesWeights } from './reference';
import { analyzeConsumption, buildIntervals, levelsOf, totalsBetween } from './consumption';
import { toDayNumber } from './time';

const reading = (date: string, over: Partial<MeterReading> = {}): MeterReading => ({
  id: date,
  date,
  importPeak: 0,
  importOff: 0,
  exportPeak: 0,
  exportOff: 0,
  pvTotal: null,
  meterChange: false,
  source: 'manual',
  note: '',
  ...over,
});

const BASE = seriesWeights(referenceProfile(DEFAULT_HOUSE, DEFAULT_SETTINGS));

describe('analyzeConsumption', () => {
  it('conserve les totaux de chaque registre entre deux relevés', () => {
    const analysis = analyzeConsumption(
      [
        reading('2025-01-01T00:00', {
          importPeak: 1000,
          importOff: 500,
          exportPeak: 200,
          exportOff: 20,
        }),
        reading('2025-04-01T00:00', {
          importPeak: 1600,
          importOff: 800,
          exportPeak: 500,
          exportOff: 50,
        }),
      ],
      BASE,
    );
    const total = (key: 'importPeak' | 'importOff' | 'exportPeak' | 'exportOff'): number =>
      analysis.months.reduce((s, m) => s + m.values[key], 0);
    expect(total('importPeak')).toBeCloseTo(600, 3);
    expect(total('importOff')).toBeCloseTo(300, 3);
    expect(total('exportPeak')).toBeCloseTo(300, 3);
    expect(total('exportOff')).toBeCloseTo(30, 3);
    expect(analysis.months.map((m) => m.key)).toEqual(['2025-01', '2025-02', '2025-03']);
    expect(analysis.months.every((m) => m.complete)).toBe(true);
  });

  it('répartit selon la saison : plus de soutirage en janvier, plus d’injection en mars qu’en janvier', () => {
    const analysis = analyzeConsumption(
      [
        reading('2025-01-01T00:00', { importPeak: 0 }),
        reading('2025-04-01T00:00', { importPeak: 900, exportPeak: 900 }),
      ],
      BASE,
    );
    const [jan, , mar] = analysis.months;
    expect(jan!.values.importPeak).toBeGreaterThan(mar!.values.importPeak);
    expect(mar!.values.exportPeak).toBeGreaterThan(jan!.values.exportPeak * 3);
  });

  it('marque incomplet le mois entamé et ignore les index en baisse', () => {
    const analysis = analyzeConsumption(
      [
        reading('2025-01-15T12:00', { importPeak: 100 }),
        reading('2025-02-15T12:00', { importPeak: 150 }),
        reading('2025-03-15T12:00', { importPeak: 120 }),
      ],
      BASE,
    );
    expect(analysis.intervals[1]!.anomalies).toContain('decrease');
    expect(analysis.intervals[1]!.delta.importPeak).toBeNull();
    expect(analysis.months.find((m) => m.key === '2025-01')!.complete).toBe(false);
    expect(analysis.months.find((m) => m.key === '2025-02')!.complete).toBe(false);
    expect(analysis.anomalyCount).toBe(1);
  });

  it('signale les longues périodes et les valeurs aberrantes', () => {
    const intervals = buildIntervals(
      levelsOf([
        reading('2025-01-01T00:00'),
        reading('2025-04-01T00:00'),
        reading('2025-04-02T00:00', { importPeak: 5000 }),
      ]),
    );
    expect(intervals[0]!.anomalies).toContain('long');
    expect(intervals[1]!.anomalies).toContain('spike');
  });

  it('suit la production totale seulement quand elle est encodée à chaque bout', () => {
    const analysis = analyzeConsumption(
      [
        reading('2025-01-01T00:00', { pvTotal: 1000 }),
        reading('2025-02-01T00:00', { pvTotal: 1100 }),
        reading('2025-03-01T00:00'),
      ],
      BASE,
    );
    expect(analysis.intervals[0]!.delta.pv).toBe(100);
    expect(analysis.intervals[1]!.delta.pv).toBeNull();
    expect(analysis.months[0]!.pvComplete).toBe(true);
  });

  it('totalsBetween renvoie la part d’une période', () => {
    const analysis = analyzeConsumption(
      [reading('2025-01-01T00:00'), reading('2025-02-01T00:00', { importPeak: 310 })],
      BASE,
    );
    const half = totalsBetween(
      analysis,
      toDayNumber('2025-01-01'),
      toDayNumber('2025-01-16'),
      BASE,
    );
    expect(half.covered.importPeak).toBeCloseTo(15, 5);
    expect(half.values.importPeak).toBeGreaterThan(140);
    expect(half.values.importPeak).toBeLessThan(170);
    expect(emptyData().readings).toHaveLength(0);
  });
});
