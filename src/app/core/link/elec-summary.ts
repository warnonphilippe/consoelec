import type { FullAnalysis } from '../calc/analysis';
import { derive } from '../calc/stats';
import { dayNumberToDate, toLocalIso } from '../calc/time';
import type { AppData, RegisterKey } from '../models/app-data.model';
import { SUMMARY_SCHEMA, type ElecSummary } from './household-summary';

/** Année de facturation en cours (`DataStore.billingYear`), réduite à ce que le résumé publie. */
export interface BillingYearInput {
  readonly start: number;
  readonly end: number;
  readonly hp: number;
  readonly hc: number;
  readonly cost: { readonly total: number };
}

/** 12 derniers mois considérés comme représentatifs d'une année. */
const MIN_COVERED_DAYS = 300;
const MONTHS = 24;

const r0 = (v: number): number => Math.round(v);
const r0n = (v: number | null): number | null => (v === null ? null : Math.round(v));
const day = (d: number): string => toLocalIso(dayNumberToDate(d)).slice(0, 10);
const sum = (values: readonly number[]): number => values.reduce((s, v) => s + v, 0);

/** Résumé de ConsoElec publié pour ConsoMazout et le serveur MCP ; `null` tant qu'il n'y a aucun relevé. */
export function buildElecSummary(
  data: AppData,
  analysis: FullAnalysis,
  billing: BillingYearInput | null,
  generatedAt: Date,
): ElecSummary | null {
  if (!analysis.hasReadings) {
    return null;
  }
  const { settings, house } = data;
  const last = analysis.last365;
  const best = analysis.base.best;

  let estimate: ElecSummary['estimationAnnuelle'];
  if (best) {
    estimate = registersEstimate(best.next12, 'prevision', `prévision « ${best.profile.label} »`);
  } else if (last && last.coveredDays >= MIN_COVERED_DAYS) {
    estimate = registersEstimate(last.values, 'derniers12Mois', `${r0(last.coveredDays)} jours mesurés`);
  } else {
    const ref = analysis.reference.registers;
    estimate = registersEstimate(
      {
        importPeak: sum(ref.importPeak),
        importOff: sum(ref.importOff),
        exportPeak: sum(ref.exportPeak),
        exportOff: sum(ref.exportOff),
      },
      'reference',
      'profil de référence',
    );
  }

  const ev = analysis.withEv?.best ?? null;
  const months = analysis.consumption.months.slice(-MONTHS);

  return {
    schema: SUMMARY_SCHEMA,
    application: 'consoelec',
    genereLe: generatedAt.toISOString(),
    estimationAnnuelle: estimate,
    avecVoitureElectrique: ev
      ? {
          soutirageKwh: r0(ev.next12.importPeak + ev.next12.importOff),
          injectionKwh: r0(ev.next12.exportPeak + ev.next12.exportOff),
        }
      : null,
    derniers12Mois: last
      ? {
          joursCouverts: r0(last.coveredDays),
          soutirageKwh: r0(last.derived.import),
          injectionKwh: r0(last.derived.export),
          joursCouvertsSolaire: r0n(last.pv?.coveredDays ?? null),
          productionPvKwh: r0n(last.pv?.derived.production ?? null),
          autoconsommeKwh: r0n(last.pv?.derived.selfConsumed ?? null),
          consommationMaisonKwh: r0n(last.pv?.derived.houseConsumption ?? null),
          autarciePct: r0n(last.pv?.derived.autarkyPct ?? null),
        }
      : null,
    annuel: analysis.years.map((y) => {
      const d = derive(y.totals, y.pvConsistent);
      return {
        annee: y.year,
        complete: y.complete,
        soutirageKwh: r0(d.import),
        injectionKwh: r0(d.export),
        productionPvKwh: r0n(d.production),
        consommationMaisonKwh: r0n(d.houseConsumption),
      };
    }),
    mensuel: months.map((m) => ({
      mois: m.key,
      complet: m.complete,
      soutirageKwh: r0(m.values.importPeak + m.values.importOff),
      injectionKwh: r0(m.values.exportPeak + m.values.exportOff),
      productionPvKwh: m.pvComplete ? r0(m.values.pv) : null,
    })),
    anneeFacturation: billing
      ? {
          du: day(billing.start),
          au: day(billing.end - 1),
          soldeHpKwh: r0(billing.hp),
          soldeHcKwh: r0(billing.hc),
          coutEstime: r0(billing.cost.total),
        }
      : null,
    prixKwh: { hp: settings.priceHp, hc: settings.priceHc },
    referenceKwhParAn: settings.referenceAnnualKwh,
    maison: {
      personnes: house.persons,
      surfaceM2: house.areaM2,
      puissancePvKwc: Math.round(house.pv.panelCount * house.pv.panelWp) / 1000,
      chaudiereMazout: house.heating.oilBoiler,
      poeleABois: house.heating.woodStove,
      noteChauffage: house.heating.note,
    },
    dernierReleve: analysis.consumption.levels.at(-1)?.reading.date ?? null,
  };
}

function registersEstimate(
  v: Readonly<Record<RegisterKey, number>>,
  source: ElecSummary['estimationAnnuelle']['source'],
  detail: string,
): ElecSummary['estimationAnnuelle'] {
  return {
    soutirageKwh: r0(v.importPeak + v.importOff),
    injectionKwh: r0(v.exportPeak + v.exportOff),
    soutirageHpKwh: r0(v.importPeak),
    soutirageHcKwh: r0(v.importOff),
    injectionHpKwh: r0(v.exportPeak),
    injectionHcKwh: r0(v.exportOff),
    source,
    detail,
  };
}
