import type { P1Reading } from './shared/ipc-contract';

/** Chemin de l'API locale v1 du lecteur P1 HomeWizard (à activer dans l'application HomeWizard Energy). */
export const P1_DATA_PATH = '/api/v1/data';

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const finite = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

const round3 = (v: number | null): number | null =>
  v === null ? null : Math.round(v * 1000) / 1000;

/**
 * Lecture du compteur à partir de la réponse JSON du lecteur. Les index sont ceux des registres OBIS du compteur :
 * tarif 1 = heures pleines (1.8.1 et 2.8.1), tarif 2 = heures creuses (1.8.2 et 2.8.2).
 * Renvoie `null` si la réponse n'a pas la forme attendue (ni index ni puissance).
 */
export function parseP1Data(json: unknown, at: number): P1Reading | null {
  if (!isObject(json)) {
    return null;
  }
  const importPeak = round3(finite(json['total_power_import_t1_kwh']));
  const importOff = round3(finite(json['total_power_import_t2_kwh']));
  const exportPeak = round3(finite(json['total_power_export_t1_kwh']));
  const exportOff = round3(finite(json['total_power_export_t2_kwh']));
  const powerW = finite(json['active_power_w']);
  if ([importPeak, importOff, exportPeak, exportOff, powerW].every((v) => v === null)) {
    return null;
  }
  const tariff = json['active_tariff'];
  const model = json['meter_model'];
  return {
    at,
    powerW: powerW === null ? null : Math.round(powerW),
    quarterHourAvgW: finite(json['active_power_average_w']),
    tariff: tariff === 1 || tariff === 2 ? tariff : null,
    importPeak,
    importOff,
    exportPeak,
    exportOff,
    meterModel: typeof model === 'string' && model.trim() !== '' ? model.trim() : null,
    error: null,
  };
}

/** Lecture vide portant un message d'erreur. */
export function p1Failure(at: number, error: string): P1Reading {
  return {
    at,
    powerW: null,
    quarterHourAvgW: null,
    tariff: null,
    importPeak: null,
    importOff: null,
    exportPeak: null,
    exportOff: null,
    meterModel: null,
    error,
  };
}

/** Message lisible pour une réponse HTTP inattendue du lecteur. */
export function p1StatusError(status: number, json: unknown): string {
  const code = isObject(json) && typeof json['error'] === 'string' ? json['error'] : '';
  if (status === 403 || code === 'api:disabled' || code === 'user:unauthorized') {
    return "L'API locale du lecteur est désactivée : activez-la dans l'application HomeWizard Energy (réglages du compteur P1 → API locale).";
  }
  return `Réponse inattendue du lecteur P1 (code ${status}${code ? `, ${code}` : ''}).`;
}
