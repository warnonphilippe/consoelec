import { Directive, inject, input } from '@angular/core';
import type { CardId } from '../core/models/dashboard';
import { DataStore } from '../core/services/data-store.service';
import { ToastService } from '../core/services/toast.service';
import { DashboardContext } from '../pages/dashboard/dashboard-context';
import { ContextMenuService, type MenuItem } from '../shared/context-menu/context-menu.service';
import { CARD_TITLES } from './card-titles';

/**
 * Clic droit sur un cadre : l'ajouter au tableau de bord ou l'en retirer ; sur le tableau de bord, le déplacer ou le
 * retirer. Un clic droit dans un champ de saisie garde le menu habituel (copier, coller…).
 */
@Directive({
  selector: '[appCard]',
  host: { '(contextmenu)': 'open($event)' },
})
export class CardMenuDirective {
  readonly appCard = input.required<CardId>();

  private readonly store = inject(DataStore);
  private readonly menus = inject(ContextMenuService);
  private readonly toast = inject(ToastService);
  /** Présent seulement sur le tableau de bord. */
  private readonly dashboard = inject(DashboardContext, { optional: true });

  protected open(event: MouseEvent): void {
    if ((event.target as Element | null)?.closest('input, textarea, select, [contenteditable="true"]')) {
      return;
    }
    const id = this.appCard();
    const layout = this.store.dashboard();
    const present = layout.includes(id);
    const remove: MenuItem = {
      label: 'Retirer du dashboard',
      icon: 'x',
      action: () => this.toggle(id, false),
    };
    const shown = this.dashboard?.shown();
    const items: MenuItem[] = shown
      ? [
          {
            label: 'Monter',
            icon: 'chevron-up',
            disabled: shown.indexOf(id) <= 0,
            action: () => this.store.moveDashboardCard(id, -1, shown),
          },
          {
            label: 'Descendre',
            icon: 'chevron-down',
            disabled: shown.indexOf(id) === shown.length - 1,
            action: () => this.store.moveDashboardCard(id, 1, shown),
          },
          remove,
        ]
      : [present ? remove : { label: 'Ajouter au dashboard', icon: 'plus', action: () => this.toggle(id, true) }];
    this.menus.open(event, items);
  }

  private toggle(id: CardId, add: boolean): void {
    this.store.toggleDashboardCard(id);
    this.toast.show(
      `${CARD_TITLES[id]} : ${add ? 'ajouté au tableau de bord' : 'retiré du tableau de bord'}.`,
      add ? 'success' : 'info',
    );
  }
}
