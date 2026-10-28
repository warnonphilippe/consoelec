import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, input } from '@angular/core';
import { dayNumberToDate, toDayNumber, yearMonthOf } from '../../core/calc/time';
import { DataStore } from '../../core/services/data-store.service';
import {
  dailyChart,
  dayCurveChart,
  monthlyChart,
  yearTotals,
  yearlyChart,
} from '../../pages/production/production-charts';
import { ChartComponent } from '../../shared/chart/chart.component';
import { FORMAT_PIPES } from '../../shared/format';
import { IconComponent } from '../../shared/icon.component';
import { ProductionView, diffPct } from './production-view';

/** Détail d'une journée : courbe de puissance, production, attendu et puissance maximale, avec navigation. */
@Component({
  selector: 'app-production-day-card',
  imports: [DatePipe, IconComponent, ChartComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card-host' },
  styleUrl: './production-cards.css',
  template: `
    <section
      class="card day-detail"
      tabindex="0"
      aria-label="Détail du jour"
      (keydown.arrowleft)="onArrow($event, -1)"
      (keydown.arrowright)="onArrow($event, 1)"
    >
      <div class="card-header day-head">
        <div>
          <h2>{{ v.dayTitle() }}</h2>
          <span class="hint">courbe de puissance · flèches ← → du clavier pour changer de jour</span>
        </div>
        <div class="day-nav">
          <button
            type="button"
            class="icon-btn"
            title="Jour précédent"
            aria-label="Jour précédent"
            [disabled]="v.day() <= v.firstDay()"
            (click)="v.step(-1)"
          >
            <app-icon name="chevron-left" [size]="16" />
          </button>
          <input
            type="date"
            class="input day-input"
            aria-label="Choisir la date"
            [value]="v.dayIso()"
            [min]="v.firstIso()"
            [max]="v.todayIso()"
            (change)="pickDate($any($event.target).value)"
          />
          <button
            type="button"
            class="icon-btn"
            title="Jour suivant"
            aria-label="Jour suivant"
            [disabled]="v.isToday()"
            (click)="v.step(1)"
          >
            <app-icon name="chevron-right" [size]="16" />
          </button>
          <button type="button" class="btn sm" [disabled]="v.isToday()" (click)="v.showDay(v.today())">
            Aujourd'hui
          </button>
        </div>
      </div>

      @let info = v.dayInfo();
      <div class="day-stats">
        <div>
          <span class="day-value">{{ info.kwh === null ? '—' : (info.kwh | num: 1) }}</span>
          <span class="small faint"
            >kWh {{ v.isToday() ? 'produits jusqu’ici' : 'produits' }}
            @if (info.status; as s) {
              · {{ s }}
            }
          </span>
        </div>
        <div>
          <span class="day-value">{{ info.expected | num: 1 }}</span>
          <span class="small faint">kWh attendus (référence)</span>
        </div>
        <div>
          <span class="day-value">{{ v.peak() === null ? '—' : (v.peak()!.powerW | num) }}</span>
          <span class="small faint"
            >W au maximum
            @if (v.peak(); as p) {
              · à {{ p.at | date: 'HH:mm' }}
            }
          </span>
        </div>
      </div>

      @if (v.dayPoints().length >= 2) {
        <app-chart [build]="chart()" [height]="240" />
      } @else {
        <p class="small faint day-empty">
          @if (!v.isToday() && v.curveLoading()) {
            Lecture de la courbe dans le journal de l'onduleur…
          } @else if (v.curveError(); as e) {
            Courbe indisponible : {{ e }}
          } @else if (v.isToday()) {
            La courbe de la journée apparaîtra après quelques lectures de l'onduleur.
          } @else {
            Le journal de l'onduleur ne contient pas de courbe pour ce jour (il ne garde les relevés aux 5 minutes
            que sur une période limitée).
          }
        </p>
      }
    </section>
  `,
})
export class ProductionDayCard {
  protected readonly v = inject(ProductionView);
  protected readonly chart = computed(() =>
    dayCurveChart(
      this.v.dayPoints(),
      dayNumberToDate(this.v.day()).getTime(),
      this.v.isToday() ? Date.now() : null,
    ),
  );

  constructor() {
    const host = inject(ElementRef<HTMLElement>);
    const seen = this.v.revealDetail();
    effect(() => {
      if (this.v.revealDetail() !== seen) {
        host.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });
  }

  /** Flèches du clavier sur la carte du détail (pas dans le champ de date, qui les utilise lui-même). */
  protected onArrow(event: Event, delta: number): void {
    if (event.target instanceof HTMLInputElement) {
      return;
    }
    event.preventDefault();
    this.v.step(delta);
  }

  protected pickDate(value: string): void {
    const day = Math.floor(toDayNumber(value));
    if (Number.isFinite(day)) {
      this.v.showDay(day);
    }
  }
}

export type ProductionKpi = '7d' | '30d' | 'year' | 'best-day' | 'yield';

/** Chiffre clé de la production : 7 ou 30 derniers jours, année en cours, meilleure journée, rendement mesuré. */
@Component({
  selector: 'app-production-kpi-card',
  imports: [IconComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card-host' },
  styleUrl: './production-cards.css',
  template: `
    @switch (kind()) {
      @case ('7d') {
        @if (v.summary().last7; as w) {
          <div class="card kpi">
            <span class="kpi-label"><app-icon name="sun" [size]="15" /> 7 derniers jours</span>
            <span class="kpi-value">{{ w.kwh | kwh }}</span>
            <span class="kpi-sub">
              {{ w.kwh / w.days | num: 1 }} kWh par jour
              @let d = diffPct(w.kwh, w.expected);
              @if (d !== null) {
                <br /><span [class.tone-success]="d > 0" [class.tone-warning]="d < -25"
                  >{{ d > 0 ? '+' : '' }}{{ d }} % vs attendu</span
                >
              }
            </span>
          </div>
        }
      }
      @case ('30d') {
        @if (v.summary().last30; as w) {
          <div class="card kpi">
            <span class="kpi-label"><app-icon name="calendar" [size]="15" /> 30 derniers jours</span>
            <span class="kpi-value">{{ w.kwh | kwh }}</span>
            <span class="kpi-sub">
              attendu ~{{ w.expected | kwh }}
              @if (w.days < 30) {
                <br />sur {{ w.days }} jour{{ w.days > 1 ? 's' : '' }} connus
              }
            </span>
          </div>
        }
      }
      @case ('year') {
        @if (v.thisYear(); as y) {
          <div class="card kpi">
            <span class="kpi-label"><app-icon name="chart" [size]="15" /> Année {{ y.year }}</span>
            <span class="kpi-value">{{ y.kwh | kwh }}</span>
            <span class="kpi-sub">
              attendu ~{{ y.expected | kwh }} sur la même période<br />
              ~{{ y.fullYear | kwh }} sur une année complète
            </span>
          </div>
        }
      }
      @case ('best-day') {
        @if (v.summary().best; as b) {
          <div class="card kpi">
            <span class="kpi-label"><app-icon name="trend" [size]="15" /> Meilleure journée</span>
            <span class="kpi-value">{{ b.kwh | kwh: 1 }}</span>
            <span class="kpi-sub">le {{ b.day | day: 'long' }}</span>
          </div>
        }
      }
      @case ('yield') {
        <div class="card kpi">
          <span class="kpi-label"><app-icon name="bolt" [size]="15" /> Rendement mesuré</span>
          @if (v.yield(); as y) {
            <span class="kpi-value">{{ y.kwhPerKwp | num }} <small>kWh/kWc/an</small></span>
            <span class="kpi-sub"
              >réglage : {{ store.settings().specificYieldKwhPerKwp | num }} kWh/kWc · sur
              {{ y.days | num }} jours</span
            >
          } @else {
            <span class="kpi-value faint">—</span>
            <span class="kpi-sub">après deux semaines de lectures de l'onduleur</span>
          }
        </div>
      }
    }
  `,
})
export class ProductionKpiCard {
  protected readonly store = inject(DataStore);
  protected readonly v = inject(ProductionView);
  readonly kind = input.required<ProductionKpi>();
  protected readonly diffPct = diffPct;
}

/** Historique de la production : barres par jour, par mois ou par année, avec l'attendu. */
@Component({
  selector: 'app-production-history-card',
  imports: [ChartComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card-host' },
  styleUrl: './production-cards.css',
  template: `
    <div class="card">
      <div class="card-header">
        <h2>Production solaire</h2>
        <div class="segmented" role="radiogroup" aria-label="Période">
          @for (o of v.views; track o.id) {
            <button
              type="button"
              role="radio"
              [attr.aria-checked]="v.view() === o.id"
              [class.active]="v.view() === o.id"
              (click)="v.view.set(o.id)"
            >
              {{ o.label }}
            </button>
          }
        </div>
      </div>
      <app-chart [build]="chart()" [height]="320" />
      <p class="small faint legend-note">
        Barres pâles : journée estimée à partir des index qui l'encadrent, journée en cours ou période incomplète.
        L'attendu vient du modèle de référence ({{ store.settings().specificYieldKwhPerKwp | num }} kWh/kWc,
        écrêtage de l'onduleur compris).
      </p>
    </div>
  `,
})
export class ProductionHistoryCard {
  protected readonly store = inject(DataStore);
  protected readonly v = inject(ProductionView);

  protected readonly chart = computed(() => {
    const today = Math.floor(this.store.now());
    switch (this.v.view()) {
      case 'days':
        return dailyChart(
          this.v.days().filter((d) => d.day > today - 30),
          (day) => this.v.showDay(day, true),
        );
      case 'months': {
        const { year, month } = yearMonthOf(today);
        const from = year * 12 + month - 11;
        return monthlyChart(this.v.months().filter((m) => m.year * 12 + m.month >= from));
      }
      case 'all':
        return monthlyChart(this.v.months());
      case 'years':
        return yearlyChart(yearTotals(this.v.months()));
    }
  });
}
