import { describe, expect, it } from 'vitest';
import { analyze } from '../../core/calc/analysis';
import { meterLogReadings, type TodayCurve } from '../../core/calc/meter-log';
import { dayNumberToDate, toDayNumber } from '../../core/calc/time';
import { emptyData, type MeterLog, type MeterLogPoint } from '../../core/models/app-data.model';
import { chartColors } from '../../shared/chart/chart-colors';
import { dayCurveChart } from '../production/production-charts';
import {
  billingHorizon,
  indexAxisRange,
  indexChart,
  keepTooltipItem,
  pointsFrom,
  todayChart,
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

describe('todayChart', () => {
  const curve: TodayCurve = {
    start: '2026-10-28T00:00',
    fromMidnight: true,
    points: [
      {
        at: '2026-10-28T00:00',
        values: { importPeak: 0, importOff: 0, exportPeak: 0, exportOff: 0 },
      },
      {
        at: '2026-10-28T08:30',
        values: { importPeak: 0.5, importOff: 2.25, exportPeak: 1, exportOff: 0 },
      },
    ],
    totals: { importPeak: 0.5, importOff: 2.25, exportPeak: 1, exportOff: 0 },
    lastAt: '2026-10-28T08:30',
  };
  const now = new Date(2026, 9, 28, 8, 31).getTime();

  it('trace une courbe par registre choisi, de 6 h à 22 h comme la courbe de production', () => {
    const config = todayChart(curve, ['importOff', 'exportPeak'], now)(chartColors('light'));
    expect(config.data.datasets.map((d) => d.label)).toEqual(['Soutirage HC', 'Injection HP']);
    expect(config.data.datasets[0]!.data).toEqual([
      { x: new Date(2026, 9, 28, 0, 0).getTime(), y: 0 },
      { x: new Date(2026, 9, 28, 8, 30).getTime(), y: 2.25 },
    ]);
    const x = config.options!.scales!['x']!;
    expect(x.min).toBe(new Date(2026, 9, 28, 6, 0).getTime());
    expect(x.max).toBe(new Date(2026, 9, 28, 22, 0).getTime());
    expect(x.ticks?.maxTicksLimit).toBe(9);
  });

  it('garde l’axe de 6 h à 22 h même tôt le matin', () => {
    const early = { ...curve, points: curve.points.slice(0, 1), lastAt: '2026-10-28T00:00' };
    const at = new Date(2026, 9, 28, 4, 15).getTime();
    const x = todayChart(early, ['importOff'], at)(chartColors('light')).options!.scales!['x']!;
    expect(x.min).toBe(new Date(2026, 9, 28, 6, 0).getTime());
    expect(x.max).toBe(new Date(2026, 9, 28, 22, 0).getTime());
  });

  it('a les mêmes axes horaires et la même largeur d’axe vertical que la courbe de production', () => {
    const day = new Date(2026, 9, 28).getTime();
    const colors = chartColors('light');
    const index = todayChart(curve, ['importOff'], now)(colors).options!.scales!;
    const power = dayCurveChart([{ at: day + 9 * 3_600_000, powerW: 1200 }], day, now)(colors).options!.scales!;
    expect(index['x']!.min).toBe(power['x']!.min);
    expect(index['x']!.max).toBe(power['x']!.max);
    expect((index['x'] as { ticks: { maxTicksLimit: number } }).ticks.maxTicksLimit).toBe(
      (power['x'] as { ticks: { maxTicksLimit: number } }).ticks.maxTicksLimit,
    );
    // Axe vertical de largeur fixe : la zone de tracé démarre au même endroit, quels que soient les libellés.
    const width = (scale: object): number => {
      const axis = { width: 0 };
      (scale as { afterFit: (a: { width: number }) => void }).afterFit(axis);
      return axis.width;
    };
    expect(width(index['y']!)).toBeGreaterThan(0);
    expect(width(index['y']!)).toBe(width(power['y']!));
  });

  it('s’étend jusqu’à maintenant passé 22 h, pour les deux courbes', () => {
    const day = new Date(2026, 9, 28).getTime();
    const late = new Date(2026, 9, 28, 23, 10).getTime();
    const colors = chartColors('light');
    expect(todayChart(curve, ['importOff'], late)(colors).options!.scales!['x']!.max).toBe(late);
    expect(dayCurveChart([], day, late)(colors).options!.scales!['x']!.max).toBe(late);
    expect(dayCurveChart([], day, null)(colors).options!.scales!['x']!.max).toBe(new Date(2026, 9, 28, 22).getTime());
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
