import type { Measurements } from '../sma-core';
import { decodeRegisters, ModbusException, type RegisterReader } from './modbus';

/**
 * Onduleurs SunSpec (Modbus TCP) : SolarEdge, Kostal, SMA, Fronius, ABB/FIMER, Delta… Les registres commencent par
 * l'identifiant « SunS » (adresse 40000 en général, parfois 0 ou 50000), suivi d'une chaîne de modèles (identifiant,
 * longueur, données). ConsoElec lit le modèle d'onduleur : 101-103 (entiers avec facteurs d'échelle) ou 111-113
 * (flottants).
 */

/** Adresses de départ possibles de la chaîne SunSpec. */
export const SUNSPEC_BASES = [40000, 0, 50000] as const;
/** « SunS » en deux registres. */
const SUNS = [0x5375, 0x6e53] as const;
const END_OF_CHAIN = 0xffff;
/** Au-delà, la chaîne est jugée invalide. */
const MAX_MODELS = 40;

export interface SunSpecModel {
  /** 101 à 103 ou 111 à 113. */
  readonly id: number;
  /** Adresse du premier registre de données (après identifiant et longueur). */
  readonly address: number;
  readonly length: number;
}

const isInverterModel = (id: number): boolean => (id >= 101 && id <= 103) || (id >= 111 && id <= 113);

/** Cherche le modèle d'onduleur dans la chaîne SunSpec. */
export async function findSunSpecInverter(reader: RegisterReader): Promise<SunSpecModel> {
  let base: number | null = null;
  for (const candidate of SUNSPEC_BASES) {
    try {
      const marker = await reader.read(3, candidate, 2);
      if (marker[0] === SUNS[0] && marker[1] === SUNS[1]) {
        base = candidate;
        break;
      }
    } catch (error) {
      if (!(error instanceof ModbusException)) {
        throw error;
      }
    }
  }
  if (base === null) {
    throw new Error(
      "Pas de registres SunSpec sur cet appareil : vérifiez que Modbus TCP / SunSpec est activé, le port et l'identifiant Modbus.",
    );
  }
  let address = base + 2;
  for (let i = 0; i < MAX_MODELS; i++) {
    const [id, length] = (await reader.read(3, address, 2)) as [number, number];
    if (id === END_OF_CHAIN || length === undefined) {
      break;
    }
    if (isInverterModel(id)) {
      return { id, address: address + 2, length };
    }
    address += 2 + length;
  }
  throw new Error("Registres SunSpec trouvés, mais pas de modèle d'onduleur (101-103 ou 111-113).");
}

/** Valeur absente d'un entier signé SunSpec. */
const I16_NA = 0x8000;
const FLOAT_NA = 0x7fc0;

const pow10 = (sf: number): number => 10 ** sf;

/** Mesures tirées des données d'un modèle d'onduleur SunSpec (registres lus à partir de l'adresse du modèle). */
export function parseSunSpecInverter(id: number, data: readonly number[]): Measurements {
  if (id >= 111) {
    // Modèles flottants : W aux registres 20-21, WH aux registres 30-31.
    const float = (offset: number): number | null => {
      if (data[offset] === FLOAT_NA) {
        return null;
      }
      const v = decodeRegisters(data, offset, 'f32');
      return Number.isFinite(v) ? v : null;
    };
    const w = float(20);
    return { powerW: w === null ? null : Math.max(0, Math.round(w)), dayWh: null, totalWh: float(30) };
  }
  // Modèles entiers : W (12) et son facteur (13), WH sur 32 bits (22-23) et son facteur (24).
  const sf = (offset: number): number | null => {
    const raw = data[offset];
    return raw === undefined || raw === I16_NA ? null : decodeRegisters(data, offset, 'i16');
  };
  const wRaw = data[12];
  const wSf = sf(13);
  const powerW =
    wRaw === undefined || wRaw === I16_NA || wSf === null
      ? null
      : Math.max(0, Math.round(decodeRegisters(data, 12, 'i16') * pow10(wSf) * 1000) / 1000);
  const whRaw = decodeRegisters(data, 22, 'u32');
  const whSf = sf(24);
  const totalWh = whRaw === 0 || whSf === null ? null : Math.round(whRaw * pow10(whSf) * 1000) / 1000;
  return { powerW, dayWh: null, totalWh };
}

/** Lecteur SunSpec : trouve le modèle d'onduleur une fois, puis lit ses registres. */
export class SunSpecReader {
  private model: SunSpecModel | null = null;

  constructor(private readonly reader: RegisterReader) {}

  async read(): Promise<Measurements> {
    if (this.model === null) {
      this.model = await findSunSpecInverter(this.reader);
    }
    const model = this.model;
    const count = model.id >= 111 ? 32 : 25;
    try {
      return parseSunSpecInverter(model.id, await this.reader.read(3, model.address, count));
    } catch (error) {
      // Modèle déplacé (mise à jour du logiciel de l'onduleur) : on le recherchera à la prochaine lecture.
      this.model = null;
      throw error;
    }
  }
}
