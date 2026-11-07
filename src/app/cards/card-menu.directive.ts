import { DestroyRef, Directive, ElementRef, afterNextRender, inject, input } from '@angular/core';
import type { CardId } from '../core/models/dashboard';
import { DataStore } from '../core/services/data-store.service';
import { ToastService } from '../core/services/toast.service';
import { DashboardContext } from '../pages/dashboard/dashboard-context';
import { CardInfoService } from '../shared/card-info/card-info.service';
import { ContextMenuService, type MenuItem } from '../shared/context-menu/context-menu.service';
import { CARD_DESCRIPTIONS } from './card-descriptions';
import { CARD_TITLES } from './card-titles';

/** Titre du cadre près duquel placer l'icône d'information, par ordre de préférence. */
const INFO_ANCHORS = ['h2', '.kpi-label', '.reg-head', '.label'] as const;
/** Icône « info » (cercle et i), comme celle de `IconComponent`. */
const INFO_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>';

/**
 * Cadre d'une page de données ou du tableau de bord :
 * - une icône d'information, placée après son titre, ouvre une bulle qui décrit ce que le cadre montre ;
 * - clic droit : l'ajouter au tableau de bord ou l'en retirer ; sur le tableau de bord, le déplacer ou le retirer.
 *   Un clic droit dans un champ de saisie garde le menu habituel (copier, coller…).
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
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly info = inject(CardInfoService);
  private infoButton: HTMLButtonElement | null = null;

  constructor() {
    let observer: MutationObserver | null = null;
    afterNextRender(() => {
      this.placeInfo();
      // Le contenu du cadre peut apparaître ou être recréé plus tard (données chargées, blocs @if) : l'icône suit.
      observer = new MutationObserver(() => this.placeInfo());
      observer.observe(this.host, { childList: true, subtree: true });
    });
    inject(DestroyRef).onDestroy(() => {
      observer?.disconnect();
      if (this.infoButton) {
        this.info.closeFor(this.infoButton);
      }
    });
  }

  /** Place l'icône d'information après le titre du cadre (une seule fois, de nouveau si le titre est recréé). */
  private placeInfo(): void {
    if (this.infoButton?.isConnected && this.host.contains(this.infoButton)) {
      return;
    }
    const anchor = INFO_ANCHORS.map((s) => this.host.querySelector<HTMLElement>(s)).find((a) => a !== null);
    if (!anchor) {
      return;
    }
    if (this.infoButton === null) {
      const button = this.host.ownerDocument.createElement('button');
      button.type = 'button';
      button.className = 'card-info-btn';
      button.title = 'Que montre ce cadre ?';
      button.setAttribute('aria-label', 'Que montre ce cadre ?');
      button.setAttribute('aria-expanded', 'false');
      button.innerHTML = INFO_SVG;
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const id = this.appCard();
        this.info.toggle(button, CARD_TITLES[id], CARD_DESCRIPTIONS[id]);
      });
      // Les flèches et touches du cadre (changement de jour…) ne doivent pas réagir à l'icône.
      button.addEventListener('keydown', (event) => event.stopPropagation());
      this.infoButton = button;
    }
    anchor.append(this.infoButton);
  }

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
