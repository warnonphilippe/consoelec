import type { InverterBrand } from '../shared/inverter-brands';
import {
  decodeRegisters,
  registerCount,
  type ReadFunction,
  type RegisterReader,
  type RegisterType,
  type WordOrder,
} from './modbus';
import type { Measurements } from '../sma-core';

/**
 * Tables de registres Modbus des marques qui n'utilisent pas SunSpec. Sources : documentation Modbus des fabricants,
 * recoupée avec les bibliothèques libres qui les lisent (huawei-solar, goodwe, définitions Solarman de Home
 * Assistant, intégration Sungrow de mkaiser). Les adresses sont les adresses Modbus (comptées depuis 0).
 */

export interface RegisterField {
  readonly address: number;
  readonly type: RegisterType;
  readonly order?: WordOrder;
  /** Facteur vers des W (puissance) ou des Wh (énergie). */
  readonly scale: number;
}

export interface RegisterMap {
  readonly fn: ReadFunction;
  /** Plages lues (adresse de départ, nombre de registres), une requête chacune. */
  readonly blocks: readonly { readonly start: number; readonly count: number }[];
  readonly power: RegisterField;
  readonly day: RegisterField | null;
  readonly total: RegisterField | null;
}

export const REGISTER_MAPS: Partial<Record<InverterBrand, RegisterMap>> = {
  // Huawei SUN2000 : puissance active (I32, W), énergie totale et du jour (U32, centièmes de kWh).
  huawei: {
    fn: 3,
    blocks: [
      { start: 32080, count: 2 },
      { start: 32106, count: 10 },
    ],
    power: { address: 32080, type: 'i32', scale: 1 },
    total: { address: 32106, type: 'u32', scale: 10 },
    day: { address: 32114, type: 'u32', scale: 10 },
  },
  // Sungrow réseau (SG) : production du jour (registre 5003, 0,1 kWh), totale (5004-5005, kWh),
  // puissance active (5031-5032, W) ; mots de poids faible d'abord.
  'sungrow-sg': {
    fn: 4,
    blocks: [{ start: 5002, count: 30 }],
    day: { address: 5002, type: 'u16', scale: 100 },
    total: { address: 5003, type: 'u32', order: 'low-first', scale: 1000 },
    power: { address: 5030, type: 'u32', order: 'low-first', scale: 1 },
  },
  // Sungrow hybride (SH) : puissance des panneaux (5017-5018, W), production PV du jour (13002, 0,1 kWh) et
  // totale (13003-13004, 0,1 kWh) ; mots de poids faible d'abord.
  'sungrow-sh': {
    fn: 4,
    blocks: [
      { start: 5016, count: 2 },
      { start: 13001, count: 3 },
    ],
    power: { address: 5016, type: 'u32', order: 'low-first', scale: 1 },
    day: { address: 13001, type: 'u16', scale: 100 },
    total: { address: 13002, type: 'u32', order: 'low-first', scale: 100 },
  },
  // Solis : puissance active (3005-3006, W), énergie totale (3009-3010, kWh), du jour (3015, 0,1 kWh).
  solis: {
    fn: 4,
    blocks: [{ start: 3004, count: 11 }],
    power: { address: 3004, type: 'u32', scale: 1 },
    total: { address: 3008, type: 'u32', scale: 1000 },
    day: { address: 3014, type: 'u16', scale: 100 },
  },
  // GoodWe hybride (ET, EH, BT, BH) : puissance de l'onduleur (35138, W), production PV totale (35191-35192) et du
  // jour (35193-35194), en 0,1 kWh.
  'goodwe-et': {
    fn: 3,
    blocks: [
      { start: 35138, count: 1 },
      { start: 35191, count: 4 },
    ],
    power: { address: 35138, type: 'i16', scale: 1 },
    total: { address: 35191, type: 'u32', scale: 100 },
    day: { address: 35193, type: 'u32', scale: 100 },
  },
  // GoodWe réseau (DT, D-NS, XS…) : puissance totale (30127-30128, W), production du jour (30144, 0,1 kWh) et
  // totale (30145-30146, 0,1 kWh).
  'goodwe-dt': {
    fn: 3,
    blocks: [
      { start: 30127, count: 2 },
      { start: 30144, count: 3 },
    ],
    power: { address: 30127, type: 'u32', scale: 1 },
    day: { address: 30144, type: 'u16', scale: 100 },
    total: { address: 30145, type: 'u32', scale: 100 },
  },
  // Deye réseau (SUN-…K-G, micro-onduleurs) : production du jour (0x3C, 0,1 kWh), totale (0x3F-0x40, 0,1 kWh),
  // puissance de sortie (0x50-0x51, 0,1 W) ; mots de poids faible d'abord.
  deye: {
    fn: 3,
    blocks: [{ start: 0x3c, count: 0x16 }],
    day: { address: 0x3c, type: 'u16', scale: 100 },
    total: { address: 0x3f, type: 'u32', order: 'low-first', scale: 100 },
    power: { address: 0x50, type: 'u32', order: 'low-first', scale: 0.1 },
  },
  // Sofar KTL-X (clé LSW-3) : puissance active (0x0C, 10 W), énergie totale (0x15-0x16, kWh), du jour (0x19, 0,01 kWh).
  sofar: {
    fn: 3,
    blocks: [{ start: 0x0c, count: 0x0e }],
    power: { address: 0x0c, type: 'u16', scale: 10 },
    total: { address: 0x15, type: 'u32', scale: 1000 },
    day: { address: 0x19, type: 'u16', scale: 10 },
  },
};

/** Lit les plages d'une table et en tire les mesures. */
export async function readRegisterMap(reader: RegisterReader, map: RegisterMap): Promise<Measurements> {
  const words = new Map<number, number>();
  for (const block of map.blocks) {
    const values = await reader.read(map.fn, block.start, block.count);
    values.forEach((v, i) => words.set(block.start + i, v));
  }
  const value = (field: RegisterField | null): number | null => {
    if (field === null) {
      return null;
    }
    const raw: number[] = [];
    for (let i = 0; i < registerCount(field.type); i++) {
      const w = words.get(field.address + i);
      if (w === undefined) {
        throw new Error(`Registre ${field.address + i} absent des plages lues.`);
      }
      raw.push(w);
    }
    return Math.round(decodeRegisters(raw, 0, field.type, field.order) * field.scale * 1000) / 1000;
  };
  return { powerW: Math.max(0, value(map.power) ?? 0), dayWh: value(map.day), totalWh: value(map.total) };
}
