import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { monthlyCsv, intervalsCsv } from '../../core/calc/csv';
import { derive, type SeasonKey, type SeasonStat } from '../../core/calc/stats';
import { MONTH_SHORT } from '../../core/calc/time';
import { REGISTERS } from '../../core/models/app-data.model';
import { DataStore } from '../../core/services/data-store.service';
import { StorageService } from '../../core/services/storage.service';
import { ToastService } from '../../core/services/toast.service';
import { ChartComponent } from '../../shared/chart/chart.component';
import { FORMAT_PIPES } from '../../shared/format';
import { IconComponent, type IconName } from '../../shared/icon.component';
import { yearsChart } from './stats-charts';
import {
  METRICS,
  metricValue,
  monthAverages,
  referenceValue,
  type MetricKey,
} from './stats-metrics';

@Component({
  selector: 'app-stats-page',
  imports: [RouterLink, IconComponent, ChartComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './stats.page.html',
  styleUrl: './stats.page.css',
})
export default class StatsPage {
  private readonly store = inject(DataStore);
  private readonly storage = inject(StorageService);
  private readonly toast = inject(ToastService);

  protected readonly analysis = this.store.analysis;
  protected readonly monthShort = MONTH_SHORT;
  protected readonly registers = REGISTERS;
  protected readonly seasonIcon: Record<SeasonKey, IconName> = {
    winter: 'flame',
    spring: 'sparkles',
    summer: 'sun',
    autumn: 'calendar',
  };

  protected readonly metric = signal<MetricKey>('import');
  protected readonly hasPv = computed(() => this.analysis().hasPv);
  protected readonly metrics = computed(() => METRICS.filter((m) => !m.needsPv || this.hasPv()));
  protected readonly years = computed(() => this.analysis().years);

  protected readonly rows = computed(() =>
    this.years().map((row) => ({
      year: row.year,
      cells: row.months.map((b) =>
        b ? { value: metricValue(this.metric(), b), complete: b.complete } : null,
      ),
      total: row.months.reduce((s, b) => s + ((b && metricValue(this.metric(), b)) || 0), 0),
      complete: row.complete,
    })),
  );
  protected readonly averages = computed(() =>
    monthAverages(this.metric(), this.analysis().consumption.months),
  );
  protected readonly averageTotal = computed(() => {
    const values = this.averages();
    return values.every((v) => v !== null) ? values.reduce((s, v) => s + v!, 0) : null;
  });
  protected readonly referenceRow = computed(() =>
    Array.from({ length: 12 }, (_, m) =>
      referenceValue(this.metric(), this.analysis().reference, m),
    ),
  );
  protected readonly referenceTotal = computed(() =>
    this.referenceRow().reduce((a, b) => a + b, 0),
  );
  protected readonly chart = computed(() =>
    yearsChart(this.metric(), this.years(), this.analysis().reference),
  );

  /** Totaux par année et par registre. */
  protected readonly yearDetails = computed(() =>
    this.years().map((row) => ({
      year: row.year,
      complete: row.complete,
      totals: row.totals,
      derived: derive(row.totals, row.pvConsistent),
    })),
  );

  protected ratio(value: number, reference: number): number | null {
    return reference > 0 ? (value / reference) * 100 : null;
  }

  protected seasons(): SeasonStat[] {
    return this.analysis().seasons;
  }

  protected async exportMonthly(): Promise<void> {
    await this.save(monthlyCsv(this.years()), 'consoelec-consommation-mensuelle.csv');
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
