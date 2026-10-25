import {
  DEFAULT_HOUSE,
  DEFAULT_SETTINGS,
  LEGACY_OFF_PEAK,
  WALLONIA_2026_OFF_PEAK,
  pvKwp,
  type House,
  type Settings,
} from '../models/app-data.model';
import { evAnnualKwh, evDelta } from './ev';
import { loadShape, referenceProfile, seriesWeights } from './reference';
import { sunShape } from './solar';
import { toDayNumber } from './time';

const sum = (v: readonly number[]): number => v.reduce((a, b) => a + b, 0);

function build(
  houseOver: (h: House) => void = () => undefined,
  settingsOver: Partial<Settings> = {},
) {
  const house = structuredClone(DEFAULT_HOUSE);
  houseOver(house);
  const settings = { ...DEFAULT_SETTINGS, ...settingsOver };
  return { house, settings, ref: referenceProfile(house, settings) };
}

const selfPct = (r: ReturnType<typeof referenceProfile>): number =>
  (r.annual.selfConsumed / r.annual.production) * 100;
const autarkyPct = (r: ReturnType<typeof referenceProfile>): number =>
  (r.annual.selfConsumed / r.annual.consumption) * 100;
const hcShare = (r: ReturnType<typeof referenceProfile>): number =>
  (sum(r.registers.importOff) / sum([...r.registers.importPeak, ...r.registers.importOff])) * 100;

describe('installation de la maison : 16 panneaux de 400 Wc, onduleur triphasé de 5 kVA', () => {
  it('16 × 400 Wc = 6,4 kWc, avec un onduleur de 5 kVA', () => {
    expect(pvKwp(DEFAULT_HOUSE.pv)).toBeCloseTo(6.4, 6);
    expect(DEFAULT_HOUSE.pv.inverterKva).toBe(5);
    expect(DEFAULT_HOUSE.pv.inverterPhases).toBe(3);
  });

  it('conserve l’énergie : production + soutirage = consommation + injection, production = potentiel − écrêtage', () => {
    const { ref, settings } = build();
    const a = ref.annual;
    // Bilan du point de raccordement : ce qui est produit ou soutiré est consommé (radiateur compris) ou injecté.
    expect(a.production + a.import).toBeCloseTo(a.consumption + a.ev + a.export, 3);
    expect(a.selfConsumed + a.export).toBeCloseTo(a.production, 3);
    expect(a.selfConsumed + a.import).toBeCloseTo(a.consumption + a.ev, 3);
    expect(a.production + a.clipped).toBeCloseTo(6.4 * settings.specificYieldKwhPerKwp, 3);
  });

  it('donne des ordres de grandeur réalistes pour une famille de 4 avec 6,4 kWc', () => {
    const { ref } = build();
    expect(ref.annual.consumption).toBeGreaterThan(3500);
    expect(ref.annual.consumption).toBeLessThan(4300);
    expect(selfPct(ref)).toBeGreaterThan(20);
    expect(selfPct(ref)).toBeLessThan(40);
    expect(autarkyPct(ref)).toBeGreaterThan(28);
    expect(autarkyPct(ref)).toBeLessThan(50);
    // Bihoraire wallon 2026 : nuit et midi en heures creuses, pointe du soir en heures pleines.
    expect(hcShare(ref)).toBeGreaterThan(25);
    expect(hcShare(ref)).toBeLessThan(50);
  });

  it('l’été injecte plus qu’il ne soutire, l’hiver l’inverse', () => {
    const { ref } = build();
    const imp = (m: number): number => ref.registers.importPeak[m]! + ref.registers.importOff[m]!;
    const exp = (m: number): number => ref.registers.exportPeak[m]! + ref.registers.exportOff[m]!;
    for (const m of [11, 0, 1]) {
      expect(imp(m)).toBeGreaterThan(exp(m));
    }
    for (const m of [4, 5, 6, 7]) {
      expect(exp(m)).toBeGreaterThan(imp(m));
    }
  });

  it('la phase de l’onduleur ne change pas l’énergie', () => {
    const one = build((h) => (h.pv.inverterPhases = 1)).ref;
    const three = build((h) => (h.pv.inverterPhases = 3)).ref;
    expect(one.annual).toEqual(three.annual);
  });
});

describe('écrêtage de l’onduleur', () => {
  it('perd 1 à 3,5 % de la production annuelle avec 6,4 kWc sur 5 kVA, surtout en été', () => {
    const { ref } = build();
    const potential = ref.annual.production + ref.annual.clipped;
    const loss = (ref.annual.clipped / potential) * 100;
    expect(loss).toBeGreaterThan(1);
    expect(loss).toBeLessThan(3.5);
    const june = ref.clipped[5]!;
    const december = ref.clipped[11]!;
    expect(june).toBeGreaterThan(5);
    expect(december).toBe(0);
    expect(Math.max(...ref.clipped)).toBeGreaterThan(ref.clipped[0]! + ref.clipped[1]!);
  });

  it('ne perd rien si l’onduleur est assez puissant ou les panneaux modestes', () => {
    expect(build((h) => (h.pv.inverterKva = 10)).ref.annual.clipped).toBeCloseTo(0, 6);
    expect(build((h) => (h.pv.panelCount = 10)).ref.annual.clipped).toBeLessThan(5);
  });

  it('perd davantage quand l’onduleur est plus petit', () => {
    const at = (kva: number): number => build((h) => (h.pv.inverterKva = kva)).ref.annual.clipped;
    expect(at(3)).toBeGreaterThan(at(4));
    expect(at(4)).toBeGreaterThan(at(5));
    expect(at(5)).toBeGreaterThan(at(6));
  });

  it('l’écrêtage réduit l’injection, pas le soutirage', () => {
    const small = build((h) => (h.pv.inverterKva = 3)).ref;
    const large = build((h) => (h.pv.inverterKva = 10)).ref;
    expect(sum(small.registers.exportPeak) + sum(small.registers.exportOff)).toBeLessThan(
      sum(large.registers.exportPeak) + sum(large.registers.exportOff) - 100,
    );
    expect(small.annual.import).toBeCloseTo(large.annual.import, 0);
  });
});

describe('radiateur électrique d’appoint branché sur le surplus', () => {
  const without = build((h) => (h.surplusHeater.enabled = false)).ref;
  const withHeater = build().ref;

  it('consomme du surplus : l’autoconsommation monte, l’injection baisse d’autant, le soutirage ne bouge pas', () => {
    const absorbed = withHeater.annual.heater;
    expect(absorbed).toBeGreaterThan(150);
    expect(absorbed).toBeLessThan(600);
    expect(withHeater.annual.selfConsumed - without.annual.selfConsumed).toBeCloseTo(absorbed, 3);
    expect(without.annual.export - withHeater.annual.export).toBeCloseTo(absorbed, 3);
    expect(withHeater.annual.import).toBeCloseTo(without.annual.import, 3);
    expect(withHeater.annual.consumption - without.annual.consumption).toBeCloseTo(absorbed, 3);
  });

  it('n’agit qu’entre octobre et avril', () => {
    for (const m of [4, 5, 6, 7, 8]) {
      expect(withHeater.heater[m]).toBe(0);
    }
    expect(withHeater.heater[9]).toBeGreaterThan(0);
    expect(withHeater.heater[3]).toBeGreaterThan(0);
    expect(withHeater.heater[2]).toBeGreaterThan(withHeater.heater[11]!);
  });

  it('ne dépasse jamais le surplus disponible du mois', () => {
    for (let m = 0; m < 12; m++) {
      const surplus = without.registers.exportPeak[m]! + without.registers.exportOff[m]!;
      expect(withHeater.heater[m]!).toBeLessThanOrEqual(surplus + 1e-6);
    }
  });

  it('absorbe davantage si on le branche plus souvent, plus rien s’il est éteint ou s’il est trop puissant', () => {
    const usage = (pct: number): number =>
      build((h) => (h.surplusHeater.usagePct = pct)).ref.annual.heater;
    expect(usage(100)).toBeGreaterThan(usage(50));
    expect(usage(50)).toBeGreaterThan(usage(10));
    expect(usage(0)).toBe(0);
    // 5 kW dépasse presque toujours le surplus d'octobre à avril avec 6,4 kWc.
    expect(build((h) => (h.surplusHeater.powerKw = 5)).ref.annual.heater).toBeLessThan(
      withHeater.annual.heater,
    );
    expect(build((h) => (h.surplusHeater.powerKw = 1)).ref.annual.heater).toBeGreaterThan(0);
  });

  it('suit la période choisie, y compris à cheval sur le nouvel an', () => {
    const summer = build((h) => {
      h.surplusHeater.startMonth = 5;
      h.surplusHeater.endMonth = 8;
    }).ref;
    expect(summer.heater[0]).toBe(0);
    expect(summer.heater[6]).toBeGreaterThanOrEqual(0);
    expect(summer.heater[11]).toBe(0);
  });
});

describe('présence, heures creuses et réglages', () => {
  it('plus on est présent en journée, plus on autoconsomme', () => {
    const at = (presence: Settings['presence']): number =>
      selfPct(build(() => undefined, { presence }).ref);
    expect(at('absent')).toBeLessThan(at('partial'));
    expect(at('partial')).toBeLessThan(at('home'));
  });

  const exportOffShare = (r: ReturnType<typeof referenceProfile>): number =>
    sum(r.registers.exportOff) / (sum(r.registers.exportOff) + sum(r.registers.exportPeak));

  it('ancien bihoraire : les week-ends en heures creuses portent environ 28 % de l’injection', () => {
    const legacy = { offPeakHours: [...LEGACY_OFF_PEAK], offPeakWeekends: true };
    const on = build(() => undefined, legacy).ref;
    const off = build(() => undefined, { ...legacy, offPeakWeekends: false }).ref;
    expect(exportOffShare(on)).toBeGreaterThan(0.2);
    expect(exportOffShare(on)).toBeLessThan(0.35);
    expect(exportOffShare(off)).toBeLessThan(0.03);
    expect(on.annual.import).toBeCloseTo(off.annual.import, 3);
  });

  it('bihoraire wallon 2026 (22 h-7 h et 11 h-17 h) : la majorité de l’injection tombe en heures creuses', () => {
    // Une installation solaire wallonne injecte alors surtout en heures creuses (2.8.2 bien au-dessus de 2.8.1).
    const wallonia = build(() => undefined, {
      offPeakHours: [...WALLONIA_2026_OFF_PEAK],
      offPeakWeekends: false,
    }).ref;
    expect(exportOffShare(wallonia)).toBeGreaterThan(0.55);
    expect(exportOffShare(wallonia)).toBeLessThan(0.85);
    // Le soutirage de midi passe aussi en heures creuses, mais la pointe du soir reste en heures pleines.
    expect(hcShare(wallonia)).toBeGreaterThan(25);
    expect(hcShare(wallonia)).toBeLessThan(45);
  });

  it('une nuit plus longue met plus de soutirage en heures creuses', () => {
    const night = (hours: number[]) =>
      hcShare(build(() => undefined, { offPeakHours: hours, offPeakWeekends: false }).ref);
    const base = night([22, 23, 0, 1, 2, 3, 4, 5, 6]);
    const longer = night([20, 21, 22, 23, 0, 1, 2, 3, 4, 5, 6, 7]);
    expect(longer).toBeGreaterThan(base + 5);
  });

  it('sans heures creuses, tout est compté en heures pleines', () => {
    const none = build(() => undefined, { offPeakHours: [], offPeakWeekends: false }).ref;
    expect(sum(none.registers.importOff) + sum(none.registers.exportOff)).toBe(0);
  });

  it('la consommation annuelle est respectée', () => {
    expect(
      build(() => undefined, { referenceAnnualKwh: 5000 }).ref.annual.consumption,
    ).toBeGreaterThan(5000);
    const lowHeater = build((h) => (h.surplusHeater.enabled = false), {
      referenceAnnualKwh: 2800,
    }).ref;
    expect(lowHeater.annual.consumption).toBeCloseTo(2800, 3);
  });

  it('les courbes horaires sont normalisées', () => {
    for (const presence of ['absent', 'partial', 'home'] as const) {
      expect(sum(loadShape(presence, false))).toBeCloseTo(1, 9);
      expect(sum(loadShape(presence, true))).toBeCloseTo(1, 9);
    }
    expect(Math.max(...sunShape(5))).toBeLessThanOrEqual(1);
    expect(sum(sunShape(5))).toBeGreaterThan(sum(sunShape(11)) * 1.5);
  });
});

describe('maisons comparables', () => {
  const profiles: { name: string; make: () => ReturnType<typeof build> }[] = [
    { name: 'famille de 4, 6,4 kWc, 3 500 kWh', make: () => build() },
    {
      name: 'ménage sobre, 4 kWc, 2 800 kWh',
      make: () =>
        build(
          (h) => {
            h.pv.panelCount = 10;
            h.pv.inverterKva = 4;
            h.surplusHeater.enabled = false;
          },
          { referenceAnnualKwh: 2800, referencePreset: 'sober' },
        ),
    },
    {
      name: 'ménage énergivore, 6,4 kWc, 5 000 kWh',
      make: () => build(() => undefined, { referenceAnnualKwh: 5000 }),
    },
    {
      name: 'grosse installation, 9,6 kWc / 8 kVA, 3 500 kWh',
      make: () =>
        build((h) => {
          h.pv.panelCount = 24;
          h.pv.inverterKva = 8;
        }),
    },
  ];

  it('garde des taux d’autoconsommation et d’autarcie plausibles sans batterie', () => {
    for (const { make } of profiles) {
      const { ref } = make();
      expect(selfPct(ref)).toBeGreaterThan(15);
      expect(selfPct(ref)).toBeLessThan(55);
      expect(autarkyPct(ref)).toBeGreaterThan(20);
      expect(autarkyPct(ref)).toBeLessThan(65);
    }
  });

  it('autoconsommation : monte avec la consommation, baisse avec la taille de l’installation', () => {
    const [base, sober, high, big] = profiles.map((p) => p.make().ref) as [
      ReturnType<typeof referenceProfile>,
      ReturnType<typeof referenceProfile>,
      ReturnType<typeof referenceProfile>,
      ReturnType<typeof referenceProfile>,
    ];
    expect(selfPct(high)).toBeGreaterThan(selfPct(base));
    expect(selfPct(big)).toBeLessThan(selfPct(base));
    expect(big.annual.export).toBeGreaterThan(base.annual.export);
    expect(autarkyPct(big)).toBeGreaterThan(autarkyPct(base));
    expect(sober.annual.production).toBeLessThan(base.annual.production);
  });
});

describe('voiture électrique', () => {
  const house = structuredClone(DEFAULT_HOUSE);
  house.ev = {
    ...house.ev,
    mode: 'planned',
    kmPerYear: 12000,
    kWhPer100km: 17,
    homeChargingPct: 80,
    chargerKw: 7.4,
  };
  const need = evAnnualKwh(house.ev);
  const total = (v: number[]): number => sum(v);
  const delta = (over: Partial<typeof house.ev>) =>
    evDelta({ ...house, ev: { ...house.ev, ...over } }, DEFAULT_SETTINGS);

  it('calcule la recharge annuelle à domicile', () => {
    expect(need).toBeCloseTo(1632, 6);
    expect(
      evAnnualKwh({ ...house.ev, kmPerYear: 10000, kWhPer100km: 20, homeChargingPct: 50 }),
    ).toBe(1000);
  });

  it('de nuit : tout est soutiré en heures creuses, rien ne change côté injection', () => {
    const d = delta({ chargeWindow: 'night' });
    expect(total(d.importOff)).toBeCloseTo(need, 0);
    expect(Math.abs(total(d.importPeak))).toBeLessThan(1);
    expect(Math.abs(total(d.exportPeak)) + Math.abs(total(d.exportOff))).toBeLessThan(1);
  });

  it('de jour : réduit l’injection et le surplus couvre une partie de la recharge', () => {
    const d = delta({ chargeWindow: 'day' });
    const exportDrop = -(total(d.exportPeak) + total(d.exportOff));
    const importRise = total(d.importPeak) + total(d.importOff);
    expect(exportDrop).toBeGreaterThan(need * 0.4);
    expect(importRise).toBeLessThan(need * 0.6);
    // Chaque kWh de recharge vient du réseau ou du surplus solaire.
    expect(importRise + exportDrop).toBeCloseTo(need, 0);
  });

  it('mixte : entre la nuit et le jour', () => {
    const night = total(delta({ chargeWindow: 'night' }).importOff);
    const mixed = total(delta({ chargeWindow: 'mixed' }).importOff);
    const day = total(delta({ chargeWindow: 'day' }).importOff);
    expect(mixed).toBeLessThan(night);
    expect(mixed).toBeGreaterThan(day);
  });

  it('une petite borne capte moins de surplus qu’une grosse', () => {
    const small = -(
      total(delta({ chargeWindow: 'day', chargerKw: 1.4 }).exportPeak) +
      total(delta({ chargeWindow: 'day', chargerKw: 1.4 }).exportOff)
    );
    const large = -(
      total(delta({ chargeWindow: 'day', chargerKw: 11 }).exportPeak) +
      total(delta({ chargeWindow: 'day', chargerKw: 11 }).exportOff)
    );
    expect(large).toBeGreaterThan(small);
  });
});

describe('poids de répartition entre deux relevés', () => {
  it('sont normalisés sur l’année et suivent le profil attendu de chaque registre', () => {
    const { ref } = build();
    const weights = seriesWeights(ref);
    const year = (f: (d: number) => number): number => {
      const start = toDayNumber('2025-01-01');
      return Array.from({ length: 365 }, (_, i) => f(start + i)).reduce((a, b) => a + b, 0);
    };
    for (const key of ['importPeak', 'importOff', 'exportPeak', 'exportOff', 'pv'] as const) {
      expect(year(weights[key])).toBeCloseTo(1, 2);
    }
    const jan = toDayNumber('2025-01-15');
    const jun = toDayNumber('2025-06-15');
    expect(weights.exportPeak(jun)).toBeGreaterThan(weights.exportPeak(jan) * 5);
    expect(weights.importPeak(jan)).toBeGreaterThan(weights.importPeak(jun));
  });
});
