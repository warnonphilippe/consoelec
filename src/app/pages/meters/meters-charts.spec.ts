import { describe, expect, it } from 'vitest';
import { analyze } from '../../core/calc/analysis';
import { meterLogReadings } from '../../core/calc/meter-log';
import { dayNumberToDate, toDayNumber } from '../../core/calc/time';
import { emptyData, type MeterLog, type MeterLogPoint } from '../../core/models/app-data.model';
import { chartColors } from '../../shared/chart/chart-colors';
import {
  billingHorizon,
  indexAxisRange,
  indexChart,
  keepTooltipItem,
  withNeighbours,
  pointsFrom,
} from './meters-charts';

describe('indexAxisRange', () => {
  const now = 20_000;

  it('laisse une marge avant un relevé récent au lieu de démarrer sur lui', () => {
    const r = indexAxisRange([now - 1], now - 365, 183, now);
    expect(r.min).toBeLessThan(now - 1);
    expect(r.min).toBe(now - 1 - Math.round((now + 183 - (now - 1)) * 0.04));
    expect(r.max).toBe(now + 183);
  });

  it('ne remonte jamais avant le début de la période choisie', () => {
    const r = indexAxisRange([now - 360, now - 200, now - 1], now - 365, 0, now);
    expect(r.min).toBe(now - 365);
    expect(r.max).toBe(now);
  });

  it('garde au moins deux jours de marge, sans limite quand la période est « Tout »', () => {
    expect(indexAxisRange([now - 3], null, 0, now).min).toBe(now - 5);
    expect(indexAxisRange([now - 900], null, 0, now).min).toBe(now - 900 - 36);
  });

  it('sans relevé dans la période, montre la période entière', () => {
    expect(indexAxisRange([], now - 183, 0, now)).toEqual({ min: now - 183, max: now });
    expect(indexAxisRange([], null, 0, now)).toEqual({ min: now - 30, max: now });
  });
});

describe('keepTooltipItem', () => {
  it('masque une prévision quand la mesure de la même série est déjà dans l’infobulle', () => {
    const labels = ['Soutirage HP', 'Soutirage HP (prévision)', 'Injection HC (prévision)'];
    expect(keepTooltipItem('Soutirage HP', labels)).toBe(true);
    expect(keepTooltipItem('Soutirage HP (prévision)', labels)).toBe(false);
    // Pas de mesure de cette série à cet endroit : la prévision reste.
    expect(keepTooltipItem('Injection HC (prévision)', labels)).toBe(true);
    expect(keepTooltipItem(undefined, labels)).toBe(true);
  });
});

describe('billingHorizon', () => {
  it('va jusqu’à une facturation qui tombe juste après la période choisie', () => {
    const now = 20_000;
    expect(billingHorizon([now + 5, now + 370], now, 365)).toBe(372);
    expect(billingHorizon([now + 5, now + 400], now, 365)).toBe(365);
    expect(billingHorizon([now + 5], now, 0)).toBe(0);
  });
});

describe('pointsFrom', () => {
  it('coupe la courbe à la date donnée, sur un point interpolé', () => {
    const points = [
      { day: 10, hp: 0, hc: 100 },
      { day: 20, hp: 50, hc: 0 },
      { day: 30, hp: 80, hc: -20 },
    ];
    expect(pointsFrom(points, 15)).toEqual([{ day: 15, hp: 25, hc: 50 }, points[1], points[2]]);
    expect(pointsFrom(points, 20)).toEqual([points[1], points[2]]);
    expect(pointsFrom(points, 5)).toEqual(points);
    expect(pointsFrom(points, 40)).toEqual([]);
    // Limite absente (période sans plafond tenable) : le point interpolé l'est aussi.
    expect(pointsFrom([{ day: 10, hp: null, hc: 0 }, { day: 20, hp: null, hc: 10 }], 15)[0]).toEqual({
      day: 15,
      hp: null,
      hc: 5,
    });
  });
});

describe('indexChart', () => {
  const p = (at: string, importPeak: number): MeterLogPoint => ({
    at,
    importPeak,
    importOff: 0,
    exportPeak: 0,
    exportOff: 0,
  });
  const log: MeterLog = {
    days: [p('2026-10-26T23:59', 100), p('2026-10-27T23:59', 110), p('2026-10-28T10:05', 114)],
    hours: [p('2026-10-28T08:59', 112), p('2026-10-28T09:59', 113), p('2026-10-28T10:05', 114)],
    minutes: [p('2026-10-28T09:59', 113), p('2026-10-28T10:04', 113.9), p('2026-10-28T10:05', 114)],
  };
  const now = toDayNumber('2026-10-28T10:05');
  const analysis = analyze({ ...emptyData(), readings: meterLogReadings(log, []) }, now);
  const ms = (iso: string): number => dayNumberToDate(toDayNumber(iso)).getTime();

  it('trace un point par jour, puis chaque heure et chaque minute récente du jour en cours', () => {
    const recent = [...log.hours, log.minutes[1]!].sort((a, b) => a.at.localeCompare(b.at));
    const config = indexChart(analysis, null, recent, ['importPeak'], null, 0, now)(chartColors('light'));
    const [real] = config.data.datasets;
    expect(real!.data).toEqual([
      { x: ms('2026-10-26T23:59'), y: 100 },
      { x: ms('2026-10-27T23:59'), y: 110 },
      { x: ms('2026-10-28T08:59'), y: 112 },
      { x: ms('2026-10-28T09:59'), y: 113 },
      { x: ms('2026-10-28T10:04'), y: 113.9 },
      { x: ms('2026-10-28T10:05'), y: 114 },
    ]);
    // Marqueurs sur les relevés quotidiens (dont la dernière lecture), pas sur les lectures fines.
    expect((real as unknown as { pointRadius: number[] }).pointRadius).toEqual([3, 3, 0, 0, 0, 3]);
  });

  it('respecte la période choisie pour les lectures fines aussi', () => {
    const config = indexChart(analysis, null, log.hours, ['importPeak'], now - 0.003, 0, now)(chartColors('light'));
    expect(config.data.datasets[0]!.data).toEqual([{ x: ms('2026-10-28T10:05'), y: 114 }]);
  });
});

describe('withNeighbours', () => {
  const pts = [10, 40, 70, 100].map((day) => ({ day }));

  it('garde les points de la période et un voisin de chaque côté', () => {
    expect(withNeighbours(pts, { min: 35, max: 75 }).map((p) => p.day)).toEqual([10, 40, 70, 100]);
    expect(withNeighbours(pts, { min: 60, max: 120 }).map((p) => p.day)).toEqual([40, 70, 100]);
  });

  it('trace le segment qui traverse une période sans relevé', () => {
    expect(withNeighbours(pts, { min: 45, max: 65 }).map((p) => p.day)).toEqual([40, 70]);
  });

  it('ne trace rien quand tous les points sont avant ou après la période', () => {
    expect(withNeighbours(pts, { min: 110, max: 140 })).toEqual([]);
    expect(withNeighbours(pts, { min: 0, max: 5 })).toEqual([]);
  });
});

