import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CardMenuDirective } from '../../cards/card-menu.directive';
import {
  StatsMonthlyTableCard,
  StatsRegistersCard,
  StatsSeasonCard,
  StatsView,
  StatsYearsChartCard,
} from '../../cards/stats/stats-cards';
import { monthlyCsv, intervalsCsv } from '../../core/calc/csv';
import type { SeasonKey } from '../../core/calc/stats';
import type { CardId } from '../../core/models/dashboard';
import { DataStore } from '../../core/services/data-store.service';
import { StorageService } from '../../core/services/storage.service';
import { ToastService } from '../../core/services/toast.service';
import { IconComponent } from '../../shared/icon.component';

@Component({
  selector: 'app-stats-page',
  imports: [
    RouterLink,
    IconComponent,
    CardMenuDirective,
    StatsSeasonCard,
    StatsYearsChartCard,
    StatsMonthlyTableCard,
    StatsRegistersCard,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './stats.page.html',
  styleUrl: './stats.page.css',
})
export default class StatsPage {
  private readonly store = inject(DataStore);
  private readonly storage = inject(StorageService);
  private readonly toast = inject(ToastService);

  protected readonly analysis = this.store.analysis;
  protected readonly view = inject(StatsView);
  protected readonly seasons: readonly { key: SeasonKey; id: CardId }[] = [
    { key: 'winter', id: 'stats-season-winter' },
    { key: 'spring', id: 'stats-season-spring' },
    { key: 'summer', id: 'stats-season-summer' },
    { key: 'autumn', id: 'stats-season-autumn' },
  ];

  protected async exportMonthly(): Promise<void> {
    await this.save(monthlyCsv(this.view.years()), 'consoelec-consommation-mensuelle.csv');
  }

  protected async exportIntervals(): Promise<void> {
    await this.save(intervalsCsv(this.analysis().consumption), 'consoelec-entre-releves.csv');
  }

  private async save(content: string, name: string): Promise<void> {
    const path = await this.storage.exportFile(content, name, 'csv');
    if (path) {
      this.toast.show(path === 'download' ? 'Fichier CSV téléchargé.' : `CSV enregistré : ${path}`);
    }
  }
}
