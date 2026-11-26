import { Injectable, computed, inject, signal } from '@angular/core';
import { evAnnualKwh } from '../../core/calc/ev';
import type { Values } from '../../core/calc/consumption';
import type { Forecast, ProfileKey } from '../../core/calc/forecast';
import { DataStore } from '../../core/services/data-store.service';

/**
 * Choix de la page Prévisions (profil, avec ou sans la voiture prévue) et prévision qui en découle, partagés par ses
 * cadres, qu'ils soient sur la page ou sur le tableau de bord.
 */
@Injectable({ providedIn: 'root' })
export class ForecastView {
  private readonly store = inject(DataStore);
  private readonly analysis = this.store.analysis;

  /** Voiture électrique prévue : inclure son effet dans les prévisions. */
  readonly withEv = signal(true);
  readonly profileKey = signal<ProfileKey | null>(null);

  readonly ev = computed(() => this.store.house().ev);
  readonly evKwh = computed(() => evAnnualKwh(this.ev()));
  readonly hasEvScenario = computed(() => this.analysis().withEv !== null);

  /** Ensemble de prévisions affiché : avec ou sans la voiture prévue. */
  readonly set = computed(() => {
    const a = this.analysis();
    return this.withEv() && a.withEv ? a.withEv : a.base;
  });

  readonly selected = computed<Forecast | null>(() => {
    const set = this.set();
    const key = this.profileKey();
    return (key && set.forecasts[key]) || set.best;
  });

  readonly profiles = computed(() => this.set().profiles);
  readonly bestKey = computed(() => this.set().best?.profile.key ?? null);

  /**
   * Prévision des 12 prochains mois par compteur : heures pleines (1.8.1 / 2.8.1) et heures creuses (1.8.2 / 2.8.2).
   * Les deux périodes se facturent séparément (l'injection en heures creuses ne compense pas le soutirage en heures
   * pleines) : aucun total HP + HC n'est donc affiché.
   */
  readonly summary = computed(() => {
    const f = this.selected();
    if (!f) {
      return null;
    }
    const last = this.analysis().last365;
    return {
      next: byPeriod(f.next12),
      last: last ? byPeriod(last.values) : null,
      profile: f.profile.label,
    };
  });

  /** Écart apporté par la voiture prévue sur 12 mois. */
  readonly evImpact = computed(() => {
    const a = this.analysis();
    const base = a.base.best;
    const car = a.withEv?.best;
    if (!base || !car) {
      return null;
    }
    const delta = (k: keyof Forecast['next12']): number => car.next12[k] - base.next12[k];
    return {
      hp: { import: delta('importPeak'), export: delta('exportPeak') },
      hc: { import: delta('importOff'), export: delta('exportOff') },
    };
  });
}

/** Soutirage, injection et solde d'un compteur (kWh). */
export interface PeriodFigures {
  readonly import: number;
  readonly export: number;
  /** Soutirage − injection : positif = à payer, négatif = surplus non remboursé. */
  readonly net: number;
}

export function byPeriod(
  v: Pick<Values, 'importPeak' | 'importOff' | 'exportPeak' | 'exportOff'>,
): { readonly hp: PeriodFigures; readonly hc: PeriodFigures } {
  return {
    hp: { import: v.importPeak, export: v.exportPeak, net: v.importPeak - v.exportPeak },
    hc: { import: v.importOff, export: v.exportOff, net: v.importOff - v.exportOff },
  };
}
