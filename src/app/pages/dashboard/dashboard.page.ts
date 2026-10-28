import { NgComponentOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CardMenuDirective } from '../../cards/card-menu.directive';
import { CARD_TITLES } from '../../cards/card-titles';
import { DEFAULT_DASHBOARD } from '../../core/models/dashboard';
import { pvKwp } from '../../core/models/app-data.model';
import { DataStore } from '../../core/services/data-store.service';
import { InverterService } from '../../core/services/inverter.service';
import { P1Service } from '../../core/services/p1.service';
import { ToastService } from '../../core/services/toast.service';
import { ContextMenuService, type MenuItem } from '../../shared/context-menu/context-menu.service';
import { FORMAT_PIPES } from '../../shared/format';
import { DashboardContext } from './dashboard-context';
import { IconComponent } from '../../shared/icon.component';

@Component({
  selector: 'app-dashboard-page',
  imports: [
    RouterLink,
    IconComponent,
    NgComponentOutlet,
    CardMenuDirective,
    ...FORMAT_PIPES,
  ],
  providers: [DashboardContext],
  host: { '(contextmenu)': 'onContextMenu($event)' },
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './dashboard.page.html',
  styleUrl: './dashboard.page.css',
})
export default class DashboardPage {
  protected readonly store = inject(DataStore);
  protected readonly inverter = inject(InverterService);
  protected readonly p1 = inject(P1Service);
  private readonly toast = inject(ToastService);

  protected readonly analysis = this.store.analysis;
  protected readonly kwp = computed(() => pvKwp(this.store.house().pv));
  protected readonly lastReading = computed(
    () => this.analysis().consumption.levels.at(-1) ?? null,
  );

  protected readonly cards = inject(DashboardContext).cards;
  private readonly menus = inject(ContextMenuService);

  /**
   * Clic droit hors des cadres : remettre un cadre propre au tableau de bord (compteur en direct, soldes…) qu'on en a
   * retiré, ou revenir au tableau de bord d'origine.
   */
  protected onContextMenu(event: MouseEvent): void {
    const layout = this.store.dashboard();
    const items: MenuItem[] = DEFAULT_DASHBOARD.filter((id) => !layout.includes(id)).map((id) => ({
      label: `Remettre : ${CARD_TITLES[id]}`,
      icon: 'plus',
      action: () => this.store.toggleDashboardCard(id),
    }));
    if (layout.join() !== DEFAULT_DASHBOARD.join()) {
      items.push({
        label: "Rétablir le tableau de bord d'origine",
        icon: 'refresh',
        action: () => {
          this.store.resetDashboard();
          this.toast.show("Tableau de bord d'origine rétabli.", 'info');
        },
      });
    }
    if (items.length > 0) {
      this.menus.open(event, items);
    }
  }

  protected loadDemo(): void {
    this.store.loadDemo();
    this.toast.show(
      'Données de démonstration chargées. Vous pourrez les effacer dans les réglages.',
      'info',
    );
  }
}
