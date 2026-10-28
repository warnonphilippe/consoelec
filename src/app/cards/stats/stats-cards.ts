import { ChangeDetectionStrategy, Component, Injectable, computed, inject, input, signal } from '@angular/core';
import { derive, type SeasonKey } from '../../core/calc/stats';
import { MONTH_SHORT } from '../../core/calc/time';
import { REGISTERS } from '../../core/models/app-data.model';
import { DataStore } from '../../core/services/data-store.service';
import { yearsChart } from '../../pages/stats/stats-charts';
import {
  METRICS,
  metricValue,
  monthAverages,
  referenceValue,
  type MetricKey,
} from '../../pages/stats/stats-metrics';
import { ChartComponent } from '../../shared/chart/chart.component';
import { FORMAT_PIPES } from '../../shared/format';
import { IconComponent, type IconName } from '../../shared/icon.component';

/** Indicateur choisi de la page Statistiques (graphique et tableau mensuel), sur la page comme au tableau de bord. */
@Injectable({ providedIn: 'root' })
export class StatsView {
  private readonly store = inject(DataStore);

  readonly metric = signal<MetricKey>('import');
  readonly hasPv = computed(() => this.store.analysis().hasPv);
  readonly metrics = computed(() => METRICS.filter((m) => !m.needsPv || this.hasPv()));
  readonly metricLabel = computed(() => METRICS.find((m) => m.key === this.metric())?.label ?? '');
  readonly years = computed(() => this.store.analysis().years);
}

const SEASON_ICON: Record<SeasonKey, IconName> = {
  winter: 'flame',
  spring: 'sparkles',
  summer: 'sun',
  autumn: 'calendar',
};

/** Une saison : soutirage et injection moyens, comparés à la référence. */
@Component({
  selector: 'app-stats-season-card',
  imports: [IconComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card-host' },
  styleUrl: './stats-cards.css',
  template: `
    @if (stat(); as s) {
      <div class="card kpi season" [class]="'card kpi season ' + s.key">
        <span class="kpi-label"><app-icon [name]="icon[s.key]" [size]="15" /> {{ s.label }}</span>
        <div class="season-row">
          <span class="faint small">Soutirage</span>
          <span class="season-value">
            @if (s.import.averageTotal !== null) {
              {{ s.import.averageTotal | kwh }}
            } @else {
              <span class="faint">—</span>
            }
          </span>
        </div>
        <span class="kpi-sub">
          @if (s.import.averageTotal !== null) {
            {{ ratio(s.import.averageTotal, s.import.referenceTotal) | num }} % de la référence ({{
              s.import.referenceTotal | kwh
            }})
          } @else {
            référence : {{ s.import.referenceTotal | kwh }}
          }
        </span>
        <div class="season-row">
          <span class="faint small">Injection</span>
          <span class="season-value">
            @if (s.export.averageTotal !== null) {
              {{ s.export.averageTotal | kwh }}
            } @else {
              <span class="faint">—</span>
            }
          </span>
        </div>
        <span class="kpi-sub">
          @if (s.export.averageTotal !== null) {
            {{ ratio(s.export.averageTotal, s.export.referenceTotal) | num }} % de la référence ({{
              s.export.referenceTotal | kwh
            }})
          } @else {
            référence : {{ s.export.referenceTotal | kwh }}
          }
        </span>
        <span class="kpi-sub faint small"
          >{{ monthShort[s.months[0]!] }} · {{ monthShort[s.months[1]!] }} · {{ monthShort[s.months[2]!] }}</span
        >
      </div>
    }
  `,
})
export class StatsSeasonCard {
  private readonly store = inject(DataStore);
  readonly season = input.required<SeasonKey>();
  protected readonly icon = SEASON_ICON;
  protected readonly monthShort = MONTH_SHORT;
  protected readonly stat = computed(
    () => this.store.analysis().seasons.find((s) => s.key === this.season()) ?? null,
  );

  protected ratio(value: number, reference: number): number | null {
    return reference > 0 ? (value / reference) * 100 : null;
  }
}

/** Comparaison des années, mois par mois, pour l'indicateur choisi. */
@Component({
  selector: 'app-stats-years-chart-card',
  imports: [ChartComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card-host' },
  template: `
    <div class="card">
      <div class="card-header">
        <h2>Comparaison des années</h2>
        <div class="segmented" role="radiogroup" aria-label="Indicateur">
          @for (m of view.metrics(); track m.key) {
            <button
              type="button"
              role="radio"
              [attr.aria-checked]="view.metric() === m.key"
              [class.active]="view.metric() === m.key"
              (click)="view.metric.set(m.key)"
            >
              {{ m.label }}
            </button>
          }
        </div>
      </div>
      <app-chart [build]="chart()" [height]="300" />
      @if (!view.hasPv() && store.analysis().hasIntervals) {
        <p class="small faint">
          Production solaire totale et consommation de la maison : encodez l'index de l'onduleur dans les relevés pour
          les afficher.
        </p>
      }
    </div>
  `,
})
export class StatsYearsChartCard {
  protected readonly store = inject(DataStore);
  protected readonly view = inject(StatsView);
  protected readonly chart = computed(() =>
    yearsChart(this.view.metric(), this.view.years(), this.store.analysis().reference),
  );
}

/** Tableau mensuel de l'indicateur choisi : années, moyenne et référence belge. */
@Component({
  selector: 'app-stats-monthly-table-card',
  imports: [...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card-host' },
  styleUrl: './stats-cards.css',
  template: `
    <div class="card flush">
      <div class="card-header">
        <h2>Tableau mensuel</h2>
        <span class="hint"
          >{{ view.metricLabel() }} en kWh · <span class="partial-sample">valeur pâle</span> = mois incomplet (exclu
          des moyennes)</span
        >
      </div>
      <div class="table-wrap">
        <table class="table month-table">
          <thead>
            <tr>
              <th>Année</th>
              @for (m of monthShort; track m) {
                <th class="num">{{ m }}</th>
              }
              <th class="num">Total</th>
            </tr>
          </thead>
          <tbody>
            @for (row of rows(); track row.year) {
              <tr>
                <td>
                  <strong>{{ row.year }}</strong>
                </td>
                @for (cell of row.cells; track $index) {
                  <td class="num" [class.partial]="cell && !cell.complete">
                    @if (cell && cell.value !== null) {
                      {{ cell.value | num }}
                    } @else {
                      <span class="faint">—</span>
                    }
                  </td>
                }
                <td class="num" [class.partial]="!row.complete">
                  <strong>{{ row.total | num }}</strong>
                </td>
              </tr>
            }
            <tr class="avg-row">
              <td>Moyenne</td>
              @for (v of averages(); track $index) {
                <td class="num">
                  @if (v !== null) {
                    {{ v | num }}
                  } @else {
                    <span class="faint">—</span>
                  }
                </td>
              }
              <td class="num">
                @if (averageTotal() !== null) {
                  {{ averageTotal() | num }}
                } @else {
                  <span class="faint">—</span>
                }
              </td>
            </tr>
            <tr class="ref-row">
              <td>Référence belge</td>
              @for (v of referenceRow(); track $index) {
                <td class="num">{{ v | num }}</td>
              }
              <td class="num">{{ referenceTotal() | num }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  `,
})
export class StatsMonthlyTableCard {
  private readonly store = inject(DataStore);
  protected readonly view = inject(StatsView);
  protected readonly monthShort = MONTH_SHORT;

  protected readonly rows = computed(() =>
    this.view.years().map((row) => ({
      year: row.year,
      cells: row.months.map((b) =>
        b ? { value: metricValue(this.view.metric(), b), complete: b.complete } : null,
      ),
      total: row.months.reduce((s, b) => s + ((b && metricValue(this.view.metric(), b)) || 0), 0),
      complete: row.complete,
    })),
  );
  protected readonly averages = computed(() =>
    monthAverages(this.view.metric(), this.store.analysis().consumption.months),
  );
  protected readonly averageTotal = computed(() => {
    const values = this.averages();
    return values.every((v) => v !== null) ? values.reduce((s, v) => s + v!, 0) : null;
  });
  protected readonly referenceRow = computed(() =>
    Array.from({ length: 12 }, (_, m) => referenceValue(this.view.metric(), this.store.analysis().reference, m)),
  );
  protected readonly referenceTotal = computed(() => this.referenceRow().reduce((a, b) => a + b, 0));
}

/** Totaux par année et par sous-compteur, avec soldes et indicateurs solaires. */
@Component({
  selector: 'app-stats-registers-card',
  imports: [...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card-host' },
  template: `
    @if (yearDetails().length > 0) {
      <div class="card flush">
        <div class="card-header">
          <h2>Détail par sous-compteur</h2>
          <span class="hint">kWh par année</span>
        </div>
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>Année</th>
                @for (r of registers; track r.key) {
                  <th class="num">{{ r.short }}</th>
                }
                <th class="num">Soutirage</th>
                <th class="num">Injection</th>
                <th class="num">Solde net</th>
                <th class="num">HC / soutirage</th>
                @if (view.hasPv()) {
                  <th class="num">Autoconso.</th>
                  <th class="num">Autarcie</th>
                }
              </tr>
            </thead>
            <tbody>
              @for (y of yearDetails(); track y.year) {
                <tr>
                  <td>
                    <strong>{{ y.year }}</strong>
                    @if (!y.complete) {
                      <span class="badge" title="Année incomplète">partielle</span>
                    }
                  </td>
                  @for (r of registers; track r.key) {
                    <td class="num">{{ y.totals[r.key] | num }}</td>
                  }
                  <td class="num">{{ y.derived.import | num }}</td>
                  <td class="num">{{ y.derived.export | num }}</td>
                  <td class="num">{{ y.derived.net | skwh }}</td>
                  <td class="num">{{ y.derived.offPeakPct | pct }}</td>
                  @if (view.hasPv()) {
                    <td class="num">{{ y.derived.selfConsumptionPct | pct }}</td>
                    <td class="num">{{ y.derived.autarkyPct | pct }}</td>
                  }
                </tr>
              }
            </tbody>
          </table>
        </div>
      </div>
    }
  `,
})
export class StatsRegistersCard {
  protected readonly view = inject(StatsView);
  protected readonly registers = REGISTERS;
  protected readonly yearDetails = computed(() =>
    this.view.years().map((row) => ({
      year: row.year,
      complete: row.complete,
      totals: row.totals,
      derived: derive(row.totals, row.pvConsistent),
    })),
  );
}
