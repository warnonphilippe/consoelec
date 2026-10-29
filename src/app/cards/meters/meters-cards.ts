import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { recentPoints } from '../../core/calc/meter-log';
import { REGISTERS, type RegisterKey } from '../../core/models/app-data.model';
import { DataStore } from '../../core/services/data-store.service';
import { indexChart, splitChart } from '../../pages/meters/meters-charts';
import { ChartComponent } from '../../shared/chart/chart.component';
import { FORMAT_PIPES, fmt } from '../../shared/format';
import { IconComponent } from '../../shared/icon.component';
import { MetersView } from './meters-view';

/** Index total de soutirage ou d'injection (HP + HC), estimé aujourd'hui. */
@Component({
  selector: 'app-meter-total-card',
  imports: [IconComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card-host' },
  template: `
    @if (total(); as t) {
      <div class="card kpi">
        @if (kind() === 'import') {
          <span class="kpi-label"><app-icon name="plug" [size]="15" /> Index total de soutirage</span>
          <span class="kpi-value">{{ t | kwh }}</span>
          <span class="kpi-sub">1.8.1 + 1.8.2 · estimé aujourd'hui</span>
        } @else {
          <span class="kpi-label"><app-icon name="sun" [size]="15" /> Index total d'injection</span>
          <span class="kpi-value">{{ t | kwh }}</span>
          <span class="kpi-sub">2.8.1 + 2.8.2 · estimé aujourd'hui</span>
        }
      </div>
    }
  `,
})
export class MeterTotalCard {
  private readonly store = inject(DataStore);
  readonly kind = input.required<'import' | 'export'>();
  protected readonly total = computed(() => {
    const e = this.store.analysis().currentIndices;
    if (!e) {
      return null;
    }
    return this.kind() === 'import' ? e.importPeak + e.importOff : e.exportPeak + e.exportOff;
  });
}

/** Un sous-compteur : index estimé aujourd'hui, dernier relevé, consommation des 7 et 30 derniers jours. */
@Component({
  selector: 'app-meter-register-card',
  imports: [...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card-host' },
  styleUrl: './meters-cards.css',
  template: `
    @let c = card();
    <div class="card reg" [class]="'card reg ' + c.key">
      <div class="reg-head">
        <span class="code">{{ c.code }}</span>
        <span class="reg-label">{{ c.label }}</span>
      </div>
      <div class="reg-value">{{ c.estimated | kwh }}</div>
      <div class="small faint">
        estimé aujourd'hui
        @if (c.staleDays !== null && c.staleDays > 1) {
          · dernier relevé il y a {{ c.staleDays | num }} j
        }
      </div>
      <dl class="reg-stats">
        <div>
          <dt>Dernier relevé</dt>
          <dd>
            {{ c.lastValue | num }} <span class="faint small">{{ c.lastDay | day }}</span>
          </dd>
        </div>
        <div>
          <dt>7 jours</dt>
          <dd>{{ c.t7 | kwh }}</dd>
        </div>
        <div>
          <dt>30 jours</dt>
          <dd>
            {{ c.t30 | kwh }} <span class="faint small">{{ c.perDay30 | num: 1 }}/j</span>
          </dd>
        </div>
      </dl>
    </div>
  `,
})
export class MeterRegisterCard {
  private readonly store = inject(DataStore);
  readonly register = input.required<RegisterKey>();

  protected readonly card = computed(() => {
    const a = this.store.analysis();
    const r = REGISTERS.find((x) => x.key === this.register())!;
    const last = a.consumption.levels.at(-1);
    const t30 = a.last30?.values[r.key] ?? null;
    return {
      ...r,
      lastValue: last?.values[r.key] ?? null,
      lastDay: last?.day ?? null,
      estimated: a.currentIndices?.[r.key] ?? null,
      staleDays: last ? this.store.now() - last.day : null,
      t7: a.last7?.values[r.key] ?? null,
      t30,
      perDay30: t30 !== null && a.last30 ? t30 / Math.max(1, a.last30.coveredDays) : null,
    };
  });
}

/** Soutirage et injection moyens des 5 dernières minutes, tirés des index lus chaque minute par le port P1. */
@Component({
  selector: 'app-meter-recent-power-card',
  imports: [IconComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card-host' },
  styleUrl: './meters-cards.css',
  template: `
    <div class="card kpi">
      <span class="kpi-label">Moyennes des 5 dernières minutes</span>
      @if (view.recentPower(); as p) {
        <div class="recent-values">
          <div>
            <span class="small muted"><app-icon name="plug" [size]="14" /> Soutirage moyen</span>
            <span class="recent-value">{{ p.importW | num }} <span class="recent-unit">W</span></span>
          </div>
          <div>
            <span class="small muted"><app-icon name="sun" [size]="14" /> Injection moyenne</span>
            <span class="recent-value inject">{{ p.exportW | num }} <span class="recent-unit">W</span></span>
          </div>
        </div>
        <span class="kpi-sub">de {{ time(p.from) }} à {{ time(p.to) }} · lu sur le compteur (port P1)</span>
      } @else {
        <p class="muted small">Pas encore 5 minutes de lectures récentes du compteur (port P1).</p>
      }
    </div>
  `,
})
export class MeterRecentPowerCard {
  protected readonly view = inject(MetersView);
  /** `AAAA-MM-JJTHH:mm` → `HH:mm`. */
  protected time(at: string): string {
    return at.slice(11, 16);
  }
}

/** Index cumulés : relevés, lectures du jour et prévision, avec le choix de la période et des courbes. */
@Component({
  selector: 'app-meter-index-chart-card',
  imports: [ChartComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card-host' },
  styleUrl: './meters-cards.css',
  template: `
    <div class="card">
      <div class="card-header">
        <h2>Index cumulés</h2>
        <div class="row">
          <div class="segmented" role="radiogroup" aria-label="Historique">
            @for (o of view.historyOptions; track o.label) {
              <button
                type="button"
                role="radio"
                [attr.aria-checked]="view.historyDays() === o.days"
                [class.active]="view.historyDays() === o.days"
                (click)="view.historyDays.set(o.days)"
              >
                {{ o.label }}
              </button>
            }
          </div>
          <div class="segmented" role="radiogroup" aria-label="Prévision">
            @for (o of view.forecastOptions; track o.label) {
              <button
                type="button"
                role="radio"
                [attr.aria-checked]="view.forecastDays() === o.days"
                [class.active]="view.forecastDays() === o.days"
                (click)="view.forecastDays.set(o.days)"
              >
                {{ o.label }}
              </button>
            }
          </div>
        </div>
      </div>
      <div class="toggles">
        @for (r of registers; track r.key) {
          <button
            type="button"
            [class]="'toggle ' + r.key + (view.shown().has(r.key) ? ' on' : '')"
            (click)="view.toggle(r.key)"
          >
            <span class="legend-dot"></span> {{ r.short }}
          </button>
        }
      </div>
      <app-chart [build]="chart()" [height]="340" />
    </div>
  `,
})
export class MeterIndexChartCard {
  private readonly store = inject(DataStore);
  protected readonly view = inject(MetersView);
  protected readonly registers = REGISTERS;
  protected readonly chart = computed(() => {
    const days = this.view.historyDays();
    const now = this.store.now();
    const analysis = this.store.analysis();
    return indexChart(
      analysis,
      analysis.base.best,
      recentPoints(this.store.data().meterLog, Date.now()),
      [...this.view.shown()],
      days === null ? null : now - days,
      this.view.forecastDays(),
      now,
    );
  });
}

/** Répartition heures pleines / creuses du soutirage ou de l'injection sur les 12 derniers mois. */
@Component({
  selector: 'app-meter-split-card',
  imports: [ChartComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card-host' },
  template: `
    <div class="card">
      <div class="card-header">
        <h2>{{ kind() === 'import' ? 'Soutirage' : 'Injection' }} : heures pleines / creuses</h2>
        <span class="hint">12 derniers mois</span>
      </div>
      @if (chart(); as b) {
        <app-chart [build]="b" [height]="230" />
      } @else {
        <p class="muted">Pas encore assez de relevés.</p>
      }
    </div>
  `,
})
export class MeterSplitCard {
  private readonly store = inject(DataStore);
  readonly kind = input.required<'import' | 'export'>();
  protected readonly chart = computed(() => {
    const v = this.store.analysis().last365?.values;
    if (!v) {
      return null;
    }
    return this.kind() === 'import'
      ? splitChart(v.importPeak, v.importOff, 'importPeak', 'importOff')
      : splitChart(v.exportPeak, v.exportOff, 'exportPeak', 'exportOff');
  });
}

export type BalancePeriod = 'to-date' | 'current-year' | 'next-year';

/**
 * Soldes de facturation HP / HC : mesurés du début de l'année de facturation à la dernière lecture, ou prévus à la fin
 * de l'année en cours ou de la suivante, avec les kWh à payer et le surplus.
 */
@Component({
  selector: 'app-meter-balance-card',
  imports: [...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card-host' },
  styleUrl: './meters-cards.css',
  template: `
    @if (balance(); as b) {
      <div class="card kpi">
        <span class="kpi-label">{{ b.label }}</span>
        <div class="balance-values">
          <span [class.tone-warning]="b.hp > 0" [class.tone-success]="b.hp <= 0">HP {{ b.hp | skwh }}</span>
          <span [class.tone-warning]="b.hc > 0" [class.tone-success]="b.hc <= 0">HC {{ b.hc | skwh }}</span>
        </div>
        <span class="kpi-sub">
          à payer : {{ (b.hp > 0 ? b.hp : 0) + (b.hc > 0 ? b.hc : 0) | kwh }}
          @if (b.hp < 0 || b.hc < 0) {
            · {{ b.toDate ? 'surplus' : 'surplus non remboursé' }} :
            {{ (b.hp < 0 ? -b.hp : 0) + (b.hc < 0 ? -b.hc : 0) | kwh }}
          }
          @if (b.coveredFrom !== null) {
            <br />relevés depuis le {{ b.coveredFrom | day }} seulement
          }
        </span>
      </div>
    }
  `,
})
export class MeterBalanceCard {
  private readonly store = inject(DataStore);
  readonly period = input.required<BalancePeriod>();

  protected readonly balance = computed(() => {
    const years = this.store.billing().years;
    const period = this.period();
    const y = period === 'next-year' ? years[1] : years[0];
    if (!y) {
      return null;
    }
    const from = fmt.date(y.settledFrom ?? y.start);
    if (period === 'to-date') {
      const d = y.toDate;
      return d
        ? {
            label: `À ce jour · du ${from} au ${fmt.date(d.day)} · mesuré`,
            hp: d.hp,
            hc: d.hc,
            toDate: true,
            coveredFrom: y.coveredFrom,
          }
        : null;
    }
    return {
      label: `Année du ${from} au ${fmt.date(y.end - 1)}${y.forecast ? ' · prévision' : ''}`,
      hp: y.hp,
      hc: y.hc,
      toDate: false,
      coveredFrom: y.coveredFrom,
    };
  });
}
