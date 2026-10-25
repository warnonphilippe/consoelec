import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { Forecast, ProfileKey } from '../../core/calc/forecast';
import { evAnnualKwh } from '../../core/calc/ev';
import { dayNumberToDate, toDayNumber } from '../../core/calc/time';
import { REGISTERS } from '../../core/models/app-data.model';
import { DataStore } from '../../core/services/data-store.service';
import { ChartComponent } from '../../shared/chart/chart.component';
import { FORMAT_PIPES } from '../../shared/format';
import { IconComponent } from '../../shared/icon.component';
import { monthlyBalanceChart, type MonthBar } from '../dashboard/dashboard-charts';
import { indexChart } from '../meters/meters-charts';

const MONTHS_SHOWN = 12;

function barsOf(forecast: Forecast, fromKey: string): MonthBar[] {
  return forecast.months
    .filter((m) => m.key >= fromKey)
    .slice(0, MONTHS_SHOWN)
    .map((m) => ({
      key: m.key,
      label: new Intl.DateTimeFormat('fr-BE', { month: 'short', year: '2-digit' }).format(
        new Date(m.year, m.month, 1),
      ),
      forecast: true,
      partial: false,
      importPeak: m.values.importPeak,
      importOff: m.values.importOff,
      exportPeak: m.values.exportPeak,
      exportOff: m.values.exportOff,
    }));
}

@Component({
  selector: 'app-forecast-page',
  imports: [RouterLink, IconComponent, ChartComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './forecast.page.html',
  styleUrl: './forecast.page.css',
})
export default class ForecastPage {
  protected readonly store = inject(DataStore);
  protected readonly analysis = this.store.analysis;
  protected readonly registers = REGISTERS;

  /** Voiture électrique prévue : inclure son effet dans les prévisions. */
  protected readonly withEv = signal(true);
  protected readonly profileKey = signal<ProfileKey | null>(null);

  protected readonly ev = computed(() => this.store.house().ev);
  protected readonly evKwh = computed(() => evAnnualKwh(this.ev()));
  protected readonly hasEvScenario = computed(() => this.analysis().withEv !== null);

  /** Ensemble de prévisions affiché : avec ou sans la voiture prévue. */
  protected readonly set = computed(() => {
    const a = this.analysis();
    return this.withEv() && a.withEv ? a.withEv : a.base;
  });

  protected readonly selected = computed<Forecast | null>(() => {
    const set = this.set();
    const key = this.profileKey();
    return (key && set.forecasts[key]) || set.best;
  });

  protected readonly profiles = computed(() => this.set().profiles);

  /** Erreur moyenne de chaque profil sur les mois déjà mesurés (rétro-test). */
  protected readonly reliability = computed(() => {
    const scores = this.analysis().backtest?.scores ?? {};
    return this.set().profiles.map((p) => {
      const score = scores[p.key];
      return {
        profile: p,
        errorPct: score ? score.error * 100 : null,
        samples: score?.samples ?? 0,
      };
    });
  });
  protected readonly bestKey = computed(() => this.set().best?.profile.key ?? null);

  protected readonly summary = computed(() => {
    const f = this.selected();
    if (!f) {
      return null;
    }
    const n = f.next12;
    const imp = n.importPeak + n.importOff;
    const exp = n.exportPeak + n.exportOff;
    const last = this.analysis().last365;
    return {
      import: imp,
      export: exp,
      net: imp - exp,
      offPeakPct: imp > 0 ? (n.importOff / imp) * 100 : null,
      lastImport: last?.derived.import ?? null,
      lastExport: last?.derived.export ?? null,
      lastNet: last?.derived.net ?? null,
      profile: f.profile.label,
    };
  });

  /** Écart apporté par la voiture prévue sur 12 mois. */
  protected readonly evImpact = computed(() => {
    const a = this.analysis();
    const base = a.base.best;
    const car = a.withEv?.best;
    if (!base || !car) {
      return null;
    }
    const sum = (f: Forecast, ...keys: (keyof Forecast['next12'])[]): number =>
      keys.reduce((s, k) => s + f.next12[k], 0);
    return {
      importDelta: sum(car, 'importPeak', 'importOff') - sum(base, 'importPeak', 'importOff'),
      exportDelta: sum(car, 'exportPeak', 'exportOff') - sum(base, 'exportPeak', 'exportOff'),
      offDelta: car.next12.importOff - base.next12.importOff,
    };
  });

  protected readonly comparison = computed(() => {
    const set = this.set();
    return set.profiles.map((p) => {
      const f = set.forecasts[p.key];
      const n = f?.next12;
      return {
        profile: p,
        import: n ? n.importPeak + n.importOff : null,
        export: n ? n.exportPeak + n.exportOff : null,
        net: n ? n.importPeak + n.importOff - n.exportPeak - n.exportOff : null,
      };
    });
  });

  protected readonly monthChart = computed(() => {
    const f = this.selected();
    if (!f) {
      return null;
    }
    const now = dayNumberToDate(this.store.now());
    const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    return monthlyBalanceChart(barsOf(f, key));
  });

  protected readonly indexChartBuilder = computed(() =>
    indexChart(
      this.analysis(),
      this.selected(),
      REGISTERS.map((r) => r.key),
      this.store.now() - 183,
      548,
      this.store.now(),
    ),
  );

  /** Index projetés au 31 décembre de l'année en cours et de la suivante. */
  protected readonly yearEnds = computed(() => {
    const f = this.selected();
    if (!f) {
      return [];
    }
    const year = dayNumberToDate(this.store.now()).getFullYear();
    return [year, year + 1].map((y) => {
      const day = toDayNumber(`${y + 1}-01-01`);
      const point = f.points.find((p) => p.day >= day);
      return { year: y, values: point?.values ?? null };
    });
  });
}
