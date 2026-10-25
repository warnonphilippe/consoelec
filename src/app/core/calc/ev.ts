import {
  REGISTER_KEYS,
  type ElectricVehicle,
  type House,
  type Settings,
} from '../models/app-data.model';
import { referenceProfile, zeroRegisters, type MonthlyByRegister } from './reference';

/** Recharge annuelle à domicile (kWh) d'un véhicule électrique. */
export function evAnnualKwh(ev: ElectricVehicle): number {
  return ((ev.kmPerYear * ev.kWhPer100km) / 100) * (ev.homeChargingPct / 100);
}

/**
 * Effet de la voiture sur chaque registre du compteur (kWh/mois ; positif = plus de soutirage,
 * négatif = moins d'injection), obtenu en comparant le profil de référence avec et sans voiture :
 * - recharge de nuit : soutirage en heures creuses ;
 * - recharge de jour : absorbe d'abord le surplus solaire (injection en moins, après le radiateur d'appoint),
 *   le reste est soutiré en journée ;
 * - mixte : moitié-moitié.
 */
export function evDelta(house: House, settings: Settings): MonthlyByRegister {
  const without = referenceProfile(house, settings);
  const withEv = referenceProfile(house, settings, { ev: true });
  const delta = zeroRegisters();
  for (const key of REGISTER_KEYS) {
    for (let m = 0; m < 12; m++) {
      delta[key][m] = withEv.registers[key][m]! - without.registers[key][m]!;
    }
  }
  return delta;
}
