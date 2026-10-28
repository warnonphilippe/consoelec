import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CardMenuDirective } from '../../cards/card-menu.directive';
import {
  ForecastControlsCard,
  ForecastIndexChartCard,
  ForecastKpiCard,
  ForecastMonthlyChartCard,
  ForecastProfilesCard,
  ForecastReliabilityCard,
  ForecastYearEndsCard,
  type ForecastKpi,
} from '../../cards/forecast/forecast-cards';
import { ForecastView } from '../../cards/forecast/forecast-view';
import type { CardId } from '../../core/models/dashboard';
import { DataStore } from '../../core/services/data-store.service';
import { FORMAT_PIPES } from '../../shared/format';
import { IconComponent } from '../../shared/icon.component';

@Component({
  selector: 'app-forecast-page',
  imports: [
    RouterLink,
    IconComponent,
    CardMenuDirective,
    ForecastControlsCard,
    ForecastKpiCard,
    ForecastMonthlyChartCard,
    ForecastIndexChartCard,
    ForecastReliabilityCard,
    ForecastProfilesCard,
    ForecastYearEndsCard,
    ...FORMAT_PIPES,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './forecast.page.html',
  styleUrl: './forecast.page.css',
})
export default class ForecastPage {
  protected readonly analysis = inject(DataStore).analysis;
  protected readonly v = inject(ForecastView);
  protected readonly kpis: readonly { kind: ForecastKpi; id: CardId }[] = [
    { kind: 'import', id: 'forecast-import' },
    { kind: 'export', id: 'forecast-export' },
    { kind: 'net', id: 'forecast-net' },
    { kind: 'ev', id: 'forecast-ev' },
  ];
}
