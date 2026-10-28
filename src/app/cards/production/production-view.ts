import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import {
  expectedDailyProduction,
  productionDays,
  productionMonths,
  productionSummary,
} from '../../core/calc/production';
import { measuredYield } from '../../core/calc/pv-yield';
import { dayNumberToDate, toLocalIso, yearMonthOf } from '../../core/calc/time';
import { pvKwp } from '../../core/models/app-data.model';
import { DataStore } from '../../core/services/data-store.service';
import { InverterService, type PowerPoint } from '../../core/services/inverter.service';
import { STATUS_LABEL } from '../../pages/production/production-charts';

export type ProductionChartView = 'days' | 'months' | 'all' | 'years';

const isoDay = (day: number): string => toLocalIso(dayNumberToDate(day)).slice(0, 10);
const DAY_TITLE = new Intl.DateTimeFormat('fr-BE', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

/**
 * Production solaire jour par jour et choix de la page Production (journée détaillée, vue de l'historique), partagés
 * par ses cadres, qu'ils soient sur la page ou sur le tableau de bord.
 */
@Injectable({ providedIn: 'root' })
export class ProductionView {
  private readonly store = inject(DataStore);
  private readonly inverter = inject(InverterService);

  readonly kwp = computed(() => pvKwp(this.store.house().pv));
  readonly views = [
    { id: 'days', label: '30 jours' },
    { id: 'months', label: '12 mois' },
    { id: 'all', label: 'Tous les mois' },
    { id: 'years', label: 'Par année' },
  ] as const;
  readonly view = signal<ProductionChartView>('days');

  readonly expected = computed(() => expectedDailyProduction(this.store.analysis().reference));
  readonly days = computed(() => {
    const d = this.store.data();
    return productionDays(d.pvDaily, d.readings, this.expected(), this.store.now());
  });
  readonly months = computed(() => productionMonths(this.days(), this.expected()));
  readonly summary = computed(() =>
    productionSummary(this.days(), this.store.now(), this.store.house().pv.inverterKva),
  );
  readonly yield = computed(() =>
    measuredYield(this.store.data().pvDaily, this.store.analysis().reference, this.kwp()),
  );

  /** Année civile en cours : production des jours couverts et attendu sur ces mêmes jours. */
  readonly thisYear = computed(() => {
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

  readonly today = computed(() => Math.floor(this.store.now()));
  /** Jour affiché dans le détail ; `null` = aujourd'hui (suit le changement de date). */
  private readonly picked = signal<number | null>(null);
  readonly day = computed(() => this.picked() ?? this.today());
  readonly isToday = computed(() => this.day() === this.today());
  readonly dayIso = computed(() => isoDay(this.day()));
  readonly todayIso = computed(() => isoDay(this.today()));
  readonly firstDay = computed(() => Math.min(this.days()[0]?.day ?? this.today(), this.today()));
  readonly firstIso = computed(() => isoDay(this.firstDay()));
  readonly dayTitle = computed(() => {
    const title = DAY_TITLE.format(dayNumberToDate(this.day()));
    return title.charAt(0).toUpperCase() + title.slice(1);
  });
  readonly dayInfo = computed(() => {
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
  readonly curveLoading = signal(false);
  readonly dayPoints = computed<readonly PowerPoint[]>(() => {
    if (this.isToday()) {
      return this.inverter.todayCurve();
    }
    const curve = this.pastCurve();
    return curve?.date === this.dayIso() ? curve.points : [];
  });
  readonly curveError = computed(() => {
    const curve = this.pastCurve();
    return !this.isToday() && curve?.date === this.dayIso() ? curve.error : null;
  });
  readonly peak = computed(() =>
    this.dayPoints().reduce<PowerPoint | null>((best, p) => (best === null || p.powerW > best.powerW ? p : best), null),
  );
  /** Incrémenté quand un clic sur l'historique choisit une journée : le cadre du détail se montre. */
  readonly revealDetail = signal(0);

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
  showDay(day: number, reveal = false): void {
    const bounded = Math.min(Math.max(day, this.firstDay()), this.today());
    this.picked.set(bounded === this.today() ? null : bounded);
    if (reveal) {
      this.revealDetail.update((n) => n + 1);
    }
  }

  step(delta: number): void {
    this.showDay(this.day() + delta);
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
}

/** Écart en % par rapport à l'attendu (arrondi), ou `null`. */
export function diffPct(kwh: number, expected: number): number | null {
  return expected > 0 ? Math.round((kwh / expected - 1) * 100) : null;
}
