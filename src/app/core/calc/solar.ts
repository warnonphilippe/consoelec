import { daysInMonth } from './time';

/**
 * Hypothèses solaires du modèle de référence (centre de la Belgique, installation bien orientée).
 * Ce sont des ordres de grandeur : durée du jour, répartition mensuelle de la production (type PVGIS)
 * et fréquence des jours ensoleillés / nuageux.
 */

/** Durée du jour (h) au milieu de chaque mois, à 50,8° N. */
export const DAYLIGHT_HOURS: readonly number[] = [
  8.2, 9.6, 11.6, 13.6, 15.4, 16.3, 15.9, 14.3, 12.4, 10.4, 8.5, 7.7,
];

/**
 * Heure légale (h) du midi solaire à ~5° E : environ 12 h 40 en hiver, 13 h 40 pendant l'heure d'été.
 * La consommation suit l'heure légale : sans ce décalage, le solaire serait placé 1 à 2 h trop tôt par rapport aux
 * pointes de la soirée.
 */
export const SOLAR_NOON: readonly number[] = [
  12.7, 12.7, 12.8, 13.7, 13.7, 13.7, 13.7, 13.7, 13.7, 13.6, 12.7, 12.7,
];

/** Part de la durée du jour pendant laquelle les panneaux produisent réellement (soleil assez haut). */
const EFFECTIVE_DAYLIGHT = 0.8;

/** Répartition mensuelle de la production photovoltaïque annuelle : ~2 % en décembre, ~13 % en juin. */
export const PV_MONTH_SHAPE: readonly number[] = normalized([
  2.4, 4.4, 8.4, 11.6, 13.2, 13.6, 13.6, 12.0, 9.6, 6.2, 3.1, 1.9,
]);

export type DayType = 'clear' | 'partly' | 'overcast';

/** Fraction des jours de chaque mois : ciel dégagé. */
const CLEAR_DAYS: readonly number[] = [
  0.1, 0.14, 0.2, 0.27, 0.28, 0.28, 0.32, 0.3, 0.24, 0.16, 0.09, 0.08,
];
/** Fraction des jours de chaque mois : éclaircies. Le reste des jours est couvert. */
const PARTLY_DAYS: readonly number[] = [
  0.17, 0.22, 0.3, 0.35, 0.38, 0.38, 0.38, 0.36, 0.33, 0.27, 0.2, 0.17,
];

/** Production relative (crête) d'une journée selon la météo. */
export const DAY_AMPLITUDE: Record<DayType, number> = { clear: 1, partly: 0.5, overcast: 0.15 };

export interface DayMix {
  readonly type: DayType;
  /** Fraction des jours du mois. */
  readonly share: number;
}

export function dayMix(month: number): DayMix[] {
  const clear = CLEAR_DAYS[month]!;
  const partly = PARTLY_DAYS[month]!;
  return [
    { type: 'clear', share: clear },
    { type: 'partly', share: partly },
    { type: 'overcast', share: 1 - clear - partly },
  ];
}

/** Forme d'une journée ensoleillée (demi-sinusoïde, crête = 1) heure par heure, en heure légale. */
export function sunShape(month: number): number[] {
  const length = DAYLIGHT_HOURS[month]! * EFFECTIVE_DAYLIGHT;
  const sunrise = SOLAR_NOON[month]! - length / 2;
  return Array.from({ length: 24 }, (_, h) => {
    const t = h + 0.5 - sunrise;
    return t > 0 && t < length ? Math.sin((Math.PI * t) / length) : 0;
  });
}

/** Énergie moyenne par jour (kWh) d'une installation dont la journée dégagée culmine à 1 kW. */
export function meanDailyEnergyPerKw(month: number): number {
  const area = sunShape(month).reduce((a, b) => a + b, 0);
  return area * dayMix(month).reduce((s, d) => s + d.share * DAY_AMPLITUDE[d.type], 0);
}

/**
 * Puissance de crête (kW, courant continu) d'une journée dégagée du mois pour produire `monthlyKwh`
 * sur le mois : sert à dimensionner la courbe horaire.
 */
export function clearDayPeakKw(month: number, monthlyKwh: number, year = 2025): number {
  const perKw = meanDailyEnergyPerKw(month) * daysInMonth(year, month);
  return perKw > 0 ? monthlyKwh / perKw : 0;
}

function normalized(values: number[]): number[] {
  const total = values.reduce((a, b) => a + b, 0);
  return values.map((v) => v / total);
}
