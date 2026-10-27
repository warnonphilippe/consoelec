import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DataStore } from '../../core/services/data-store.service';
import { balanceChart } from '../../pages/meters/meters-charts';
import { ChartComponent } from '../chart/chart.component';
import { FORMAT_PIPES } from '../format';

/**
 * Carte « Graphique des soldes » : soldes de facturation HP / HC de l'année (soutiré − injecté par période
 * tarifaire), mesurés puis prévus, avec, en option, le résumé de l'année en cours et de la suivante.
 */
@Component({
  selector: 'app-balance-card',
  imports: [RouterLink, ChartComponent, ...FORMAT_PIPES],
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

  /** « 1er novembre » : début de l'année de facturation, lisible. */
  protected readonly billingStartLabel = computed(() => {
    const [month, day] = this.store.settings().billingStart.split('-').map(Number) as [number, number];
    const name = new Intl.DateTimeFormat('fr-BE', { month: 'long' }).format(new Date(2026, month - 1, 1));
    return `${day === 1 ? '1er' : day} ${name}`;
  });

  /** Fin de l'année de facturation (veille du début de la suivante), pour l'affichage. */
  protected lastDayOf(end: number): number {
    return end - 1;
  }
}
