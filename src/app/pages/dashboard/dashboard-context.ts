import { Injectable, computed, inject } from '@angular/core';
import { CARDS } from '../../cards/card-registry';
import type { CardId } from '../../core/models/dashboard';
import { DataStore } from '../../core/services/data-store.service';
import { InverterService } from '../../core/services/inverter.service';
import { P1Service } from '../../core/services/p1.service';

/**
 * Cadres affichés par le tableau de bord, dans l'ordre. Fourni par la page du tableau de bord : le menu d'un cadre
 * qui le trouve sait qu'il est sur le tableau de bord (monter, descendre, retirer).
 */
@Injectable()
export class DashboardContext {
  private readonly store = inject(DataStore);
  private readonly p1 = inject(P1Service);
  private readonly inverter = inject(InverterService);

  /** Cadres choisis ; ceux qui n'ont rien à montrer (lecteur P1 désactivé, aucune année de facturation…) sont omis. */
  readonly cards = computed(() =>
    this.store
      .dashboard()
      .filter((id) => this.available(id))
      .map((id) => ({ id, def: CARDS[id] })),
  );
  readonly shown = computed(() => this.cards().map((c) => c.id));

  private available(id: CardId): boolean {
    switch (id) {
      case 'live-meter':
        return this.p1.settings().enabled;
      case 'live-production':
        return this.inverter.settings().enabled;
      case 'billing-hp':
      case 'billing-hc':
      case 'billing-cost':
        return this.store.billingYear() !== null;
      default:
        return true;
    }
  }
}
