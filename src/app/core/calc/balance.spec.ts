import { describe, expect, it } from 'vitest';
import { emptyData, type MeterReading } from '../models/app-data.model';
import { analyze } from './analysis';
import { balanceSeries, billingCost, billingYearStart, heaterAllowance, winterBudget } from './balance';
import { toDayNumber } from './time';

function reading(
  date: string,
  importPeak: number,
  importOff: number,
  exportPeak: number,
  exportOff: number,
  meterChange = false,
): MeterReading {
  return {
    id: date,
    date,
    importPeak,
    importOff,
    exportPeak,
    exportOff,
    pvTotal: null,
    meterChange,
    source: 'manual',
    note: '',
  };
}

function series(readings: MeterReading[], now: string, until: string, billingStart = '11-01') {
  const a = analyze({ ...emptyData(), readings }, toDayNumber(now));
  return balanceSeries(a.consumption, a.weights, a.base.best, billingStart, toDayNumber(until), toDayNumber(now));
}

describe('billingYearStart', () => {
  it('donne le dernier début d’année de facturation', () => {
    expect(billingYearStart(toDayNumber('2026-10-27'), '11-01')).toBe(toDayNumber('2025-11-01'));
    expect(billingYearStart(toDayNumber('2026-11-01'), '11-01')).toBe(toDayNumber('2026-11-01'));
    expect(billingYearStart(toDayNumber('2026-03-15T08:00'), '01-01')).toBe(toDayNumber('2026-01-01'));
  });
});

describe('balanceSeries', () => {
  it('calcule les soldes HP et HC entre relevés de la même année', () => {
    const s = series(
      [reading('2026-10-09T20:00', 100, 200, 300, 400), reading('2026-10-22T20:00', 273, 271, 316, 487)],
      '2026-10-23T12:00',
      '2026-10-23T12:00',
    );
    const last = s.history.at(-1)!;
    expect(last.hp).toBeCloseTo(173 - 16, 6);
    expect(last.hc).toBeCloseTo(71 - 87, 6);
    expect(s.history[0]).toMatchObject({ hp: 0, hc: 0 });
  });

  it('remet les soldes à zéro au début de l’année de facturation, sans rien perdre', () => {
    const readings = [
      reading('2026-10-09T20:00', 100, 200, 300, 400),
      reading('2026-11-20T20:00', 400, 400, 320, 500),
    ];
    const s = series(readings, '2026-11-21T12:00', '2026-11-21T12:00');
    const boundary = toDayNumber('2026-11-01');
    const atBoundary = s.history.filter((p) => p.day === boundary);
    expect(atBoundary).toHaveLength(2);
    expect(atBoundary[0]!.kind).toBe('yearEnd');
    expect(atBoundary[1]).toMatchObject({ hp: 0, hc: 0, kind: 'yearStart' });
    const last = s.history.at(-1)!;
    // Fin d'année + début de la suivante = écart total entre les deux relevés.
    expect(atBoundary[0]!.hp + last.hp).toBeCloseTo(300 - 20, 6);
    expect(atBoundary[0]!.hc + last.hc).toBeCloseTo(200 - 100, 6);
  });

  it('ignore l’intervalle d’un changement de compteur', () => {
    const s = series(
      [
        reading('2026-02-01T20:00', 5000, 4000, 8000, 9000),
        reading('2026-03-01T20:00', 20, 10, 30, 40, true),
        reading('2026-04-01T20:00', 120, 60, 80, 140),
      ],
      '2026-04-02T12:00',
      '2026-04-02T12:00',
      '01-01',
    );
    const last = s.history.at(-1)!;
    expect(last.hp).toBeCloseTo(100 - 50, 6);
    expect(last.hc).toBeCloseTo(50 - 100, 6);
  });

  it('prolonge les soldes par la prévision, remis à zéro au 1er novembre, et résume les deux années', () => {
    const readings = [
      reading('2025-11-05T20:00', 0, 0, 0, 0),
      reading('2026-02-05T20:00', 450, 300, 40, 60),
      reading('2026-05-05T20:00', 700, 520, 300, 700),
      reading('2026-08-05T20:00', 900, 700, 650, 1500),
      reading('2026-10-22T20:00', 1100, 830, 800, 1800),
    ];
    const s = series(readings, '2026-10-27T12:00', '2027-10-27T12:00');
    expect(s.forecast.length).toBeGreaterThan(40);
    const reset = s.forecast.filter((p) => p.day === toDayNumber('2026-11-01'));
    expect(reset.map((p) => p.kind)).toEqual(['yearEnd', 'yearStart']);
    expect(reset.at(-1)).toMatchObject({ hp: 0, hc: 0 });
    // Le solde facturé affiché est celui de la fin d'année prévue dans le résumé.
    expect(reset[0]!.hp).toBeCloseTo(s.years[0]!.hp, 6);
    expect(s.years).toHaveLength(2);
    expect(s.years[0]).toMatchObject({ forecast: true, start: toDayNumber('2025-11-01') });
    expect(s.years[0]!.coveredFrom).toBe(toDayNumber('2025-11-05T20:00'));
    // Fin de l'année en cours : proche du dernier solde mesuré (5 jours de prévision seulement).
    expect(s.years[0]!.hp).toBeGreaterThan(300 - 1);
    expect(s.years[0]!.hp).toBeLessThan(300 + 40);
    expect(s.years[1]).toMatchObject({ forecast: true, coveredFrom: null, start: toDayNumber('2026-11-01') });
    expect(Number.isFinite(s.years[1]!.hc)).toBe(true);
  });

  describe('courbe limite', () => {
    const readings = [
      reading('2025-11-05T20:00', 0, 0, 0, 0),
      reading('2026-02-05T20:00', 450, 300, 40, 60),
      reading('2026-05-05T20:00', 700, 520, 300, 700),
      reading('2026-08-05T20:00', 900, 700, 650, 1500),
      reading('2026-10-22T20:00', 1100, 830, 800, 1800),
    ];
    const s = series(readings, '2026-10-27T12:00', '2027-11-05T12:00');

    it('vaut zéro à chaque fin d’année et repart à la facturation', () => {
      const ends = s.limit.filter((p) => p.kind === 'yearEnd');
      expect(ends.map((p) => p.day)).toEqual([toDayNumber('2026-11-01'), toDayNumber('2027-11-01')]);
      // Zéro, ou absente pour une période sans plafond tenable cette année-là.
      expect(ends.every((p) => (p.hp === 0 || p.hp === null) && (p.hc === 0 || p.hc === null))).toBe(true);
      const restart = s.limit.find((p) => p.kind === 'yearStart')!;
      expect(restart.day).toBe(toDayNumber('2026-11-01'));
      expect(s.limit[0]!.day).toBe(toDayNumber('2025-11-01'));
    });

    it('donne une marge égale au solde de fin d’année prévu, changé de signe', () => {
      // Année à venir : marge au 1er novembre = ce que la prévision laisse en fin d'année.
      const next = s.years[1]!;
      expect(next.margin!.day).toBe(toDayNumber('2026-11-01'));
      expect(next.margin!.hp).toBeCloseTo(-next.hp, 0);
      expect(next.margin!.hc).toBeCloseTo(-next.hc, 0);
      // Année en cours : marge au dernier relevé, qui tient compte du solde mesuré.
      const current = s.years[0]!;
      expect(current.margin!.day).toBe(toDayNumber('2026-10-22T20:00'));
      expect(current.margin!.hc).toBeCloseTo(-current.hc, 0);
    });

    it('place le plafond de l’année à venir en fin d’hiver, quand le surplus d’été reste à venir', () => {
      const { ceiling } = s.years[1]!;
      expect(ceiling!.hc).toBeGreaterThan(0);
      expect(ceiling!.hcDay).toBeGreaterThan(toDayNumber('2027-01-15'));
      expect(ceiling!.hcDay).toBeLessThan(toDayNumber('2027-05-15'));
    });

    it('reste au plafond pendant l’hiver, puis suit ce que l’été peut effacer', () => {
      const next = s.years[1]!;
      const year = s.limit.filter((p) => p.day >= next.start);
      const day = next.ceiling!.hcDay!;
      const winter = year.filter((p) => p.day >= next.start && p.day < day && p.kind !== 'yearEnd');
      expect(winter.length).toBeGreaterThan(5);
      expect(winter.every((p) => p.hc === next.ceiling!.hc)).toBe(true);
      // Après le plafond, la limite ne remonte plus.
      const after = year.filter((p) => p.day >= day && p.kind !== 'yearEnd').map((p) => p.hc!);
      expect(after.every((v, i) => i === 0 || v <= after[i - 1]! + 1e-9)).toBe(true);
    });

    it('démarre au changement de compteur, et n’existe pas sans prévision', () => {
      const changed = series(
        [
          reading('2026-02-01T20:00', 5000, 4000, 8000, 9000),
          reading('2026-05-01T12:00', 0, 0, 0, 0, true),
          reading('2026-10-22T20:00', 300, 200, 400, 900),
        ],
        '2026-10-27T12:00',
        '2027-11-05T12:00',
      );
      expect(changed.limit[0]!.day).toBe(toDayNumber('2026-05-01T12:00'));
      const a = analyze({ ...emptyData(), readings }, toDayNumber('2026-10-27T12:00'));
      const none = balanceSeries(a.consumption, a.weights, null, '11-01', toDayNumber('2027-01-01'), toDayNumber('2026-10-27'));
      expect(none.limit).toEqual([]);
    });
  });

  it('donne le mesuré de l’année à ce jour, au dernier relevé', () => {
    const s = series(
      [
        reading('2026-10-09T20:00', 100, 200, 300, 400),
        reading('2026-10-14T20:00', 150, 220, 305, 440),
        reading('2026-10-22T20:00', 240, 260, 312, 480),
        reading('2026-10-25T18:15', 300.5, 290.25, 315, 490.5),
        reading('2026-10-27T13:45', 310.75, 300.5, 320.25, 500.75),
      ],
      '2026-10-27T15:00',
      '2027-11-01',
    );
    const toDate = s.years[0]!.toDate!;
    expect(toDate.day).toBe(toDayNumber('2026-10-27T13:45'));
    expect(toDate.importPeak).toBeCloseTo(210.75, 6);
    expect(toDate.exportPeak).toBeCloseTo(20.25, 6);
    expect(toDate.hp).toBeCloseTo(190.5, 6);
    expect(toDate.hc).toBeCloseTo(100.5 - 100.75, 6);
    // L'année suivante n'a pas encore de relevé.
    expect(s.years[1]!.toDate).toBeNull();
  });

  it('solde l’ancien compteur au changement de compteur : l’année repart du nouveau', () => {
    const s = series(
      [
        reading('2025-11-15T20:00', 5000, 3000, 7000, 9000),
        reading('2026-03-01T20:00', 5600, 3400, 7100, 9200),
        reading('2026-05-01T00:00', 0, 0, 0, 0, true),
        reading('2026-10-09T20:00', 100, 50, 300, 700),
      ],
      '2026-10-27T12:00',
      '2027-11-01',
    );
    const year = s.years[0]!;
    expect(year.start).toBe(toDayNumber('2025-11-01'));
    expect(year.settledFrom).toBe(toDayNumber('2026-05-01T00:00'));
    expect(year.coveredFrom).toBeNull();
    // À ce jour : seulement le nouveau compteur.
    expect(year.toDate!.hp).toBeCloseTo(100 - 300, 6);
    expect(year.toDate!.hc).toBeCloseTo(50 - 700, 6);
    // Solde de clôture de l'ancien compteur au changement, puis départ à zéro.
    const atChange = s.history.filter((p) => p.day === toDayNumber('2026-05-01T00:00'));
    expect(atChange.map((p) => p.kind)).toEqual(['yearEnd', 'yearStart']);
    expect(atChange[0]!.hp).toBeGreaterThan(400);
    expect(s.history.at(-1)!.hp).toBeCloseTo(-200, 6);
    expect(s.years[1]!.settledFrom).toBeNull();
  });

  it('chiffre le coût des seuls soldes positifs', () => {
    expect(billingCost(100, -50, { hp: 0.34, hc: 0.24 })).toEqual({
      hp: 34,
      hc: 0,
      total: 34,
      surplusKwh: 50,
    });
    const both = billingCost(10, 20, { hp: 0.3, hc: 0.2 });
    expect(both.total).toBeCloseTo(7, 6);
    expect(both.surplusKwh).toBe(0);
  });

  it('ne donne rien avec moins de deux relevés', () => {
    expect(series([reading('2026-10-09T20:00', 1, 1, 1, 1)], '2026-10-10T12:00', '2027-01-01')).toEqual({
      history: [],
      forecast: [],
      limit: [],
      years: [],
    });
  });
});

describe('heaterAllowance', () => {
  it('convertit la marge en heures de radiateur, réparties jusqu’à la fin de la saison de chauffe', () => {
    const from = toDayNumber('2026-11-01');
    const a = heaterAllowance(480, 2.4, from, toDayNumber('2027-11-01'), 4);
    expect(a.hours).toBeCloseTo(200, 6);
    expect(a.until).toBe(toDayNumber('2027-05-01'));
    expect(a.weeks).toBeCloseTo(181 / 7, 6);
    expect(a.hoursPerWeek).toBeCloseTo(200 / (181 / 7), 6);
  });

  it('ne donne aucune heure sans marge, et s’arrête à la fin de l’année de facturation', () => {
    expect(heaterAllowance(-50, 2.4, toDayNumber('2026-11-01'), toDayNumber('2027-11-01'), 4).hours).toBe(0);
    // Saison qui enjambe le nouvel an, vue en été : la fin d'année de facturation arrive avant la fin de saison.
    const summer = heaterAllowance(100, 2, toDayNumber('2027-07-01'), toDayNumber('2027-11-01'), 4);
    expect(summer.until).toBe(toDayNumber('2027-11-01'));
    // Moins d'une semaine : au moins une semaine pour la répartition.
    expect(heaterAllowance(100, 2, toDayNumber('2026-10-30'), toDayNumber('2026-11-01'), 4).weeks).toBe(1);
  });
});

describe('winterBudget', () => {
  const exact = [
    { day: 0, hp: -300, hc: 200 },
    { day: 50, hp: -100, hc: 600 },
    { day: 100, hp: 200, hc: 900 },
    { day: 200, hp: 50, hc: 300 },
    { day: 300, hp: 0, hc: 0 },
  ];

  it('trace une droite horizontale au plafond jusqu’à la bascule, puis la limite exacte', () => {
    expect(winterBudget(exact, 'hp')).toEqual({ values: [200, 200, 200, 50, 0], ceiling: 200, ceilingDay: 100 });
    expect(winterBudget(exact, 'hc').values).toEqual([900, 900, 900, 300, 0]);
  });

  it('ne donne pas de limite sans plafond au-dessus de zéro', () => {
    const never = exact.map((p) => ({ ...p, hp: -p.day }));
    expect(winterBudget(never, 'hp')).toEqual({ values: [null, null, null, null, null], ceiling: null, ceilingDay: null });
  });
});
