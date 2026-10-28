import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CardMenuDirective } from '../../cards/card-menu.directive';
import {
  ProductionDayCard,
  ProductionHistoryCard,
  ProductionKpiCard,
  type ProductionKpi,
} from '../../cards/production/production-cards';
import { ProductionView } from '../../cards/production/production-view';
import type { CardId } from '../../core/models/dashboard';
import { DataStore } from '../../core/services/data-store.service';
import { InverterService } from '../../core/services/inverter.service';
import { FORMAT_PIPES } from '../../shared/format';
import { IconComponent } from '../../shared/icon.component';
import { LiveProductionComponent } from '../../shared/live-production/live-production.component';

@Component({
  selector: 'app-production-page',
  imports: [
    RouterLink,
    IconComponent,
    CardMenuDirective,
    LiveProductionComponent,
    ProductionDayCard,
    ProductionKpiCard,
    ProductionHistoryCard,
    ...FORMAT_PIPES,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './production.page.html',
  styleUrl: './production.page.css',
})
export default class ProductionPage {
  protected readonly store = inject(DataStore);
  protected readonly inverter = inject(InverterService);
  protected readonly v = inject(ProductionView);

  protected readonly kpis: readonly { kind: ProductionKpi; id: CardId }[] = [
    { kind: '7d', id: 'production-7d' },
    { kind: '30d', id: 'production-30d' },
    { kind: 'year', id: 'production-year' },
    { kind: 'best-day', id: 'production-best-day' },
    { kind: 'yield', id: 'production-yield' },
  ];
}
