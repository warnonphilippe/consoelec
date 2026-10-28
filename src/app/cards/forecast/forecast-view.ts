import { Injectable, computed, inject, signal } from '@angular/core';
import { evAnnualKwh } from '../../core/calc/ev';
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

  readonly summary = computed(() => {
    const f = this.selected();
    if (!f) {
      return null;
    }
    const n = f.next12;
    const imp = n.importPeak + n.importOff;
    const exp = n.exportPeak + n.exportOff;
    const last = this.analysis().last365;
    return {
      import: imp,
      export: exp,
      net: imp - exp,
      offPeakPct: imp > 0 ? (n.importOff / imp) * 100 : null,
      lastImport: last?.derived.import ?? null,
      lastExport: last?.derived.export ?? null,
      lastNet: last?.derived.net ?? null,
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
    const sum = (f: Forecast, ...keys: (keyof Forecast['next12'])[]): number =>
      keys.reduce((s, k) => s + f.next12[k], 0);
    return {
      importDelta: sum(car, 'importPeak', 'importOff') - sum(base, 'importPeak', 'importOff'),
      exportDelta: sum(car, 'exportPeak', 'exportOff') - sum(base, 'exportPeak', 'exportOff'),
      offDelta: car.next12.importOff - base.next12.importOff,
    };
  });
}
