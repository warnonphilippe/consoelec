import type { PvDay } from '../models/app-data.model';
import { toDayNumber } from './time';

/**
 * Production du jour (Wh) déduite de l'index de production totale, pour les onduleurs qui ne la donnent pas
 * (SunSpec) : différence avec l'index au début de la journée. Ce point de départ est, dans l'ordre :
 * - celui de la journée déjà enregistrée (index − production du jour) ;
 * - l'index enregistré la veille (dernière lecture de la veille) ;
 * - à défaut, l'index de cette première lecture : la journée compte alors depuis l'ouverture de ConsoElec.
 */
export function dayWhFromTotal(totalWh: number, date: string, pvDaily: readonly PvDay[]): number {
  const today = pvDaily.find((d) => d.date === date);
  if (today) {
    return Math.max(0, Math.round(totalWh - (today.totalKwh - today.dayKwh) * 1000));
  }
  const day = toDayNumber(date);
  const yesterday = pvDaily.find((d) => toDayNumber(d.date) === day - 1);
  return yesterday ? Math.max(0, Math.round(totalWh - yesterday.totalKwh * 1000)) : 0;
}
