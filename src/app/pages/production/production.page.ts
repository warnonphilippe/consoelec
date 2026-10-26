import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import {
  expectedDailyProduction,
  productionDays,
  productionMonths,
  productionSummary,
} from '../../core/calc/production';
import { measuredYield } from '../../core/calc/pv-yield';
import { dayNumberToDate, toDayNumber, toLocalIso, yearMonthOf } from '../../core/calc/time';
import { pvKwp } from '../../core/models/app-data.model';
import { DataStore } from '../../core/services/data-store.service';
import { InverterService, type PowerPoint } from '../../core/services/inverter.service';
import { ChartComponent } from '../../shared/chart/chart.component';
import { FORMAT_PIPES } from '../../shared/format';
import { IconComponent } from '../../shared/icon.component';
import { LiveProductionComponent } from '../../shared/live-production/live-production.component';
import {
  STATUS_LABEL,
  dailyChart,
  dayCurveChart,
  monthlyChart,
  yearTotals,
  yearlyChart,
} from './production-charts';

type View = 'days' | 'months' | 'all' | 'years';

const isoDay = (day: number): string => toLocalIso(dayNumberToDate(day)).slice(0, 10);
const DAY_TITLE = new Intl.DateTimeFormat('fr-BE', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

@Component({
  selector: 'app-production-page',
  imports: [RouterLink, DatePipe, IconComponent, ChartComponent, LiveProductionComponent, ...FORMAT_PIPES],
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

  // --- Détail d'une journée ------------------------------------------------------------------

  protected readonly today = computed(() => Math.floor(this.store.now()));
  /** Jour affiché dans le détail ; `null` = aujourd'hui (suit le changement de date). */
  private readonly picked = signal<number | null>(null);
  protected readonly day = computed(() => this.picked() ?? this.today());
  protected readonly isToday = computed(() => this.day() === this.today());
  protected readonly dayIso = computed(() => isoDay(this.day()));
  protected readonly todayIso = computed(() => isoDay(this.today()));
  protected readonly firstDay = computed(() => Math.min(this.days()[0]?.day ?? this.today(), this.today()));
  protected readonly firstIso = computed(() => isoDay(this.firstDay()));
  protected readonly dayTitle = computed(() => {
    const title = DAY_TITLE.format(dayNumberToDate(this.day()));
    return title.charAt(0).toUpperCase() + title.slice(1);
  });
  protected readonly dayInfo = computed(() => {
    const day = this.day();
    const entry = this.days().find((d) => d.day === day);
    const live = this.isToday() ? this.inverter.fresh() : null;
    const kwh = live?.dayWh != null ? live.dayWh / 1000 : (entry?.kwh ?? null);
    return {
      kwh,
      expected: entry?.expected ?? this.expected()(day),
      status: entry ? STATUS_LABEL[entry.status] : null,
    };
  });

  private readonly pastCurve = signal<{ date: string; points: readonly PowerPoint[]; error: string | null } | null>(
    null,
  );
  protected readonly curveLoading = signal(false);
  protected readonly dayPoints = computed<readonly PowerPoint[]>(() => {
    if (this.isToday()) {
      return this.inverter.todayCurve();
    }
    const curve = this.pastCurve();
    return curve?.date === this.dayIso() ? curve.points : [];
  });
  protected readonly curveError = computed(() => {
    const curve = this.pastCurve();
    return !this.isToday() && curve?.date === this.dayIso() ? curve.error : null;
  });
  protected readonly peak = computed(() =>
    this.dayPoints().reduce<PowerPoint | null>((best, p) => (best === null || p.powerW > best.powerW ? p : best), null),
  );
  protected readonly dayChart = computed(() =>
    dayCurveChart(this.dayPoints(), dayNumberToDate(this.day()).getTime()),
  );
  private readonly detail = viewChild<ElementRef<HTMLElement>>('detail');

  protected readonly chart = computed(() => {
    const today = Math.floor(this.store.now());
    switch (this.view()) {
      case 'days':
        return dailyChart(
          this.days().filter((d) => d.day > today - 30),
          (day) => this.showDay(day, true),
        );
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
    // Journée passée : sa courbe est lue dans le journal de l'onduleur.
    effect(() => {
      const date = this.dayIso();
      if (!this.isToday()) {
        untracked(() => void this.loadCurve(date));
      }
    });
  }

  /** Affiche une journée (bornée entre le début de l'historique et aujourd'hui). */
  protected showDay(day: number, scroll = false): void {
    const bounded = Math.min(Math.max(day, this.firstDay()), this.today());
    this.picked.set(bounded === this.today() ? null : bounded);
    if (scroll) {
      this.detail()?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  protected step(delta: number): void {
    this.showDay(this.day() + delta);
  }

  /** Flèches du clavier sur la carte du détail (pas dans le champ de date, qui les utilise lui-même). */
  protected onArrow(event: Event, delta: number): void {
    if (event.target instanceof HTMLInputElement) {
      return;
    }
    event.preventDefault();
    this.step(delta);
  }

  protected pickDate(value: string): void {
    const day = Math.floor(toDayNumber(value));
    if (Number.isFinite(day)) {
      this.showDay(day);
    }
  }

  private async loadCurve(date: string): Promise<void> {
    this.curveLoading.set(true);
    try {
      const curve = await this.inverter.dayCurve(date);
      if (date === this.dayIso()) {
        this.pastCurve.set(curve);
      }
    } finally {
      if (date === this.dayIso()) {
        this.curveLoading.set(false);
      }
    }
  }

  /** Écart en % par rapport à l'attendu (arrondi), ou `null`. */
  protected diffPct(kwh: number, expected: number): number | null {
    return expected > 0 ? Math.round((kwh / expected - 1) * 100) : null;
  }
}
