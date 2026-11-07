import { SolarModel } from './solar-model';

/**
 * Compteur numérique simulé (Belgique) : consommation de la maison moins production solaire, minute par minute.
 * Le surplus est injecté, le manque soutiré ; les index avancent sur le tarif de jour (1) ou de nuit (2) selon
 * l'heure (22 h-7 h et week-ends en tarif 2). Les valeurs sont déterministes pour un instant donné.
 */

export interface MeterState {
  /** Puissance nette (W) : positive en soutirage, négative en injection. */
  readonly powerW: number;
  /** Moyenne du quart d'heure en cours (W, soutirage), base du tarif capacitaire. */
  readonly quarterHourAvgW: number;
  readonly tariff: 1 | 2;
  /** Index (kWh) : soutirage tarif 1 et 2, injection tarif 1 et 2. */
  readonly importT1: number;
  readonly importT2: number;
  readonly exportT1: number;
  readonly exportT2: number;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

const midnight = (ms: number): number => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

export function tariffAt(ms: number): 1 | 2 {
  const d = new Date(ms);
  const weekend = d.getDay() === 0 || d.getDay() === 6;
  return weekend || d.getHours() >= 22 || d.getHours() < 7 ? 2 : 1;
}

export class MeterModel {
  readonly solar: SolarModel;
  readonly now: () => number;
  private readonly start: number;
  private readonly startIndex = {
    importT1: 8123.456,
    importT2: 6345.678,
    exportT1: 3456.789,
    exportT2: 1234.567,
  };

  constructor(options: { solar?: SolarModel; now?: () => number } = {}) {
    this.now = options.now ?? options.solar?.now ?? Date.now;
    this.solar = options.solar ?? new SolarModel({ now: this.now });
    // Index connus à minuit, une semaine avant l'instant de départ (assez pour des historiques courts).
    this.start = midnight(this.now()) - 7 * DAY_MS;
  }

  /** Consommation de la maison (W) : talon, repas, soirée, quelques pointes. */
  loadAt(ms: number): number {
    const d = new Date(ms);
    const hour = d.getHours() + d.getMinutes() / 60;
    let w = 280;
    if (hour >= 7 && hour < 8.5) w += 1200;
    if (hour >= 12 && hour < 13) w += 900;
    if (hour >= 18 && hour < 21) w += 1400;
    if (d.getMinutes() % 20 < 3) w += 1800; // pointes (bouilloire, four…)
    return w;
  }

  netAt(ms: number): number {
    return Math.round(this.loadAt(ms) - this.solar.powerAt(ms));
  }

  state(ms: number = this.now()): MeterState {
    const idx = { ...this.startIndex };
    for (let t = this.start; t < ms; t += MINUTE_MS) {
      const kwh = (this.netAt(t) * Math.min(MINUTE_MS, ms - t)) / 3_600_000 / 1000;
      const tariff = tariffAt(t);
      if (kwh >= 0) {
        idx[tariff === 1 ? 'importT1' : 'importT2'] += kwh;
      } else {
        idx[tariff === 1 ? 'exportT1' : 'exportT2'] -= kwh;
      }
    }
    const quarterStart = ms - (ms % (15 * MINUTE_MS));
    let sum = 0;
    let n = 0;
    for (let t = quarterStart; t <= ms; t += MINUTE_MS) {
      sum += Math.max(0, this.netAt(t));
      n++;
    }
    const round3 = (v: number): number => Math.round(v * 1000) / 1000;
    return {
      powerW: this.netAt(ms),
      quarterHourAvgW: Math.round(sum / n),
      tariff: tariffAt(ms),
      importT1: round3(idx.importT1),
      importT2: round3(idx.importT2),
      exportT1: round3(idx.exportT1),
      exportT2: round3(idx.exportT2),
    };
  }
}

// --- Télégramme e-MUCS (Belgique) ---

/** CRC-16/ARC (polynôme 0xA001, valeur initiale 0), écrit d'après la norme DSMR 5.0.2. */
export function telegramCrc(text: string): string {
  let crc = 0;
  for (const byte of Buffer.from(text, 'latin1')) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

const two = (n: number): string => String(n).padStart(2, '0');
const kwh = (v: number): string => v.toFixed(3).padStart(10, '0');
const kw = (w: number): string => (Math.max(0, w) / 1000).toFixed(3).padStart(6, '0');

/** Télégramme d'un compteur Fluvius / Iskra e-MUCS à l'instant `ms`, CRC compris. */
export function buildTelegram(state: MeterState, ms: number, header = 'FLU5\\253769484_A'): string {
  const d = new Date(ms);
  const stamp = `${two(d.getFullYear() % 100)}${two(d.getMonth() + 1)}${two(d.getDate())}${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}W`;
  const lines = [
    `/${header}`,
    '',
    '0-0:96.1.4(50217)',
    '0-0:96.1.1(3153414733313031303231363035)',
    `0-0:1.0.0(${stamp})`,
    `1-0:1.8.1(${kwh(state.importT1)}*kWh)`,
    `1-0:1.8.2(${kwh(state.importT2)}*kWh)`,
    `1-0:2.8.1(${kwh(state.exportT1)}*kWh)`,
    `1-0:2.8.2(${kwh(state.exportT2)}*kWh)`,
    `0-0:96.14.0(${String(state.tariff).padStart(4, '0')})`,
    `1-0:1.4.0(${kw(state.quarterHourAvgW)}*kW)`,
    `1-0:1.6.0(${stamp})(${kw(4321)}*kW)`,
    `1-0:1.7.0(${kw(state.powerW)}*kW)`,
    `1-0:2.7.0(${kw(-state.powerW)}*kW)`,
    '1-0:32.7.0(231.4*V)',
    '1-0:31.7.0(003.21*A)',
    '0-0:96.3.10(1)',
    '0-0:17.0.0(999.9*kW)',
    '1-0:31.4.0(999*A)',
    '0-0:96.13.0()',
    '!',
  ];
  const body = lines.join('\r\n');
  return `${body}${telegramCrc(body)}\r\n`;
}
