import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * Lecture des résumés publiés par ConsoElec et ConsoMazout (format décrit dans
 * `src/app/core/link/household-summary.ts`, recopié dans les deux applications).
 */

export const LINK_DIR_ENV = 'CONSO_MAISON_DIR';
export const SUMMARY_SCHEMA = 1;
export const MAZOUT_KWH_PER_LITER = 10;
export const STALE_AFTER_DAYS = 60;
/** Période mesurée considérée comme représentative d'une année. */
export const MIN_YEAR_DAYS = 300;
export const APPS = /** @type {const} */ (['consoelec', 'consomazout']);

const LABELS = { consoelec: 'ConsoElec', consomazout: 'ConsoMazout' };

/** Dossier d'échange : `CONSO_MAISON_DIR` (absolu, `~` accepté), sinon `~/.config/conso-maison`. */
export function resolveLinkDir(env = process.env, home = homedir()) {
  const v = env[LINK_DIR_ENV]?.trim();
  if (v) {
    const expanded = v === '~' ? home : /^~[\\/]/.test(v) ? join(home, v.slice(2)) : v;
    if (isAbsolute(expanded)) return resolve(expanded);
  }
  return join(home, '.config', 'conso-maison');
}

/**
 * Résumé d'une application : `{ app, status, ageJours?, summary? }`, `status` valant `ok`, `absent` (jamais publié),
 * `invalide` (illisible) ou `incompatible` (autre version du format).
 */
export async function readSummary(dir, app, nowMs = Date.now()) {
  let text;
  try {
    text = await readFile(join(dir, `${app}.json`), 'utf-8');
  } catch {
    return { app, status: 'absent' };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { app, status: 'invalide' };
  }
  if (value === null || typeof value !== 'object' || value.application !== app || typeof value.genereLe !== 'string') {
    return { app, status: 'invalide' };
  }
  if (value.schema !== SUMMARY_SCHEMA) {
    return { app, status: 'incompatible', schema: value.schema };
  }
  return { app, status: 'ok', ageJours: ageDays(value.genereLe, nowMs), summary: value };
}

export function ageDays(iso, nowMs) {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? Math.max(0, Math.floor((nowMs - at) / 86_400_000)) : null;
}

/** Phrase expliquant pourquoi un résumé manque ou s'il est ancien. */
export function statusNote(entry) {
  const name = LABELS[entry.app];
  switch (entry.status) {
    case 'absent':
      return `${name} n'a encore rien publié sur cet ordinateur (ouvrir l'application, avec au moins un relevé, suffit).`;
    case 'invalide':
      return `Le résumé de ${name} est illisible : il sera réécrit à la prochaine ouverture de l'application.`;
    case 'incompatible':
      return `Le résumé de ${name} utilise une autre version du format (${entry.schema}) : mettre à jour ce serveur MCP.`;
    default:
      return entry.ageJours !== null && entry.ageJours > STALE_AFTER_DAYS
        ? `Le résumé de ${name} date de ${entry.ageJours} jours : ouvrir l'application pour le rafraîchir.`
        : null;
  }
}

const round = (v) => (v === null || v === undefined ? null : Math.round(v));

/** Vue d'ensemble de l'énergie de la maison à partir des deux résumés (chacun peut manquer). */
export function householdOverview(elecEntry, mazoutEntry) {
  const elec = elecEntry.status === 'ok' ? elecEntry.summary : null;
  const mazout = mazoutEntry.status === 'ok' ? mazoutEntry.summary : null;

  // Consommation réelle de la maison (soutirage + autoconsommation) seulement si elle couvre presque une année.
  const last = elec?.derniers12Mois ?? null;
  const houseKwh = (last?.joursCouvertsSolaire ?? 0) >= MIN_YEAR_DAYS ? last.consommationMaisonKwh : null;
  const importKwh = elec?.estimationAnnuelle?.soutirageKwh ?? null;
  const electricityKwh = houseKwh ?? importKwh;
  const mazoutKwh = mazout?.estimationAnnuelle?.equivalentKwh ?? null;
  const total = electricityKwh !== null && mazoutKwh !== null ? electricityKwh + mazoutKwh : null;

  const elecCost = elec?.anneeFacturation?.coutEstime ?? null;
  const mazoutCost = mazout?.estimationAnnuelle?.coutEstime ?? null;

  return {
    synthese: {
      electricite: elec
        ? {
            soutiragePrevu12MoisKwh: importKwh,
            injectionPrevue12MoisKwh: elec.estimationAnnuelle?.injectionKwh ?? null,
            derniers12Mois: last,
            coutAnneeFacturation: elecCost,
          }
        : null,
      mazout: mazout
        ? {
            litresParAn: mazout.estimationAnnuelle.litres,
            equivalentKwhParAn: mazoutKwh,
            coutParAn: mazoutCost,
            commanderAvantLe: mazout.cuve?.commanderAvantLe ?? null,
          }
        : null,
      energieTotaleKwhParAn: total,
      baseElectricite: electricityKwh === null ? null : houseKwh !== null ? 'consommation de la maison' : 'soutirage',
      partMazoutPct: total !== null && total > 0 ? round((mazoutKwh / total) * 100) : null,
      coutTotalParAn: elecCost !== null && mazoutCost !== null ? elecCost + mazoutCost : null,
      conversion: `1 L de mazout ≈ ${MAZOUT_KWH_PER_LITER} kWh (PCI), dont environ 85 % en chaleur utile`,
    },
    remarques: [statusNote(elecEntry), statusNote(mazoutEntry)].filter((n) => n !== null),
    consoelec: entryPayload(elecEntry),
    consomazout: entryPayload(mazoutEntry),
  };
}

/** Contenu d'un résumé tel que renvoyé par les outils (avec son âge), ou son état. */
export function entryPayload(entry) {
  return entry.status === 'ok'
    ? { ageJours: entry.ageJours, ...entry.summary }
    : { status: entry.status, remarque: statusNote(entry) };
}
