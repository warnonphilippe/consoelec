import type { SolarModel, SolarState } from './solar-model';

/**
 * Registres Modbus simulés de chaque marque, écrits d'après la documentation des fabricants (numérotation de leur
 * documentation indiquée en commentaire), indépendamment des tables du client. Seules les adresses écrites existent :
 * lire ailleurs renvoie l'exception Modbus 2, comme un vrai onduleur.
 */

export type BankKind =
  | 'sunspec-int'
  | 'sunspec-float'
  | 'huawei'
  | 'sungrow-sg'
  | 'sungrow-sh'
  | 'solis'
  | 'goodwe-et'
  | 'goodwe-dt'
  | 'deye'
  | 'sofar';

export class RegisterBank {
  /** Registres par fonction (3 : holding, 4 : input). */
  private readonly regs = { 3: new Map<number, number>(), 4: new Map<number, number>() };

  u16(fn: 3 | 4, address: number, value: number): this {
    this.regs[fn].set(address, Math.round(value) & 0xffff);
    return this;
  }

  i16(fn: 3 | 4, address: number, value: number): this {
    return this.u16(fn, address, Math.round(value) < 0 ? Math.round(value) + 0x10000 : value);
  }

  u32(fn: 3 | 4, address: number, value: number, order: 'high-first' | 'low-first' = 'high-first'): this {
    const v = Math.round(value) >>> 0;
    const high = (v >>> 16) & 0xffff;
    const low = v & 0xffff;
    return order === 'high-first'
      ? this.u16(fn, address, high).u16(fn, address + 1, low)
      : this.u16(fn, address, low).u16(fn, address + 1, high);
  }

  i32(fn: 3 | 4, address: number, value: number): this {
    return this.u32(fn, address, Math.round(value) < 0 ? Math.round(value) + 0x1_0000_0000 : value);
  }

  f32(fn: 3 | 4, address: number, value: number): this {
    const buf = Buffer.alloc(4);
    buf.writeFloatBE(value, 0);
    return this.u16(fn, address, buf.readUInt16BE(0)).u16(fn, address + 1, buf.readUInt16BE(2));
  }

  text(fn: 3 | 4, address: number, value: string, registers: number): this {
    const buf = Buffer.alloc(registers * 2);
    buf.write(value, 'ascii');
    for (let i = 0; i < registers; i++) {
      this.u16(fn, address + i, buf.readUInt16BE(i * 2));
    }
    return this;
  }

  /** Lit une plage ; `null` si un registre n'existe pas (exception Modbus 2). */
  read(fn: number, address: number, count: number): number[] | null {
    const map = fn === 3 || fn === 4 ? this.regs[fn] : null;
    if (map === null) {
      return null;
    }
    const out: number[] = [];
    for (let i = 0; i < count; i++) {
      const v = map.get(address + i);
      if (v === undefined) {
        return null;
      }
      out.push(v);
    }
    return out;
  }
}

/** Chaîne SunSpec : « SunS », modèle commun (1), modèle d'onduleur triphasé (103 ou 113), fin de chaîne. */
function sunspec(s: SolarState, float: boolean): RegisterBank {
  const b = new RegisterBank();
  b.u16(3, 40000, 0x5375).u16(3, 40001, 0x6e53);
  // Modèle 1 : fabricant, modèle, version, numéro de série (66 registres).
  b.u16(3, 40002, 1).u16(3, 40003, 66);
  for (let i = 0; i < 66; i++) {
    b.u16(3, 40004 + i, 0);
  }
  b.text(3, 40004, 'ConsoElec', 16).text(3, 40020, 'Emulateur SunSpec', 16).text(3, 40052, 'EMU123456', 16);
  let a = 40070;
  if (float) {
    b.u16(3, a, 113).u16(3, a + 1, 60);
    const d = a + 2;
    for (let i = 0; i < 60; i++) {
      b.u16(3, d + i, 0);
    }
    b.f32(3, d + 0, s.powerW / 690); // A
    b.f32(3, d + 14, 230).f32(3, d + 16, 230).f32(3, d + 18, 230); // PhV
    b.f32(3, d + 20, s.powerW); // W
    b.f32(3, d + 22, 50); // Hz
    b.f32(3, d + 30, s.totalWh); // WH
    a = d + 60;
  } else {
    b.u16(3, a, 103).u16(3, a + 1, 50);
    const d = a + 2;
    for (let i = 0; i < 50; i++) {
      b.u16(3, d + i, 0);
    }
    // W avec un facteur d'échelle 0 la journée, comme SolarEdge ; WH en Wh (facteur 0).
    b.u16(3, d + 0, Math.round((s.powerW / 690) * 100)).i16(3, d + 4, -2); // A, A_SF
    b.u16(3, d + 8, 2300).u16(3, d + 9, 2300).u16(3, d + 10, 2300).i16(3, d + 11, -1); // PhV, V_SF
    b.i16(3, d + 12, s.powerW).i16(3, d + 13, 0); // W, W_SF
    b.u16(3, d + 14, 5000).i16(3, d + 15, -2); // Hz, Hz_SF
    b.u32(3, d + 22, s.totalWh).i16(3, d + 24, 0); // WH, WH_SF
    a = d + 50;
  }
  b.u16(3, a, 0xffff).u16(3, a + 1, 0);
  return b;
}

export function buildBank(kind: BankKind, s: SolarState): RegisterBank {
  const b = new RegisterBank();
  switch (kind) {
    case 'sunspec-int':
      return sunspec(s, false);
    case 'sunspec-float':
      return sunspec(s, true);
    case 'huawei':
      // Documentation « SUN2000 Modbus Interface Definitions » : 30000 modèle (STR, 15 registres),
      // 32064 puissance d'entrée (I32, kW ×1000), 32080 puissance active (I32, kW ×1000),
      // 32106 énergie totale (U32, kWh ×100), 32114 énergie du jour (U32, kWh ×100).
      b.text(3, 30000, 'SUN2000-5KTL-M1', 15);
      b.i32(3, 32064, s.powerW * 1.03);
      b.i32(3, 32080, s.powerW).i32(3, 32082, 0);
      for (let i = 32084; i < 32106; i++) b.u16(3, i, 0);
      b.u32(3, 32106, s.totalWh / 10).u32(3, 32108, 0);
      for (let i = 32110; i < 32114; i++) b.u16(3, i, 0);
      b.u32(3, 32114, s.dayWh / 10);
      return b;
    case 'sungrow-sg':
      // « Communication Protocol of PV Grid-Connected String Inverters » (registres d'entrée, numérotés depuis 1) :
      // 5003 production du jour (U16, 0,1 kWh), 5004-5005 totale (U32, kWh), 5017-5018 puissance DC (U32, W),
      // 5031-5032 puissance active (U32, W). Mots de poids faible d'abord.
      for (let r = 5001; r <= 5040; r++) b.u16(4, r - 1, 0);
      b.u16(4, 5003 - 1, s.dayWh / 100);
      b.u32(4, 5004 - 1, s.totalWh / 1000, 'low-first');
      b.u32(4, 5017 - 1, s.powerW * 1.03, 'low-first');
      b.u32(4, 5031 - 1, s.powerW, 'low-first');
      return b;
    case 'sungrow-sh':
      // Hybrides SH : 5017-5018 puissance DC totale (U32, W), 13002 production PV du jour (U16, 0,1 kWh),
      // 13003-13004 production PV totale (U32, 0,1 kWh), 13034-13035 puissance active (I32, W).
      for (let r = 5001; r <= 5040; r++) b.u16(4, r - 1, 0);
      b.u32(4, 5017 - 1, s.powerW, 'low-first');
      for (let r = 13001; r <= 13040; r++) b.u16(4, r - 1, 0);
      b.u16(4, 13002 - 1, s.dayWh / 100);
      b.u32(4, 13003 - 1, s.totalWh / 100, 'low-first');
      b.u32(4, 13034 - 1, s.powerW * 0.97, 'low-first');
      return b;
    case 'solis':
      // Protocole RS485 Solis (registres d'entrée) : 3005-3006 puissance active (U32, W), 3009-3010 énergie totale
      // (U32, kWh), 3015 énergie du jour (U16, 0,1 kWh). Adresses Modbus = numéro − 1.
      for (let r = 3001; r <= 3040; r++) b.u16(4, r - 1, 0);
      b.u32(4, 3005 - 1, s.powerW);
      b.u32(4, 3009 - 1, s.totalWh / 1000);
      b.u16(4, 3015 - 1, s.dayWh / 100);
      return b;
    case 'goodwe-et':
      // GoodWe ET (bloc 35100-35224) : 35138 puissance de l'onduleur (I16, W), 35191-35192 production PV totale
      // (U32, 0,1 kWh), 35193-35194 production PV du jour (U32, 0,1 kWh).
      for (let r = 35100; r < 35225; r++) b.u16(3, r, 0);
      b.i16(3, 35138, s.powerW);
      b.u32(3, 35191, s.totalWh / 100);
      b.u32(3, 35193, s.dayWh / 100);
      return b;
    case 'goodwe-dt':
      // GoodWe DT (bloc 30100-30172) : 30127-30128 puissance totale (U32, W), 30144 production du jour
      // (U16, 0,1 kWh), 30145-30146 production totale (U32, 0,1 kWh).
      for (let r = 30100; r < 30173; r++) b.u16(3, r, 0);
      b.u32(3, 30127, s.powerW);
      b.u16(3, 30144, s.dayWh / 100);
      b.u32(3, 30145, s.totalWh / 100);
      return b;
    case 'deye':
      // Deye réseau (registres de maintien 0x03-0x70) : 0x3C production du jour (0,1 kWh), 0x3F-0x40 totale
      // (0,1 kWh, mot faible d'abord), 0x50-0x51 puissance de sortie (0,1 W, mot faible d'abord).
      for (let r = 0x03; r <= 0x70; r++) b.u16(3, r, 0);
      b.u16(3, 0x3c, s.dayWh / 100);
      b.u32(3, 0x3f, s.totalWh / 100, 'low-first');
      b.u32(3, 0x50, s.powerW * 10, 'low-first');
      return b;
    case 'sofar':
      // Sofar KTL-X (registres 0x00-0x27) : 0x0C puissance active (10 W), 0x15-0x16 énergie totale (kWh),
      // 0x19 énergie du jour (0,01 kWh).
      for (let r = 0x00; r <= 0x27; r++) b.u16(3, r, 0);
      b.u16(3, 0x0c, s.powerW / 10);
      b.u32(3, 0x15, s.totalWh / 1000);
      b.u16(3, 0x19, s.dayWh / 10);
      return b;
  }
}

/** Fournisseur de registres d'après l'état solaire courant. */
export const bankProvider =
  (kind: BankKind, model: SolarModel) =>
  (fn: number, address: number, count: number): number[] | null =>
    buildBank(kind, model.state()).read(fn, address, count);
