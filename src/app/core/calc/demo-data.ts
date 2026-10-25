import { emptyData, type AppData } from '../models/app-data.model';
import { monthlyDates, readingsFrom, simulateHouse } from './house-simulator';

/**
 * Deux ans de relevés fictifs (un relevé par mois environ, installation de la maison par défaut, consommation un peu
 * supérieure à la référence) qui se terminent à la date donnée. Données simulées jour par jour, avec météo aléatoire.
 */
export function buildDemoData(now: Date): AppData {
  const data = emptyData();
  const firstMonth = new Date(now.getFullYear() - 2, now.getMonth(), 1);
  const start = `${firstMonth.getFullYear()}-${String(firstMonth.getMonth() + 1).padStart(2, '0')}-01`;
  const days = Math.ceil((now.getTime() - firstMonth.getTime()) / 86_400_000) + 1;
  const sim = simulateHouse({
    house: data.house,
    settings: data.settings,
    start,
    days,
    seed: 42,
    consumptionScale: 1.12,
  });
  const dates = monthlyDates(start, 25, 2).filter((d) => d <= now.toISOString().slice(0, 10));
  const readings = readingsFrom(sim, {
    dates,
    hour: 8,
    withPv: true,
    initial: { importPeak: 18450, importOff: 11200, exportPeak: 9800, exportOff: 3100, pv: 21000 },
  });
  readings[0] = { ...readings[0]!, note: 'Démo : premier relevé' };
  return { ...data, readings };
}
