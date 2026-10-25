import { DEFAULT_HOUSE, DEFAULT_SETTINGS, pvKwp, type PvDay } from '../models/app-data.model';
import { simulateHouse } from './house-simulator';
import { measuredYield } from './pv-yield';
import { referenceProfile } from './reference';

const reference = referenceProfile(DEFAULT_HOUSE, DEFAULT_SETTINGS);
const kwp = pvKwp(DEFAULT_HOUSE.pv);

/** Lectures quotidiennes de l'onduleur à 14 h (journées incomplètes), comme si l'app était ouverte l'après-midi. */
function dailyReadings(start: string, days: number, solarScale: number, seed: number): PvDay[] {
  const sim = simulateHouse({
    house: DEFAULT_HOUSE,
    settings: DEFAULT_SETTINGS,
    start,
    days,
    seed,
    solarScale,
  });
  let total = 30_000;
  return sim.map((d) => {
    const partial = d.production * 0.6;
    const entry: PvDay = {
      date: d.date,
      dayKwh: partial,
      totalKwh: total + partial,
      at: `${d.date}T14:00`,
    };
    total += d.production;
    return entry;
  });
}

describe('rendement mesuré sur l’onduleur', () => {
  it('retrouve le rendement réglé quand l’installation produit comme prévu', () => {
    // Moyenne de plusieurs printemps simulés : la météo d'une seule période fait varier l'estimation.
    const values = [1, 2, 3, 4].map(
      (seed) => measuredYield(dailyReadings('2025-03-01', 90, 1, seed), reference, kwp)!.kwhPerKwp,
    );
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    expect(mean).toBeGreaterThan(DEFAULT_SETTINGS.specificYieldKwhPerKwp * 0.9);
    expect(mean).toBeLessThan(DEFAULT_SETTINGS.specificYieldKwhPerKwp * 1.1);
  });

  it('détecte une installation qui produit 15 % de plus que le réglage', () => {
    const values = [1, 2, 3, 4].map(
      (seed) =>
        measuredYield(dailyReadings('2025-03-01', 120, 1.15, seed), reference, kwp)!.kwhPerKwp,
    );
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    expect(mean).toBeGreaterThan(DEFAULT_SETTINGS.specificYieldKwhPerKwp * 1.05);
  });

  it('est exact même si les journées ont été lues incomplètes (calcul sur l’index total)', () => {
    const readings = dailyReadings('2025-05-01', 30, 1, 9);
    const r = measuredYield(readings, reference, kwp)!;
    expect(r.measuredKwh).toBeCloseTo(readings.at(-1)!.totalKwh - readings[0]!.totalKwh, 6);
  });

  it('ne conclut rien sur moins de 14 jours', () => {
    expect(measuredYield(dailyReadings('2025-05-01', 10, 1, 9), reference, kwp)).toBeNull();
    expect(measuredYield([], reference, kwp)).toBeNull();
  });
});
