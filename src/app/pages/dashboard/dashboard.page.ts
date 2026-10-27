import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { pvKwp } from '../../core/models/app-data.model';
import { DataStore } from '../../core/services/data-store.service';
import { InverterService } from '../../core/services/inverter.service';
import { ToastService } from '../../core/services/toast.service';
import { BalanceCardComponent } from '../../shared/balance-card/balance-card.component';
import { FORMAT_PIPES } from '../../shared/format';
import { IconComponent, type IconName } from '../../shared/icon.component';
import { LiveProductionComponent } from '../../shared/live-production/live-production.component';

/** Période tarifaire d'un panneau de solde : ce qui est compensé ensemble sur la facture. */
interface Period {
  readonly key: 'hp' | 'hc';
  readonly label: string;
  readonly codes: string;
  readonly icon: IconName;
  readonly importKey: 'importPeak' | 'importOff';
  readonly exportKey: 'exportPeak' | 'exportOff';
}

@Component({
  selector: 'app-dashboard-page',
  imports: [RouterLink, IconComponent, LiveProductionComponent, BalanceCardComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './dashboard.page.html',
  styleUrl: './dashboard.page.css',
})
export default class DashboardPage {
  protected readonly store = inject(DataStore);
  protected readonly inverter = inject(InverterService);
  private readonly toast = inject(ToastService);

  protected readonly analysis = this.store.analysis;
  protected readonly kwp = computed(() => pvKwp(this.store.house().pv));
  protected readonly lastReading = computed(
    () => this.analysis().consumption.levels.at(-1) ?? null,
  );

  protected readonly periods: readonly Period[] = [
    {
      key: 'hp',
      label: 'Heures pleines',
      codes: '1.8.1 − 2.8.1',
      icon: 'sun',
      importKey: 'importPeak',
      exportKey: 'exportPeak',
    },
    {
      key: 'hc',
      label: 'Heures creuses',
      codes: '1.8.2 − 2.8.2',
      icon: 'moon',
      importKey: 'importOff',
      exportKey: 'exportOff',
    },
  ];

  protected loadDemo(): void {
    this.store.loadDemo();
    this.toast.show(
      'Données de démonstration chargées. Vous pourrez les effacer dans les réglages.',
      'info',
    );
  }
}
