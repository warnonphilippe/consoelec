import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { REGISTERS, type RegisterKey } from '../../core/models/app-data.model';
import { DataStore } from '../../core/services/data-store.service';
import { ChartComponent } from '../../shared/chart/chart.component';
import { FORMAT_PIPES } from '../../shared/format';
import { IconComponent } from '../../shared/icon.component';
import { balanceSeries } from '../../core/calc/balance';
import { balanceChart, indexChart, splitChart } from './meters-charts';

@Component({
  selector: 'app-meters-page',
  imports: [RouterLink, IconComponent, ChartComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './meters.page.html',
  styleUrl: './meters.page.css',
})
export default class MetersPage {
  protected readonly store = inject(DataStore);
  protected readonly analysis = this.store.analysis;
  protected readonly registers = REGISTERS;

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
  protected readonly historyDays = signal<number | null>(365);
  protected readonly forecastDays = signal(183);
  protected readonly shown = signal<ReadonlySet<RegisterKey>>(new Set(REGISTERS.map((r) => r.key)));

  protected readonly cards = computed(() => {
    const a = this.analysis();
    const last = a.consumption.levels.at(-1);
    const now = this.store.now();
    return REGISTERS.map((r) => {
      const estimated = a.currentIndices?.[r.key] ?? null;
      const t365 = a.last365?.values[r.key] ?? null;
      const t30 = a.last30?.values[r.key] ?? null;
      const t7 = a.last7?.values[r.key] ?? null;
      return {
        ...r,
        lastValue: last?.values[r.key] ?? null,
        lastDay: last?.day ?? null,
        estimated,
        staleDays: last ? now - last.day : null,
        t7,
        t30,
        t365,
        perDay30: t30 !== null && a.last30 ? t30 / Math.max(1, a.last30.coveredDays) : null,
      };
    });
  });

  protected readonly totals = computed(() => {
    const e = this.analysis().currentIndices;
    if (!e) {
      return null;
    }
    const imp = e.importPeak + e.importOff;
    const exp = e.exportPeak + e.exportOff;
    return { import: imp, export: exp, net: imp - exp };
  });

  protected readonly chart = computed(() => {
    const days = this.historyDays();
    const now = this.store.now();
    return indexChart(
      this.analysis(),
      this.analysis().base.best,
      [...this.shown()],
      days === null ? null : now - days,
      this.forecastDays(),
      now,
    );
  });

  // --- Soldes de facturation ---
  protected readonly balanceHistoryDays = signal<number | null>(365);
  protected readonly balanceForecastDays = signal(365);
  protected readonly balance = computed(() => {
    const a = this.analysis();
    const now = this.store.now();
    return balanceSeries(
      a.consumption,
      a.weights,
      a.base.best,
      this.store.settings().billingStart,
      now + Math.max(this.balanceForecastDays(), 400),
      now,
    );
  });
  protected readonly balanceChart = computed(() => {
    const days = this.balanceHistoryDays();
    const now = this.store.now();
    return balanceChart(
      this.balance(),
      this.analysis().consumption.levels.map((l) => l.day),
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

  protected readonly importSplit = computed(() => {
    const v = this.analysis().last365?.values;
    return v ? splitChart(v.importPeak, v.importOff, 'importPeak', 'importOff') : null;
  });
  protected readonly exportSplit = computed(() => {
    const v = this.analysis().last365?.values;
    return v ? splitChart(v.exportPeak, v.exportOff, 'exportPeak', 'exportOff') : null;
  });

  protected toggle(key: RegisterKey): void {
    this.shown.update((set) => {
      const next = new Set(set);
      if (next.has(key)) {
        if (next.size > 1) {
          next.delete(key);
        }
      } else {
        next.add(key);
      }
      return next;
    });
  }
}
