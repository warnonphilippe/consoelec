import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { InverterService } from '../../core/services/inverter.service';
import { VaultService } from '../../core/services/vault.service';
import { REGISTER_KEYS, pvKwp } from '../../core/models/app-data.model';
import { DataStore } from '../../core/services/data-store.service';
import { ToastService } from '../../core/services/toast.service';
import { ChartComponent } from '../../shared/chart/chart.component';
import { FORMAT_PIPES } from '../../shared/format';
import { IconComponent } from '../../shared/icon.component';
import { cumulativeNetChart, monthBars, monthlyBalanceChart } from './dashboard-charts';

@Component({
  selector: 'app-dashboard-page',
  imports: [RouterLink, DatePipe, IconComponent, ChartComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './dashboard.page.html',
  styleUrl: './dashboard.page.css',
})
export default class DashboardPage {
  protected readonly store = inject(DataStore);
  protected readonly inverter = inject(InverterService);
  protected readonly vault = inject(VaultService);
  private readonly toast = inject(ToastService);

  protected readonly analysis = this.store.analysis;
  protected readonly kwp = computed(() => pvKwp(this.store.house().pv));

  protected readonly historyOptions = [
    { label: '12 mois', months: 12 },
    { label: '24 mois', months: 24 },
    { label: 'Tout', months: null },
  ] as const;
  protected readonly forecastOptions = [
    { label: 'Sans prévision', months: 0 },
    { label: '+ 6 mois', months: 6 },
    { label: '+ 12 mois', months: 12 },
  ] as const;

  protected readonly historyMonths = signal<number | null>(12);
  protected readonly forecastMonths = signal(6);

  protected readonly lastReading = computed(
    () => this.analysis().consumption.levels.at(-1) ?? null,
  );

  protected readonly bars = computed(() =>
    monthBars(this.analysis(), this.historyMonths(), this.forecastMonths()),
  );
  protected readonly balanceChart = computed(() => monthlyBalanceChart(this.bars()));
  protected readonly netChart = computed(() => cumulativeNetChart(this.bars()));
  protected readonly hasBars = computed(() => this.bars().length > 0);

  /** Rythme des 30 derniers jours comparé à ce que prévoit le meilleur profil. */
  protected readonly pace = computed(() => {
    const a = this.analysis();
    const last = a.last30;
    const expected = a.expectedLast30;
    if (!last || !expected || last.coveredDays < 7) {
      return null;
    }
    const scale = last.coveredDays / last.days;
    const expectedImport = (expected.importPeak + expected.importOff) * scale;
    const expectedExport = (expected.exportPeak + expected.exportOff) * scale;
    return {
      import: last.derived.import,
      export: last.derived.export,
      expectedImport,
      expectedExport,
      importDiffPct:
        expectedImport > 0 ? ((last.derived.import - expectedImport) / expectedImport) * 100 : null,
      importDiffAbs:
        expectedImport > 0
          ? Math.abs(((last.derived.import - expectedImport) / expectedImport) * 100)
          : null,
      days: last.coveredDays,
      profile: a.base.best?.profile.label ?? '',
    };
  });

  protected readonly next12 = computed(() => {
    const best = this.analysis().base.best;
    if (!best) {
      return null;
    }
    const n = best.next12;
    const imp = n.importPeak + n.importOff;
    const exp = n.exportPeak + n.exportOff;
    return { import: imp, export: exp, net: imp - exp, profile: best.profile.label };
  });

  protected readonly offPeakDelta = computed(() => {
    const d = this.analysis().last365?.derived.offPeakPct;
    return d ?? null;
  });

  protected readonly keys = REGISTER_KEYS;

  protected loadDemo(): void {
    this.store.loadDemo();
    this.toast.show(
      'Données de démonstration chargées. Vous pourrez les effacer dans les réglages.',
      'info',
    );
  }
}
