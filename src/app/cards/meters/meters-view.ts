import { Injectable, computed, inject, signal } from '@angular/core';
import { recentAveragePower, todayEnergy } from '../../core/calc/meter-log';
import { REGISTERS, type RegisterKey } from '../../core/models/app-data.model';
import { DataStore } from '../../core/services/data-store.service';

/**
 * Choix de la page Compteurs (période, prévision, courbes affichées), partagés par ses cadres, qu'ils soient sur la
 * page ou sur le tableau de bord.
 */
@Injectable({ providedIn: 'root' })
export class MetersView {
  private readonly store = inject(DataStore);

  readonly historyOptions = [
    { label: '6 mois', days: 183 },
    { label: '1 an', days: 365 },
    { label: '2 ans', days: 730 },
    { label: 'Tout', days: null },
  ] as const;
  readonly forecastOptions = [
    { label: 'Sans prévision', days: 0 },
    { label: '+ 6 mois', days: 183 },
    { label: '+ 12 mois', days: 365 },
  ] as const;
  readonly historyDays = signal<number | null>(365);
  readonly forecastDays = signal(183);
  /** Courbes affichées par « Index cumulés ». */
  readonly shown = signal<ReadonlySet<RegisterKey>>(new Set(REGISTERS.map((r) => r.key)));

  /** Soutirage et injection moyens des 5 dernières minutes, lus par le port P1 (rafraîchis à chaque lecture). */
  readonly recentPower = computed(() => {
    this.store.now();
    return recentAveragePower(this.store.data().meterLog, Date.now());
  });
  /** Soutirage et injection du jour en cours, lus par le port P1 (rafraîchis à chaque lecture). */
  readonly todayEnergy = computed(() => {
    this.store.now();
    return todayEnergy(this.store.data().meterLog, Date.now());
  });

  toggle(key: RegisterKey): void {
    this.shown.update((set) => {
      const next = new Set(set);
      if (next.has(key)) {
        if (next.size > 1) {
          next.delete(key);
        }
      } else {
        next.add(key);
      }
      return next;
    });
  }
}
