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
import { MazoutLinkCard } from '../../cards/link/link-cards';
import { LinkService } from '../../core/link/link.service';
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
    MazoutLinkCard,
    ...FORMAT_PIPES,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './forecast.page.html',
  styleUrl: './forecast.page.css',
})
export default class ForecastPage {
  protected readonly analysis = inject(DataStore).analysis;
  /** Résumé de ConsoMazout : le cadre « Chauffage au mazout » n'apparaît qu'une fois ce résumé publié. */
  protected readonly mazout = inject(LinkService).peer;
  protected readonly v = inject(ForecastView);
  protected readonly kpis: readonly { kind: ForecastKpi; id: CardId }[] = [
    { kind: 'hp', id: 'forecast-hp' },
    { kind: 'hc', id: 'forecast-hc' },
    { kind: 'ev', id: 'forecast-ev' },
  ];
}
