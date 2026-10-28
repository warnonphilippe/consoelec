import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { Forecast } from '../../core/calc/forecast';
import { recentPoints } from '../../core/calc/meter-log';
import { dayNumberToDate, toDayNumber } from '../../core/calc/time';
import { REGISTERS } from '../../core/models/app-data.model';
import { DataStore } from '../../core/services/data-store.service';
import { monthlyBalanceChart, type MonthBar } from '../../pages/dashboard/dashboard-charts';
import { indexChart } from '../../pages/meters/meters-charts';
import { ChartComponent } from '../../shared/chart/chart.component';
import { FORMAT_PIPES } from '../../shared/format';
import { IconComponent } from '../../shared/icon.component';
import { ForecastView } from './forecast-view';

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

/** Choix du profil de prévision et de la voiture électrique prévue. */
@Component({
  selector: 'app-forecast-controls-card',
  imports: [RouterLink, IconComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card-host' },
  styleUrl: './forecast-cards.css',
  template: `
    <div class="card controls">
      <div class="control">
        <span class="label">Profil de prévision</span>
        <div class="segmented" role="radiogroup" aria-label="Profil">
          @for (p of v.profiles(); track p.key) {
            <button
              type="button"
              role="radio"
              [attr.aria-checked]="v.selected()?.profile?.key === p.key"
              [class.active]="v.selected()?.profile?.key === p.key"
              [disabled]="!p.available"
              [title]="p.note"
              (click)="v.profileKey.set(p.key)"
            >
              {{ p.label }}
            </button>
          }
        </div>
        <span class="small muted">{{ v.selected()?.profile?.note }}</span>
      </div>

      <div class="control">
        <span class="label">Voiture électrique</span>
        @if (v.hasEvScenario()) {
          <div class="segmented" role="radiogroup" aria-label="Voiture électrique">
            <button
              type="button"
              role="radio"
              [attr.aria-checked]="!v.withEv()"
              [class.active]="!v.withEv()"
              (click)="v.withEv.set(false)"
            >
              Sans voiture
            </button>
            <button
              type="button"
              role="radio"
              [attr.aria-checked]="v.withEv()"
              [class.active]="v.withEv()"
              (click)="v.withEv.set(true)"
            >
              <app-icon name="car" [size]="14" /> Avec voiture
            </button>
          </div>
          @let ev = v.ev();
          <span class="small muted">
            {{ v.evKwh() | kwh }} / an rechargés à la maison ({{ ev.kmPerYear | num }} km,
            {{ ev.kWhPer100km | num: 1 }} kWh/100 km), recharge
            {{ ev.chargeWindow === 'night' ? 'de nuit' : ev.chargeWindow === 'day' ? 'de jour' : 'mixte' }}
            @if (ev.startDate) {
              à partir du {{ ev.startDate | day }}
            }
          </span>
        } @else if (v.ev().mode === 'owned') {
          <span class="small muted"
            >Voiture déjà en service : ses {{ v.evKwh() | kwh }} / an sont inclus dans les prévisions.
            <a routerLink="/maison">Modifier</a></span
          >
        } @else {
          <span class="small muted"
            >Aucune voiture prévue. <a routerLink="/maison">Simuler l'arrivée d'une voiture électrique</a></span
          >
        }
      </div>
    </div>
  `,
})
export class ForecastControlsCard {
  protected readonly v = inject(ForecastView);
}

export type ForecastKpi = 'import' | 'export' | 'net' | 'ev';

/** Chiffre clé des 12 prochains mois : soutirage, injection, solde net, effet de la voiture prévue. */
@Component({
  selector: 'app-forecast-kpi-card',
  imports: [IconComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card-host' },
  template: `
    @if (v.summary(); as s) {
      @switch (kind()) {
        @case ('import') {
          <div class="card kpi">
            <span class="kpi-label"><app-icon name="plug" [size]="15" /> Soutirage prévu · 12 mois</span>
            <span class="kpi-value">{{ s.import | kwh }}</span>
            <span class="kpi-sub">
              @if (s.lastImport !== null) {
                12 derniers mois : {{ s.lastImport | kwh }}
              } @else {
                selon « {{ s.profile }} »
              }
              @if (s.offPeakPct !== null) {
                <br />{{ s.offPeakPct | num }} % en heures creuses
              }
            </span>
          </div>
        }
        @case ('export') {
          <div class="card kpi">
            <span class="kpi-label"><app-icon name="sun" [size]="15" /> Injection prévue · 12 mois</span>
            <span class="kpi-value">{{ s.export | kwh }}</span>
            <span class="kpi-sub">
              @if (s.lastExport !== null) {
                12 derniers mois : {{ s.lastExport | kwh }}
              } @else {
                selon « {{ s.profile }} »
              }
            </span>
          </div>
        }
        @case ('net') {
          <div class="card kpi">
            <span class="kpi-label"><app-icon name="bolt" [size]="15" /> Solde net prévu</span>
            <span class="kpi-value" [class.tone-success]="s.net <= 0">{{ s.net | skwh }}</span>
            <span class="kpi-sub">
              @if (s.lastNet !== null) {
                12 derniers mois : {{ s.lastNet | skwh }}
              } @else {
                soutirage − injection
              }
            </span>
          </div>
        }
        @case ('ev') {
          @if (v.evImpact(); as e) {
            <div class="card kpi">
              <span class="kpi-label"><app-icon name="car" [size]="15" /> Effet de la voiture</span>
              <span class="kpi-value">{{ e.importDelta | skwh }}</span>
              <span class="kpi-sub"
                >de soutirage par an (dont {{ e.offDelta | skwh }} en heures creuses)
                @if (e.exportDelta < -1) {
                  <br />{{ e.exportDelta | skwh }} d'injection
                }
              </span>
            </div>
          }
        }
      }
    }
  `,
})
export class ForecastKpiCard {
  protected readonly v = inject(ForecastView);
  readonly kind = input.required<ForecastKpi>();
}

/** Bilan mensuel prévu sur les 12 prochains mois, selon le profil choisi. */
@Component({
  selector: 'app-forecast-monthly-chart-card',
  imports: [ChartComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card-host' },
  template: `
    @if (v.summary(); as s) {
      <div class="card">
        <div class="card-header">
          <h2>Bilan mensuel prévu</h2>
          <span class="hint">selon « {{ s.profile }} »</span>
        </div>
        @if (chart(); as c) {
          <app-chart [build]="c" [height]="320" />
        }
      </div>
    }
  `,
})
export class ForecastMonthlyChartCard {
  private readonly store = inject(DataStore);
  protected readonly v = inject(ForecastView);
  protected readonly chart = computed(() => {
    const f = this.v.selected();
    if (!f) {
      return null;
    }
    const now = dayNumberToDate(this.store.now());
    const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    return monthlyBalanceChart(barsOf(f, key));
  });
}

/** Index projetés : relevés des 6 derniers mois et prévision sur 18 mois. */
@Component({
  selector: 'app-forecast-index-chart-card',
  imports: [ChartComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card-host' },
  template: `
    @if (v.selected()) {
      <div class="card">
        <div class="card-header">
          <h2>Index projetés</h2>
          <span class="hint">traits pleins : relevés · pointillés : prévision</span>
        </div>
        <app-chart [build]="chart()" [height]="320" />
      </div>
    }
  `,
})
export class ForecastIndexChartCard {
  private readonly store = inject(DataStore);
  protected readonly v = inject(ForecastView);
  protected readonly chart = computed(() =>
    indexChart(
      this.store.analysis(),
      this.v.selected(),
      recentPoints(this.store.data().meterLog, Date.now()),
      REGISTERS.map((r) => r.key),
      this.store.now() - 183,
      548,
      this.store.now(),
    ),
  );
}

/** Fiabilité observée de chaque profil sur les mois déjà mesurés (rétro-test). */
@Component({
  selector: 'app-forecast-reliability-card',
  imports: [...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card-host' },
  styleUrl: './forecast-cards.css',
  template: `
    <div class="card flush">
      <div class="card-header">
        <h2>Fiabilité observée</h2>
        <span class="hint">prévision refaite pour chaque mois passé, avec les seuls relevés d'alors</span>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Profil</th>
              <th class="num">Erreur moyenne</th>
              <th class="num">Mois testés</th>
            </tr>
          </thead>
          <tbody>
            @for (r of reliability(); track r.profile.key) {
              <tr [class.faint]="r.errorPct === null">
                <td>
                  {{ r.profile.label }}
                  @if (r.profile.key === v.bestKey()) {
                    <span class="badge success">retenu</span>
                  }
                </td>
                <td class="num">
                  @if (r.errorPct !== null) {
                    {{ r.errorPct | num }} %
                  } @else {
                    —
                  }
                </td>
                <td class="num">{{ r.samples }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      <p class="small muted note">
        Erreur = écart total entre le mois prévu et le mois mesuré, rapporté au total mesuré, en moyenne sur le
        soutirage et l'injection. Le profil le plus fiable est retenu dès que trois mois au moins ont pu être testés ;
        l'erreur d'un mois isolé reste plus grande que celle du total annuel.
      </p>
    </div>
  `,
})
export class ForecastReliabilityCard {
  private readonly store = inject(DataStore);
  protected readonly v = inject(ForecastView);
  protected readonly reliability = computed(() => {
    const scores = this.store.analysis().backtest?.scores ?? {};
    return this.v.set().profiles.map((p) => {
      const score = scores[p.key];
      return { profile: p, errorPct: score ? score.error * 100 : null, samples: score?.samples ?? 0 };
    });
  });
}

/** Comparaison des profils sur les 12 prochains mois, avec les coefficients de recalage. */
@Component({
  selector: 'app-forecast-profiles-card',
  imports: [...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card-host' },
  styleUrl: './forecast-cards.css',
  template: `
    <div class="card flush">
      <div class="card-header">
        <h2>Comparaison des profils</h2>
        <span class="hint">12 prochains mois</span>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Profil</th>
              <th class="num">Soutirage</th>
              <th class="num">Injection</th>
              <th class="num">Solde net</th>
            </tr>
          </thead>
          <tbody>
            @for (c of comparison(); track c.profile.key) {
              <tr [class.faint]="!c.profile.available">
                <td>
                  {{ c.profile.label }}
                  @if (!c.profile.available) {
                    <span class="badge">indisponible</span>
                  }
                </td>
                <td class="num">{{ c.import | num }}</td>
                <td class="num">{{ c.export | num }}</td>
                <td class="num">{{ c.net | skwh }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      @for (p of v.profiles(); track p.key) {
        @if (p.ratios; as r) {
          <p class="small muted note">
            Coefficients de recalage de la référence : soutirage HP × {{ r.importPeak | num: 1 }}, HC ×
            {{ r.importOff | num: 1 }}, injection HP × {{ r.exportPeak | num: 1 }}, HC × {{ r.exportOff | num: 1 }}.
          </p>
        }
      }
    </div>
  `,
})
export class ForecastProfilesCard {
  protected readonly v = inject(ForecastView);
  protected readonly comparison = computed(() => {
    const set = this.v.set();
    return set.profiles.map((p) => {
      const n = set.forecasts[p.key]?.next12;
      return {
        profile: p,
        import: n ? n.importPeak + n.importOff : null,
        export: n ? n.exportPeak + n.exportOff : null,
        net: n ? n.importPeak + n.importOff - n.exportPeak - n.exportOff : null,
      };
    });
  });
}

/** Index projetés au 31 décembre de l'année en cours et de la suivante. */
@Component({
  selector: 'app-forecast-year-ends-card',
  imports: [...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card-host' },
  template: `
    <div class="card flush">
      <div class="card-header">
        <h2>Index projetés aux changements d'année</h2>
        <span class="hint">au 31 décembre</span>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Fin</th>
              @for (r of registers; track r.key) {
                <th class="num">{{ r.short }}</th>
              }
            </tr>
          </thead>
          <tbody>
            @for (y of yearEnds(); track y.year) {
              <tr>
                <td>
                  <strong>{{ y.year }}</strong>
                </td>
                @for (r of registers; track r.key) {
                  <td class="num">
                    @if (y.values) {
                      {{ y.values[r.key] | num }}
                    } @else {
                      <span class="faint">—</span>
                    }
                  </td>
                }
              </tr>
            }
          </tbody>
        </table>
      </div>
    </div>
  `,
})
export class ForecastYearEndsCard {
  private readonly store = inject(DataStore);
  private readonly v = inject(ForecastView);
  protected readonly registers = REGISTERS;
  protected readonly yearEnds = computed(() => {
    const f = this.v.selected();
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
