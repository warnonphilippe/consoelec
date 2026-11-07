import type { P1Reading } from '../shared/ipc-contract';

/** Réponses JSON des lecteurs autres que l'API v1 HomeWizard (lue par `parseP1Data`). */

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const round3 = (v: number | null): number | null =>
  v === null ? null : Math.round(v * 1000) / 1000;
const text = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null;

/** HomeWizard API v2 : `GET /api/measurement`. */
export function parseHomeWizardV2(json: unknown, at: number): P1Reading | null {
  if (!isObject(json)) {
    return null;
  }
  const importPeak = round3(finite(json['energy_import_t1_kwh']));
  const importOff = round3(finite(json['energy_import_t2_kwh']));
  const exportPeak = round3(finite(json['energy_export_t1_kwh']));
  const exportOff = round3(finite(json['energy_export_t2_kwh']));
  const powerW = finite(json['power_w']);
  if ([importPeak, importOff, exportPeak, exportOff, powerW].every((v) => v === null)) {
    return null;
  }
  const tariff = json['tariff'];
  return {
    at,
    powerW: powerW === null ? null : Math.round(powerW),
    quarterHourAvgW: finite(json['average_power_15m_w']),
    tariff: tariff === 1 || tariff === 2 ? tariff : null,
    importPeak,
    importOff,
    exportPeak,
    exportOff,
    meterModel: text(json['meter_model']),
    error: null,
  };
}

/**
 * YouLess LS120 : `GET /e` renvoie un tableau d'un objet. `p1`/`p2` : soutirage tarif 1 et 2, `n1`/`n2` : injection
 * tarif 1 et 2 (kWh), `pwr` : puissance nette (W, négative en injection).
 */
export function parseYouLess(json: unknown, at: number): P1Reading | null {
  const entry = Array.isArray(json) ? json[0] : json;
  if (!isObject(entry)) {
    return null;
  }
  const importPeak = round3(finite(entry['p1']));
  const importOff = round3(finite(entry['p2']));
  const exportPeak = round3(finite(entry['n1']));
  const exportOff = round3(finite(entry['n2']));
  const powerW = finite(entry['pwr']);
  if ([importPeak, importOff, exportPeak, exportOff].every((v) => v === null)) {
    return null;
  }
  return {
    at,
    powerW: powerW === null ? null : Math.round(powerW),
    quarterHourAvgW: null,
    tariff: null,
    importPeak,
    importOff,
    exportPeak,
    exportOff,
    meterModel: null,
    error: null,
  };
}
