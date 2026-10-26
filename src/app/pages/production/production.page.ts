import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  expectedDailyProduction,
  productionDays,
  productionMonths,
  productionSummary,
} from '../../core/calc/production';
import { measuredYield } from '../../core/calc/pv-yield';
import { yearMonthOf } from '../../core/calc/time';
import { pvKwp } from '../../core/models/app-data.model';
import { DataStore } from '../../core/services/data-store.service';
import { InverterService } from '../../core/services/inverter.service';
import { ChartComponent } from '../../shared/chart/chart.component';
import { FORMAT_PIPES } from '../../shared/format';
import { IconComponent } from '../../shared/icon.component';
import { LiveProductionComponent } from '../../shared/live-production/live-production.component';
import { dailyChart, monthlyChart, yearTotals, yearlyChart } from './production-charts';

type View = 'days' | 'months' | 'all' | 'years';

@Component({
  selector: 'app-production-page',
  imports: [RouterLink, IconComponent, ChartComponent, LiveProductionComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './production.page.html',
  styleUrl: './production.page.css',
})
export default class ProductionPage {
  protected readonly store = inject(DataStore);
  protected readonly inverter = inject(InverterService);

  protected readonly kwp = computed(() => pvKwp(this.store.house().pv));
  protected readonly views = [
    { id: 'days', label: '30 jours' },
    { id: 'months', label: '12 mois' },
    { id: 'all', label: 'Tous les mois' },
    { id: 'years', label: 'Par année' },
  ] as const;
  protected readonly view = signal<View>('days');

  private readonly expected = computed(() => expectedDailyProduction(this.store.analysis().reference));
  protected readonly days = computed(() => {
    const d = this.store.data();
    return productionDays(d.pvDaily, d.readings, this.expected(), this.store.now());
  });
  protected readonly months = computed(() => productionMonths(this.days(), this.expected()));
  protected readonly summary = computed(() =>
    productionSummary(this.days(), this.store.now(), this.store.house().pv.inverterKva),
  );
  protected readonly yield = computed(() =>
    measuredYield(this.store.data().pvDaily, this.store.analysis().reference, this.kwp()),
  );

  /** Année civile en cours : production des jours couverts et attendu sur ces mêmes jours. */
  protected readonly thisYear = computed(() => {
    const { year } = yearMonthOf(Math.floor(this.store.now()));
    const months = this.months().filter((m) => m.year === year);
    if (months.length === 0) {
      return null;
    }
    return {
      year,
      kwh: months.reduce((s, m) => s + m.kwh, 0),
      expected: months.reduce((s, m) => s + (m.complete ? m.expected : m.expectedCovered), 0),
      fullYear: this.store.analysis().reference.annual.production,
    };
  });

  protected readonly chart = computed(() => {
    const today = Math.floor(this.store.now());
    switch (this.view()) {
      case 'days':
        return dailyChart(this.days().filter((d) => d.day > today - 30));
      case 'months': {
        const { year, month } = yearMonthOf(today);
        const from = year * 12 + month - 11;
        return monthlyChart(this.months().filter((m) => m.year * 12 + m.month >= from));
      }
      case 'all':
        return monthlyChart(this.months());
      case 'years':
        return yearlyChart(yearTotals(this.months()));
    }
  });

  constructor() {
    void this.inverter.loadHistory();
  }

  /** Écart en % par rapport à l'attendu (arrondi), ou `null`. */
  protected diffPct(kwh: number, expected: number): number | null {
    return expected > 0 ? Math.round((kwh / expected - 1) * 100) : null;
  }
}
