import type { FullAnalysis } from '../calc/analysis';
import { type Values } from '../calc/consumption';
import { derive } from '../calc/stats';
import { dayNumberToDate, toLocalIso } from '../calc/time';
import { REGISTER_KEYS, type AppData, type RegisterKey } from '../models/app-data.model';

const MAX_READINGS = 400;

const r0 = (v: number): number => Math.round(v);
const r1 = (v: number): number => Math.round(v * 10) / 10;

function registersOf(
  values: Record<RegisterKey, number>,
  round: (v: number) => number = r0,
): Record<RegisterKey, number> {
  return Object.fromEntries(REGISTER_KEYS.map((k) => [k, round(values[k])])) as Record<
    RegisterKey,
    number
  >;
}

function derivedOf(values: Values, withPv: boolean): Record<string, number | null> {
  const d = derive(values, withPv);
  return {
    soutirageKwh: r0(d.import),
    injectionKwh: r0(d.export),
    soldeNetKwh: r0(d.net),
    partSoutirageHeuresCreusesPct: d.offPeakPct === null ? null : r0(d.offPeakPct),
    productionPvKwh: d.production === null ? null : r0(d.production),
    autoconsommeKwh: d.selfConsumed === null ? null : r0(d.selfConsumed),
    consommationMaisonKwh: d.houseConsumption === null ? null : r0(d.houseConsumption),
    tauxAutoconsommationPct: d.selfConsumptionPct === null ? null : r0(d.selfConsumptionPct),
    autarciePct: d.autarkyPct === null ? null : r0(d.autarkyPct),
  };
}

function pvIndicators(d: ReturnType<typeof derive>): Record<string, number | null> {
  return {
    productionPvKwh: d.production === null ? null : r0(d.production),
    autoconsommeKwh: d.selfConsumed === null ? null : r0(d.selfConsumed),
    consommationMaisonKwh: d.houseConsumption === null ? null : r0(d.houseConsumption),
    tauxAutoconsommationPct: d.selfConsumptionPct === null ? null : r0(d.selfConsumptionPct),
    autarciePct: d.autarkyPct === null ? null : r0(d.autarkyPct),
  };
}

/** Instantané compact de toutes les données de l'application, à joindre au contexte de l'assistant. */
export function buildDataSnapshot(
  data: AppData,
  analysis: FullAnalysis,
  now: number,
): Record<string, unknown> {
  const { settings, house } = data;
  const intervalByTo = new Map(analysis.consumption.intervals.map((i) => [i.to.reading.id, i]));
  const readings = analysis.consumption.levels.slice(-MAX_READINGS).map((level) => {
    const interval = intervalByTo.get(level.reading.id);
    return {
      date: level.reading.date,
      index: {
        soutirageHP: level.reading.importPeak,
        soutirageHC: level.reading.importOff,
        injectionHP: level.reading.exportPeak,
        injectionHC: level.reading.exportOff,
        productionPvTotale: level.reading.pvTotal,
      },
      ...(interval
        ? {
            joursDepuisPrecedent: r1(interval.days),
            variationKwh: Object.fromEntries(
              REGISTER_KEYS.map((k) => [
                k,
                interval.delta[k] === null ? null : r1(interval.delta[k]!),
              ]),
            ),
            alertes: interval.anomalies,
          }
        : {}),
      ...(level.reading.note ? { note: level.reading.note } : {}),
    };
  });

  const months = analysis.consumption.months.map((m) => ({
    mois: m.key,
    complet: m.complete,
    ...registersOf(m.values),
    productionPv: m.pvComplete ? r0(m.values.pv) : null,
  }));

  const years = analysis.years.map((y) => ({
    annee: y.year,
    complete: y.complete,
    ...derivedOf(y.totals, y.pvConsistent),
  }));

  const forecastOf = (set: FullAnalysis['base'] | null): Record<string, unknown> | null => {
    if (set === null) {
      return null;
    }
    return {
      profilsDisponibles: set.profiles.map((p) => ({
        profil: p.label,
        disponible: p.available,
        note: p.note,
      })),
      profilRetenu: set.best?.profile.label ?? null,
      prochains12MoisKwh: set.best ? registersOf(set.best.next12) : null,
      prochains12MoisParProfil: Object.fromEntries(
        Object.entries(set.forecasts).map(([key, f]) => [key, registersOf(f.next12)]),
      ),
      prevuParMoisKwh: set.best
        ? set.best.months.slice(0, 18).map((m) => ({ mois: m.key, ...registersOf(m.values) }))
        : null,
    };
  };

  const period = (p: FullAnalysis['last365']): Record<string, unknown> | null =>
    p === null
      ? null
      : {
          joursCouverts: r0(p.coveredDays),
          ...registersOf({
            importPeak: p.values.importPeak,
            importOff: p.values.importOff,
            exportPeak: p.values.exportPeak,
            exportOff: p.values.exportOff,
          }),
          ...derivedOf(p.values, false),
          indicateursSolaires:
            p.pv === null
              ? null
              : { joursCouverts: r0(p.pv.coveredDays), ...pvIndicators(p.pv.derived) },
        };

  const ref = analysis.reference;
  return {
    aujourdhui: toLocalIso(dayNumberToDate(now)),
    maison: house,
    reglages: {
      consommationAnnuelleReferenceKwh: settings.referenceAnnualKwh,
      partHivernalePct: settings.winterSharePct,
      presenceEnJournee: settings.presence,
      heuresCreuses: {
        debutNuit: settings.offPeakStartHour,
        finNuit: settings.offPeakEndHour,
        weekendsEnHeuresCreuses: settings.offPeakWeekends,
      },
      rendementKwhParKwc: settings.specificYieldKwhPerKwp,
    },
    productionTotaleEncodee: analysis.hasPv,
    releves: readings,
    mensuel: months,
    annuel: years,
    moyennesMensuellesComplets: Object.fromEntries(
      REGISTER_KEYS.map((k) => [
        k,
        analysis.averages.registers[k].map((v) => (v === null ? null : r0(v))),
      ]),
    ),
    saisons: analysis.seasons.map((s) => ({
      saison: s.label,
      soutirageMoyenParSaison: s.import.averageTotal === null ? null : r0(s.import.averageTotal),
      injectionMoyenneParSaison: s.export.averageTotal === null ? null : r0(s.export.averageTotal),
      soutirageReference: r0(s.import.referenceTotal),
      injectionReference: r0(s.export.referenceTotal),
    })),
    derniers12Mois: period(analysis.last365),
    derniers30Jours: period(analysis.last30),
    derniers7Jours: period(analysis.last7),
    referenceBelge: {
      parMoisKwh: Object.fromEntries(REGISTER_KEYS.map((k) => [k, ref.registers[k].map(r0)])),
      annuel: Object.fromEntries(Object.entries(ref.annual).map(([k, v]) => [k, r0(v)])),
    },
    previsions: forecastOf(analysis.base),
    previsionsAvecVoiture: forecastOf(analysis.withEv),
    fiabiliteObservee: analysis.backtest
      ? Object.fromEntries(
          Object.entries(analysis.backtest.scores).map(([key, s]) => [
            key,
            { erreurMoyennePct: r0(s.error * 100), moisTestes: s.samples },
          ]),
        )
      : null,
    indexEstimesAujourdhui: analysis.currentIndices
      ? registersOf(analysis.currentIndices, r1)
      : null,
  };
}

const ROLE = `Tu es l'assistant d'analyse énergétique intégré à ConsoElec, une application de suivi de la consommation et de la production d'électricité d'une maison unifamiliale belge de 4 personnes équipée de panneaux solaires, d'une chaudière au mazout (eau chaude et une partie du chauffage) et d'un poêle à bois d'appoint. Une voiture électrique est envisagée plus tard.

Tu as accès à toutes les données de l'application (instantané JSON ci-dessous) et tu dois t'y appuyer pour répondre. Réponds en français, de façon claire, structurée et concise ; chiffre tes réponses en kWh et cite les mois ou périodes concernés.

Glossaire :
- Le compteur intelligent donne quatre index cumulés en kWh : soutirage heures pleines (HP, 1.8.1), soutirage heures creuses (HC, 1.8.2), injection HP (2.8.1), injection HC (2.8.2). « Consommation » côté compteur = soutirage depuis le réseau ; « production » côté compteur = injection sur le réseau. Ce n'est NI la production solaire totale NI la consommation réelle de la maison.
- Solde net = soutirage − injection (négatif = la maison a injecté plus qu'elle n'a soutiré).
- Si la production photovoltaïque totale est encodée (productionTotaleEncodee = true) : autoconsommation = production − injection ; consommation de la maison = soutirage + autoconsommation ; taux d'autoconsommation = autoconsommation / production ; autarcie = autoconsommation / consommation de la maison. Sinon, ces indicateurs ne sont pas mesurés : dis-le et propose d'encoder cet index.
- Les mois « complets » sont entièrement couverts par des relevés ; les mois incomplets sont partiels. Les répartitions mensuelles sont reconstituées entre deux relevés au prorata de la saison, donc approximatives si les relevés sont espacés.
- La « référence belge » est un profil de maison type calculé avec les réglages de l'utilisateur (ordres de grandeur, pas des mesures officielles).
- Chauffage et eau chaude au mazout : l'électricité ne sert qu'aux auxiliaires (circulateurs, brûleur) ; ne lui attribue pas la consommation de chauffage.
- Installation solaire (voir « maison ») : le nombre et la puissance des panneaux donnent la puissance crête ; l'onduleur (kVA) écrête la production quand les panneaux dépassent sa puissance (perte estimée dans « referenceBelge.annuel.clipped »). Un onduleur triphasé n'a pas d'effet sur l'énergie.
- Radiateur électrique d'appoint (« surplusHeater ») : branché de temps en temps d'octobre à avril sur le surplus solaire ; il consomme de l'électricité autoproduite (l'injection baisse, le soutirage ne change pas) et compte dans la consommation de la maison.
- Les prévisions sont de trois types (statistique belge, statistique ajustée, historique de la maison) ; « fiabiliteObservee » donne l'erreur moyenne de chaque profil sur les mois déjà mesurés. Cite cette fiabilité quand tu parles d'une prévision.

Règles : ne devine pas ; si une donnée manque ou est trop incertaine, dis-le. Signale les relevés suspects (index en baisse, valeurs aberrantes, longues périodes sans relevé). Donne des conseils concrets (décaler des usages vers le solaire ou les heures creuses, dimensionnement d'une batterie ou d'une borne de recharge, etc.) sans promettre d'économies précises ni donner de conseil financier ou juridique garanti.`;

/** Contexte complet (rôle + données) passé en `system` à Claude. */
export function buildSystemPrompt(data: AppData, analysis: FullAnalysis, now: number): string {
  return `${ROLE}\n\n<donnees>\n${JSON.stringify(buildDataSnapshot(data, analysis, now))}\n</donnees>`;
}
