import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CardMenuDirective } from '../../cards/card-menu.directive';
import {
  MeterBalanceCard,
  MeterIndexChartCard,
  MeterRecentPowerCard,
  MeterRegisterCard,
  MeterSplitCard,
  MeterTotalCard,
} from '../../cards/meters/meters-cards';
import { MetersView } from '../../cards/meters/meters-view';
import { REGISTERS } from '../../core/models/app-data.model';
import { DataStore } from '../../core/services/data-store.service';
import { BalanceCardComponent } from '../../shared/balance-card/balance-card.component';
import { IconComponent } from '../../shared/icon.component';

@Component({
  selector: 'app-meters-page',
  imports: [
    RouterLink,
    IconComponent,
    CardMenuDirective,
    BalanceCardComponent,
    MeterBalanceCard,
    MeterTotalCard,
    MeterRegisterCard,
    MeterRecentPowerCard,
      MeterIndexChartCard,
    MeterSplitCard,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './meters.page.html',
  styleUrl: './meters.page.css',
})
export default class MetersPage {
  protected readonly analysis = inject(DataStore).analysis;
  protected readonly view = inject(MetersView);
  protected readonly registerCards = REGISTERS.map((r) => ({ key: r.key, id: `meters-register-${r.key}` as const }));
}
