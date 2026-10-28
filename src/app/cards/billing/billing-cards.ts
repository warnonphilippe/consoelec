import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { hourRanges, isOffPeakHour } from '../../core/calc/reference';
import { dayNumberToDate } from '../../core/calc/time';
import { DataStore } from '../../core/services/data-store.service';
import { FORMAT_PIPES } from '../../shared/format';
import { IconComponent, type IconName } from '../../shared/icon.component';

/** Période tarifaire d'un cadre de solde : ce qui est compensé ensemble sur la facture. */
interface Period {
  readonly label: string;
  readonly codes: string;
  readonly icon: IconName;
  readonly importKey: 'importPeak' | 'importOff';
  readonly exportKey: 'exportPeak' | 'exportOff';
}

const PERIODS: Record<'hp' | 'hc', Period> = {
  hp: { label: 'Heures pleines', codes: '1.8.1 − 2.8.1', icon: 'sun', importKey: 'importPeak', exportKey: 'exportPeak' },
  hc: { label: 'Heures creuses', codes: '1.8.2 − 2.8.2', icon: 'moon', importKey: 'importOff', exportKey: 'exportOff' },
};

/** Solde de facturation d'une période (HP ou HC) : à ce jour et en fin d'année. */
@Component({
  selector: 'app-billing-period-card',
  imports: [IconComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card-host' },
  template: `
    @if (store.billingYear(); as y) {
      @let p = period();
      @let toDate = y.toDate ? y.toDate[key()] : null;
      @let end = y[key()];
      <div class="card kpi">
        <span class="kpi-label"
          ><app-icon [name]="p.icon" [size]="15" /> {{ p.label }} <span class="faint">· {{ p.codes }}</span></span
        >
        <span class="kpi-value" [class.tone-warning]="(toDate ?? 0) > 0" [class.tone-success]="(toDate ?? 0) <= 0"
          >{{ toDate === null ? '—' : (toDate | skwh) }}</span
        >
        <span class="kpi-sub">
          @if (y.toDate; as t) {
            solde au {{ t.day | day }} : soutiré {{ t[p.importKey] | kwh }} − injecté {{ t[p.exportKey] | kwh }}
          } @else {
            aucun relevé cette année
          }
          <br />fin d'année{{ y.forecast ? ' estimée' : '' }} : <strong>{{ end | skwh }}</strong>
          @if (end > 0) {
            → ≈ <strong>{{ y.cost[key()] | euro }}</strong> à payer
          } @else if (end < 0) {
            → surplus non remboursé
          }
          <br /><span class="faint"
            >année du {{ y.settledFrom ?? y.start | day }} au {{ y.end - 1 | day }}
            @if (y.coveredFrom !== null && y.settledFrom === null) {
              · relevés depuis le {{ y.coveredFrom | day }}
            }</span
          >
        </span>
      </div>
    }
  `,
})
export class BillingPeriodCard {
  protected readonly store = inject(DataStore);
  readonly key = input.required<'hp' | 'hc'>();
  protected readonly period = computed(() => PERIODS[this.key()]);
}

/** Coût estimé de l'année de facturation, au prix moyen du kWh. */
@Component({
  selector: 'app-billing-cost-card',
  imports: [RouterLink, IconComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card-host' },
  template: `
    @if (store.billingYear(); as y) {
      <div class="card kpi">
        <span class="kpi-label"><app-icon name="euro" [size]="15" /> Coût estimé de l'année</span>
        <span class="kpi-value">{{ y.cost.total | euro }}</span>
        <span class="kpi-sub">
          @if (y.costToDate; as c) {
            à ce jour : {{ c.total | euro }}<br />
          }
          @if (y.cost.surplusKwh > 0.5) {
            surplus perdu en fin d'année : {{ y.cost.surplusKwh | kwh }}<br />
          }
          au prix moyen de {{ y.prices.hp | euro: true }} (HP) et {{ y.prices.hc | euro: true }} (HC) le kWh ·
          <a routerLink="/reglages">modifier</a>
        </span>
      </div>
    }
  `,
})
export class BillingCostCard {
  protected readonly store = inject(DataStore);
}

/** Horaire des heures pleines / creuses (réglages) et période en cours. */
@Component({
  selector: 'app-billing-schedule-card',
  imports: [RouterLink, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card-host' },
  template: `
    @let sch = schedule();
    <div class="card kpi">
      <span class="kpi-label"><app-icon name="clock" [size]="15" /> Horaire heures pleines / creuses</span>
      <span class="kpi-value schedule-now" [class.tone-success]="sch.current" [class.tone-warning]="!sch.current"
        >{{ sch.current ? 'Heures creuses' : 'Heures pleines' }}</span
      >
      <span class="kpi-sub"> maintenant{{ sch.until !== null ? ", jusqu'à " + sch.until + ' h' : '' }} </span>
      <div class="hour-strip" role="img" [attr.aria-label]="'Heures creuses : ' + sch.off.join(', ')">
        @for (cell of sch.hours; track cell.h) {
          <span class="hour-cell" [class.off]="cell.off" [class.now]="cell.h === sch.hour"></span>
        }
      </div>
      <div class="hour-scale"><span>0 h</span><span>6 h</span><span>12 h</span><span>18 h</span><span>24 h</span></div>
      <span class="kpi-sub">
        <strong>HC</strong> {{ sch.off.join(', ') }}<br />
        <strong>HP</strong> {{ sch.peak.join(', ') }}<br />
        {{ sch.weekends ? 'en semaine ; week-ends entiers en heures creuses' : 'tous les jours, week-ends compris' }} ·
        <a routerLink="/reglages">modifier</a>
      </span>
    </div>
  `,
  styles: `
    .schedule-now {
      font-size: 22px;
    }
    .hour-strip {
      display: grid;
      grid-template-columns: repeat(24, minmax(0, 1fr));
      gap: 2px;
      margin-top: 6px;
    }
    .hour-cell {
      height: 14px;
      border-radius: 3px;
      background: var(--surface-2);
      border: 1px solid var(--border);
    }
    .hour-cell.off {
      background: var(--hc-soft);
      border-color: var(--hc);
    }
    .hour-cell.now {
      outline: 2px solid var(--text);
      outline-offset: 1px;
    }
    .hour-scale {
      display: flex;
      justify-content: space-between;
      font-size: 10px;
      color: var(--text-faint);
      font-variant-numeric: tabular-nums;
    }
  `,
})
export class BillingScheduleCard {
  private readonly store = inject(DataStore);

  protected readonly schedule = computed(() => {
    const s = this.store.settings();
    const date = dayNumberToDate(this.store.now());
    const weekend = date.getDay() === 0 || date.getDay() === 6;
    const hour = date.getHours();
    const off = (h: number) => isOffPeakHour(h, weekend, s);
    const current = off(hour);
    let until: number | null = null;
    for (let i = 1; i < 24; i++) {
      if (off((hour + i) % 24) !== current) {
        until = (hour + i) % 24;
        break;
      }
    }
    const weekday = Array.from({ length: 24 }, (_, h) => h).filter((h) => s.offPeakHours.includes(h));
    return {
      current,
      until,
      hour,
      hours: Array.from({ length: 24 }, (_, h) => ({ h, off: off(h) })),
      off: hourRanges(weekday),
      peak: hourRanges(Array.from({ length: 24 }, (_, h) => h).filter((h) => !weekday.includes(h))),
      weekends: s.offPeakWeekends,
    };
  });
}
