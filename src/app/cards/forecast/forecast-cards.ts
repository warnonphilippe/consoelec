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
import { ForecastView, byPeriod } from './forecast-view';

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

/**
 * Chiffre clé des 12 prochains mois, par compteur (heures pleines / heures creuses) : soutirage, injection, soldes,
 * effet de la voiture prévue. Les deux compteurs se facturent séparément : pas de total HP + HC.
 */
@Component({
  selector: 'app-forecast-kpi-card',
  imports: [IconComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card-host' },
  styleUrl: './forecast-cards.css',
  template: `
    @if (v.summary(); as s) {
      @switch (kind()) {
        @case ('import') {
          <div class="card kpi">
            <span class="kpi-label"><app-icon name="plug" [size]="15" /> Soutirage prévu · 12 mois</span>
            <div class="period-values">
              <span>HP {{ s.next.hp.import | kwh }}</span>
              <span>HC {{ s.next.hc.import | kwh }}</span>
            </div>
            <span class="kpi-sub">
              @if (s.last; as l) {
                12 derniers mois : HP {{ l.hp.import | kwh }} · HC {{ l.hc.import | kwh }}
              } @else {
                selon « {{ s.profile }} »
              }
            </span>
          </div>
        }
        @case ('export') {
          <div class="card kpi">
            <span class="kpi-label"><app-icon name="sun" [size]="15" /> Injection prévue · 12 mois</span>
            <div class="period-values">
              <span>HP {{ s.next.hp.export | kwh }}</span>
              <span>HC {{ s.next.hc.export | kwh }}</span>
            </div>
            <span class="kpi-sub">
              @if (s.last; as l) {
                12 derniers mois : HP {{ l.hp.export | kwh }} · HC {{ l.hc.export | kwh }}
              } @else {
                selon « {{ s.profile }} »
              }
            </span>
          </div>
        }
        @case ('net') {
          @let hp = s.next.hp.net;
          @let hc = s.next.hc.net;
          <div class="card kpi">
            <span class="kpi-label"><app-icon name="bolt" [size]="15" /> Soldes prévus · 12 mois</span>
            <div class="period-values">
              <span [class.tone-warning]="hp > 0" [class.tone-success]="hp <= 0">HP {{ hp | skwh }}</span>
              <span [class.tone-warning]="hc > 0" [class.tone-success]="hc <= 0">HC {{ hc | skwh }}</span>
            </div>
            <span class="kpi-sub">
              à payer : {{ (hp > 0 ? hp : 0) + (hc > 0 ? hc : 0) | kwh }}
              @if (hp < 0 || hc < 0) {
                · surplus non remboursé : {{ (hp < 0 ? -hp : 0) + (hc < 0 ? -hc : 0) | kwh }}
              }
              @if (s.last; as l) {
                <br />12 derniers mois : HP {{ l.hp.net | skwh }} · HC {{ l.hc.net | skwh }}
              }
            </span>
          </div>
        }
        @case ('ev') {
          @if (v.evImpact(); as e) {
            <div class="card kpi">
              <span class="kpi-label"><app-icon name="car" [size]="15" /> Effet de la voiture</span>
              <div class="period-values">
                <span>HP {{ e.hp.import | skwh }}</span>
                <span>HC {{ e.hc.import | skwh }}</span>
              </div>
              <span class="kpi-sub"
                >de soutirage par an
                @if (e.hp.export < -1 || e.hc.export < -1) {
                  <br />injection : HP {{ e.hp.export | skwh }} · HC {{ e.hc.export | skwh }}
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
        <span class="hint">12 prochains mois, kWh par compteur</span>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Profil</th>
              <th class="num">Soutirage HP</th>
              <th class="num">Soutirage HC</th>
              <th class="num">Injection HP</th>
              <th class="num">Injection HC</th>
              <th class="num">Solde HP</th>
              <th class="num">Solde HC</th>
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
                @if (c.figures; as f) {
                  <td class="num">{{ f.hp.import | num }}</td>
                  <td class="num">{{ f.hc.import | num }}</td>
                  <td class="num">{{ f.hp.export | num }}</td>
                  <td class="num">{{ f.hc.export | num }}</td>
                  <td class="num" [class.tone-success]="f.hp.net <= 0">{{ f.hp.net | skwh }}</td>
                  <td class="num" [class.tone-success]="f.hc.net <= 0">{{ f.hc.net | skwh }}</td>
                } @else {
                  @for (i of [1, 2, 3, 4, 5, 6]; track i) {
                    <td class="num faint">—</td>
                  }
                }
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
      return { profile: p, figures: n ? byPeriod(n) : null };
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
