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
  recentAveragePower,
  recentPoints,
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

describe('puissances moyennes des dernières minutes', () => {
  it('moyenne le soutirage sur les 5 dernières minutes', () => {
    // 0,01 kWh par minute = 600 W.
    const log = feed(EMPTY_METER_LOG, '2026-10-28T08:00', 20);
    expect(recentAveragePower(log, ms('2026-10-28T08:19'))).toEqual({
      importW: 600,
      exportW: 0,
      from: '2026-10-28T08:14',
      to: '2026-10-28T08:19',
    });
  });

  it('sépare soutirage et injection, heures pleines et creuses additionnées', () => {
    let log = appendMeterLog(EMPTY_METER_LOG, point('2026-10-28T12:00', 100, 200), ms('2026-10-28T12:00'));
    log = appendMeterLog(
      log,
      { at: '2026-10-28T12:05', importPeak: 100.02, importOff: 50.01, exportPeak: 200.1, exportOff: 300.05 },
      ms('2026-10-28T12:05'),
    );
    expect(recentAveragePower(log, ms('2026-10-28T12:05'))).toMatchObject({ importW: 360, exportW: 1800 });
  });

  it('prend la durée réellement écoulée quand des minutes manquent', () => {
    let log = appendMeterLog(EMPTY_METER_LOG, point('2026-10-28T08:00', 100), ms('2026-10-28T08:00'));
    log = appendMeterLog(log, point('2026-10-28T08:04', 100.03), ms('2026-10-28T08:04'));
    log = appendMeterLog(log, point('2026-10-28T08:10', 100.1), ms('2026-10-28T08:10'));
    // De 08:04 à 08:10 : 0,07 kWh en 6 minutes = 700 W.
    expect(recentAveragePower(log, ms('2026-10-28T08:10'))).toMatchObject({
      importW: 700,
      from: '2026-10-28T08:04',
    });
  });

  it('ne renvoie rien avec moins de 5 minutes de lectures', () => {
    const log = feed(EMPTY_METER_LOG, '2026-10-28T08:00', 5);
    expect(recentAveragePower(log, ms('2026-10-28T08:04'))).toBeNull();
    expect(recentAveragePower(EMPTY_METER_LOG, ms('2026-10-28T08:04'))).toBeNull();
  });

  it('ne renvoie rien si la dernière lecture est trop ancienne', () => {
    const log = feed(EMPTY_METER_LOG, '2026-10-28T08:00', 10);
    expect(recentAveragePower(log, ms('2026-10-28T08:19'))).not.toBeNull();
    expect(recentAveragePower(log, ms('2026-10-28T08:20'))).toBeNull();
  });
});
