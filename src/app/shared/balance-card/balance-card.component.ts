import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { DataStore } from '../../core/services/data-store.service';
import { balanceChart } from '../../pages/meters/meters-charts';
import { ChartComponent } from '../chart/chart.component';
import { FORMAT_PIPES } from '../format';

/**
 * Carte « Graphique des soldes » : soldes de facturation HP / HC de l'année (soutiré − injecté par période
 * tarifaire), mesurés puis prévus, avec les courbes limites et, en option, un résumé : soldes mesurés à ce jour, puis
 * fin de l'année en cours et de la suivante (kWh à payer et surplus).
 */
@Component({
  selector: 'app-balance-card',
  imports: [ChartComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './balance-card.component.html',
  styleUrl: './balance-card.component.css',
})
export class BalanceCardComponent {
  protected readonly store = inject(DataStore);

  /** Affiche sous le graphique le résumé des deux années de facturation. */
  readonly summary = input(true);

  protected readonly historyOptions = [
    { label: '6 mois', days: 183 },
    { label: '1 an', days: 365 },
    { label: '2 ans', days: 730 },
    { label: 'Tout', days: null },
  ] as const;
  protected readonly forecastOptions = [
    { label: 'Sans prévision', days: 0 },
    { label: '+ 6 mois', days: 183 },
    { label: '+ 12 mois', days: 365 },
  ] as const;
  protected readonly balanceHistoryDays = signal<number | null>(365);
  protected readonly balanceForecastDays = signal(365);

  protected readonly balanceChart = computed(() => {
    const days = this.balanceHistoryDays();
    const now = this.store.now();
    return balanceChart(
      this.store.billing(),
      this.store.analysis().consumption.levels.map((l) => l.day),
      days === null ? null : now - days,
      this.balanceForecastDays(),
      now,
    );
  });

  /** Fin de l'année de facturation (veille du début de la suivante), pour l'affichage. */
  protected lastDayOf(end: number): number {
    return end - 1;
  }
}
