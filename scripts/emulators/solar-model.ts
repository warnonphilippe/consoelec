/**
 * Journée solaire simulée, commune à tous les émulateurs d'onduleurs : une cloche de production entre le lever et le
 * coucher du soleil (heure locale), quelques passages nuageux réguliers, et des compteurs d'énergie cohérents
 * (production du jour et totale, en Wh). Les valeurs sont déterministes : deux lectures au même instant donnent la
 * même chose.
 */

export interface SolarState {
  /** Puissance AC (W), 0 la nuit. */
  readonly powerW: number;
  /** Production depuis minuit (Wh). */
  readonly dayWh: number;
  /** Production totale depuis la mise en service (Wh). */
  readonly totalWh: number;
}

export interface SolarModelOptions {
  /** Puissance de crête par ciel clair (W). */
  readonly peakW?: number;
  /** Heure du lever et du coucher (heures locales décimales). */
  readonly sunrise?: number;
  readonly sunset?: number;
  /** Production totale à minuit du jour de référence (Wh). */
  readonly totalAtReferenceWh?: number;
  /** Jour de référence (ms, n'importe quelle heure de ce jour). */
  readonly referenceDay?: number;
  /** Horloge (tests). */
  readonly now?: () => number;
}

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

const midnight = (ms: number): number => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

export class SolarModel {
  readonly peakW: number;
  private readonly sunrise: number;
  private readonly sunset: number;
  private readonly totalAtReference: number;
  private readonly referenceMidnight: number;
  readonly now: () => number;

  constructor(options: SolarModelOptions = {}) {
    this.peakW = options.peakW ?? 4800;
    this.sunrise = options.sunrise ?? 7;
    this.sunset = options.sunset ?? 20;
    this.totalAtReference = options.totalAtReferenceWh ?? 21_345_000;
    this.now = options.now ?? Date.now;
    this.referenceMidnight = midnight(options.referenceDay ?? this.now());
  }

  /** Puissance (W) à un instant. */
  powerAt(ms: number): number {
    const d = new Date(ms);
    const hour = d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
    if (hour <= this.sunrise || hour >= this.sunset) {
      return 0;
    }
    const x = (hour - this.sunrise) / (this.sunset - this.sunrise);
    const bell = Math.sin(Math.PI * x) ** 2;
    // Passages nuageux : quelques creux réguliers, différents d'un jour à l'autre.
    const day = Math.floor(midnight(ms) / DAY_MS);
    const clouds = 1 - 0.35 * Math.max(0, Math.sin(hour * 2.3 + day * 1.7)) ** 6;
    return Math.round(this.peakW * bell * clouds);
  }

  /** Énergie produite (Wh) entre minuit et `ms`, par pas d'une minute. */
  private energySinceMidnight(ms: number): number {
    const start = midnight(ms);
    let wh = 0;
    for (let t = start; t < ms; t += MINUTE_MS) {
      wh += (this.powerAt(t) * Math.min(MINUTE_MS, ms - t)) / 3_600_000;
    }
    return wh;
  }

  /** Production d'une journée complète (Wh). */
  dayTotalWh(dayMs: number): number {
    return this.energySinceMidnight(midnight(dayMs) + DAY_MS - 1);
  }

  /** Production totale à minuit du jour de `ms` (Wh). */
  private totalAtMidnight(ms: number): number {
    let total = this.totalAtReference;
    const target = midnight(ms);
    if (target >= this.referenceMidnight) {
      for (let d = this.referenceMidnight; d < target; d += DAY_MS) {
        total += this.dayTotalWh(d);
      }
    } else {
      for (let d = target; d < this.referenceMidnight; d += DAY_MS) {
        total -= this.dayTotalWh(d);
      }
    }
    return total;
  }

  state(ms: number = this.now()): SolarState {
    const dayWh = this.energySinceMidnight(ms);
    return {
      powerW: this.powerAt(ms),
      dayWh: Math.round(dayWh),
      totalWh: Math.round(this.totalAtMidnight(ms) + dayWh),
    };
  }
}
