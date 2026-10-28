import {
  emptyData,
  type AppData,
  type MeterLog,
  type MeterLogPoint,
  type MeterReading,
  type PvDay,
} from '../models/app-data.model';
import { analyze } from './analysis';
import {
  EMPTY_METER_LOG,
  appendMeterLog,
  lastLogAt,
  meterLogReadings,
  mergeMeterLogs,
  recentPoints,
  todayCurve,
} from './meter-log';
import { toDayNumber } from './time';

const point = (at: string, importPeak = 100, exportPeak = 200): MeterLogPoint => ({
  at,
  importPeak,
  importOff: 50,
  exportPeak,
  exportOff: 300,
});

const ms = (iso: string): number => {
  const [d, t] = iso.split('T') as [string, string];
  const [y, mo, da] = d.split('-').map(Number) as [number, number, number];
  const [h, mi] = t.split(':').map(Number) as [number, number];
  return new Date(y, mo - 1, da, h, mi).getTime();
};

/** Ajoute une lecture par minute de `from` (inclus) pendant `count` minutes. */
function feed(log: MeterLog, from: string, count: number, kwhPerMinute = 0.01): MeterLog {
  let current = log;
  const start = ms(from);
  for (let i = 0; i < count; i++) {
    const at = new Date(start + i * 60_000);
    const iso = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}T${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
    current = appendMeterLog(current, point(iso, 100 + i * kwhPerMinute), at.getTime());
  }
  return current;
}

describe('journal des index du lecteur P1', () => {
  it('garde les minutes de la dernière heure, une lecture par heure du jour et une par jour', () => {
    const log = feed(EMPTY_METER_LOG, '2026-10-28T06:00', 180);
    expect(log.minutes).toHaveLength(61);
    expect(log.minutes[0]!.at).toBe('2026-10-28T07:59');
    expect(log.minutes.at(-1)!.at).toBe('2026-10-28T08:59');
    expect(log.hours.map((p) => p.at)).toEqual([
      '2026-10-28T06:59',
      '2026-10-28T07:59',
      '2026-10-28T08:59',
    ]);
    expect(log.days.map((p) => p.at)).toEqual(['2026-10-28T08:59']);
  });

  it('oublie les heures de la veille et garde la dernière lecture de chaque jour', () => {
    let log = feed(EMPTY_METER_LOG, '2026-10-27T22:30', 60);
    log = appendMeterLog(log, point('2026-10-28T07:00', 120), ms('2026-10-28T07:00'));
    expect(log.hours.map((p) => p.at)).toEqual(['2026-10-28T07:00']);
    expect(log.days.map((p) => p.at)).toEqual(['2026-10-27T23:29', '2026-10-28T07:00']);
    expect(log.minutes.map((p) => p.at)).toEqual(['2026-10-28T07:00']);
  });

  it('ignore une lecture plus ancienne et remplace celle de la même minute', () => {
    let log = appendMeterLog(
      EMPTY_METER_LOG,
      point('2026-10-28T08:00', 100),
      ms('2026-10-28T08:00'),
    );
    expect(appendMeterLog(log, point('2026-10-28T07:59', 99), ms('2026-10-28T08:00'))).toBe(log);
    log = appendMeterLog(log, point('2026-10-28T08:00', 101), ms('2026-10-28T08:00'));
    expect(log.minutes.map((p) => p.importPeak)).toEqual([101]);
    expect(lastLogAt(log)).toBe('2026-10-28T08:00');
    expect(lastLogAt(EMPTY_METER_LOG)).toBeNull();
  });

  it('fournit un relevé quotidien pour l’analyse', () => {
    const log = feed(EMPTY_METER_LOG, '2026-10-27T23:58', 3);
    expect(meterLogReadings(log, [])).toEqual([
      {
        id: 'p1-2026-10-27',
        date: '2026-10-27T23:59',
        importPeak: 100.01,
        importOff: 50,
        exportPeak: 200,
        exportOff: 300,
        pvTotal: null,
        meterChange: false,
        source: 'auto',
        note: '',
      },
      expect.objectContaining({ id: 'p1-2026-10-28', date: '2026-10-28T00:00', source: 'auto' }),
    ]);
  });

  it('reprend l’index de l’onduleur lu le même jour sans production notable entre les deux lectures', () => {
    const log: MeterLog = {
      minutes: [],
      hours: [],
      days: [point('2026-10-26T23:59'), point('2026-10-27T13:45'), point('2026-10-28T13:00')],
    };
    const pv = (date: string, time: string, totalKwh: number): PvDay => ({
      date,
      dayKwh: 10,
      totalKwh,
      at: `${date}T${time}`,
    });
    const readings = meterLogReadings(log, [
      // Dernière lecture de l'onduleur après le coucher du soleil : l'index est celui de minuit.
      pv('2026-10-26', '22:49', 32081.276),
      // Lectures quasi simultanées en journée.
      pv('2026-10-27', '13:44', 32093.5),
      // Deux heures d'écart en pleine journée : trop de production entre les deux.
      pv('2026-10-28', '11:00', 32110),
    ]);
    expect(readings.map((r) => r.pvTotal)).toEqual([32081.276, 32093.5, null]);
    expect(meterLogReadings(log, []).map((r) => r.pvTotal)).toEqual([null, null, null]);
  });

  it('alimente les prévisions : elles partent des index lus par le lecteur P1', () => {
    const manual = (date: string, base: number, pvTotal: number): MeterReading => ({
      id: date,
      date,
      importPeak: base,
      importOff: base / 2,
      exportPeak: base * 2,
      exportOff: base * 3,
      pvTotal,
      meterChange: false,
      source: 'manual',
      note: '',
    });
    const data: AppData = {
      ...emptyData(),
      readings: [
        manual('2026-08-01T20:00', 100, 1000),
        manual('2026-09-01T20:00', 200, 1500),
        manual('2026-10-01T20:00', 300, 1900),
      ],
      meterLog: {
        minutes: [],
        hours: [],
        days: [
          { at: '2026-10-27T23:59', importPeak: 390, importOff: 195, exportPeak: 780, exportOff: 1170 },
        ],
      },
      pvDaily: [{ date: '2026-10-27', dayKwh: 8, totalKwh: 2200, at: '2026-10-27T21:30' }],
    };
    const now = toDayNumber('2026-10-28T08:00');
    const a = analyze({ ...data, readings: [...data.readings, ...meterLogReadings(data.meterLog, data.pvDaily)] }, now);
    const last = a.consumption.intervals.at(-1)!;
    expect(a.lastIndices).toEqual({ importPeak: 390, importOff: 195, exportPeak: 780, exportOff: 1170 });
    expect(a.windowEnd).toBe(toDayNumber('2026-10-27T23:59'));
    expect(last.delta.pv).toBeCloseTo(300, 6);
    expect(a.base.best).not.toBeNull();
  });

  it('donne au graphique des index une lecture par heure du jour, puis chaque minute de la dernière heure', () => {
    const log = feed(EMPTY_METER_LOG, '2026-10-27T23:30', 24 * 60);
    const now = ms('2026-10-28T23:29');
    const points = recentPoints(log, now).map((p) => p.at);
    // Heures de la veille exclues ; une lecture par heure aujourd'hui ; les minutes de la dernière heure.
    expect(points[0]).toBe('2026-10-28T00:59');
    expect(points.filter((at) => at.endsWith(':59'))).toHaveLength(23);
    expect(points.filter((at) => at >= '2026-10-28T22:29')).toHaveLength(61);
    expect(points.at(-1)).toBe('2026-10-28T23:29');
    expect(new Set(points).size).toBe(points.length);
    // Application rouverte le lendemain : rien du jour précédent.
    expect(recentPoints(log, ms('2026-10-29T08:00'))).toEqual([]);
  });

  it('fusionne les jours importés sans toucher aux minutes ni aux heures locales', () => {
    const local: MeterLog = {
      minutes: [point('2026-10-28T08:00')],
      hours: [point('2026-10-28T08:00')],
      days: [point('2026-10-27T18:00'), point('2026-10-28T08:00')],
    };
    const incoming: MeterLog = {
      minutes: [point('2026-10-28T09:00')],
      hours: [],
      days: [point('2026-10-26T23:59'), point('2026-10-27T23:59'), point('2026-10-28T07:00')],
    };
    const { log, added } = mergeMeterLogs(local, incoming);
    expect(added).toBe(2);
    expect(log.days.map((p) => p.at)).toEqual([
      '2026-10-26T23:59',
      '2026-10-27T23:59',
      '2026-10-28T08:00',
    ]);
    expect(log.minutes).toBe(local.minutes);
    expect(log.hours).toBe(local.hours);
  });
});

describe('courbe du jour en cours', () => {
  it('compte depuis minuit quand la veille finit après 23 h', () => {
    let log = feed(EMPTY_METER_LOG, '2026-10-27T23:50', 10);
    log = feed(log, '2026-10-28T00:00', 600);
    const curve = todayCurve(log, ms('2026-10-28T09:59'))!;
    expect(curve.fromMidnight).toBe(true);
    expect(curve.start).toBe('2026-10-28T00:00');
    expect(curve.points[0]).toEqual({
      at: '2026-10-28T00:00',
      values: { importPeak: 0, importOff: 0, exportPeak: 0, exportOff: 0 },
    });
    // Minuit, les heures 00:59 … 08:59, puis les minutes 08:59 … 09:59 (08:59 et 09:59 sans doublon).
    expect(curve.points.filter((p) => p.at === '2026-10-28T09:59')).toHaveLength(1);
    expect(curve.points).toHaveLength(1 + 9 + 60);
    expect(curve.lastAt).toBe('2026-10-28T09:59');
    // De 23:59 la veille (100,09) à 09:59 (100 + 599 × 0,01) : 5,9 kWh.
    expect(curve.totals.importPeak).toBeCloseTo(5.9, 3);
    expect(curve.totals.importOff).toBe(0);
  });

  it('part de la première lecture du jour si la veille manque', () => {
    const log = feed(EMPTY_METER_LOG, '2026-10-28T08:00', 31);
    const curve = todayCurve(log, ms('2026-10-28T08:30'))!;
    expect(curve.fromMidnight).toBe(false);
    expect(curve.start).toBe('2026-10-28T08:00');
    expect(curve.points[0]!.values.importPeak).toBe(0);
    expect(curve.totals.importPeak).toBeCloseTo(0.3, 3);
  });

  it('ne part pas de minuit si la dernière lecture de la veille est trop ancienne', () => {
    let log = appendMeterLog(
      EMPTY_METER_LOG,
      point('2026-10-27T18:00', 90),
      ms('2026-10-27T18:00'),
    );
    log = appendMeterLog(log, point('2026-10-28T08:00', 100), ms('2026-10-28T08:00'));
    expect(todayCurve(log, ms('2026-10-28T08:00'))!.fromMidnight).toBe(false);
  });

  it('ne renvoie rien sans lecture aujourd’hui', () => {
    const log = feed(EMPTY_METER_LOG, '2026-10-27T10:00', 5);
    expect(todayCurve(log, ms('2026-10-28T08:00'))).toBeNull();
    expect(todayCurve(EMPTY_METER_LOG, ms('2026-10-28T08:00'))).toBeNull();
  });
});
