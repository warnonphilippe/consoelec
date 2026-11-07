import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { dayNumberToDate } from '../../core/calc/time';
import { dailyEnergyChart, quarterChart } from '../../pages/meters/meters-charts';
import { ChartComponent } from '../../shared/chart/chart.component';
import { FORMAT_PIPES } from '../../shared/format';
import { IconComponent } from '../../shared/icon.component';
import { MeterProfileView } from './profile-view';

/** Soutirage et injection d'une journée, au quart d'heure, avec la production de l'onduleur et la navigation. */
@Component({
  selector: 'app-meter-profile-day-card',
  imports: [IconComponent, ChartComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card-host' },
  styleUrl: './meters-cards.css',
  template: `
    <section
      class="card"
      tabindex="0"
      aria-label="Soutirage et injection de la journée"
      (keydown.arrowleft)="onArrow($event, -1)"
      (keydown.arrowright)="onArrow($event, 1)"
    >
      <div class="card-header day-head">
        <div>
          <h2>{{ v.dayTitle() }}</h2>
          <span class="hint">soutirage et injection au quart d'heure · flèches ← → pour changer de jour</span>
        </div>
        <div class="day-nav">
          <button type="button" class="icon-btn" title="Jour précédent" aria-label="Jour précédent" (click)="v.step(-1)">
            <app-icon name="chevron-left" [size]="16" />
          </button>
          <input
            type="date"
            class="input day-input"
            aria-label="Choisir la date"
            [value]="v.dayIso()"
            [max]="v.todayIso()"
            (change)="v.showDate($any($event.target).value)"
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

      @if (v.dayTotals(); as t) {
        <div class="day-stats">
          <div>
            <span class="day-value">{{ t.importKwh | num: 1 }}</span>
            <span class="small faint"><app-icon name="plug" [size]="13" /> kWh soutirés</span>
          </div>
          <div>
            <span class="day-value inject">{{ t.exportKwh | num: 1 }}</span>
            <span class="small faint"><app-icon name="sun" [size]="13" /> kWh injectés</span>
          </div>
          <div>
            <span class="day-value">{{ (t.covered / 4) | num: 1 }} h</span>
            <span class="small faint"
              >couvertes
              @if (t.estimated > 0) {
                · dont {{ (t.estimated / 4) | num: 1 }} h estimées (pâles)
              }
            </span>
          </div>
        </div>
        <app-chart [build]="chart()" [height]="280" />
      } @else {
        <p class="small faint day-empty">
          Aucune lecture du compteur pour cette journée.
          <button type="button" class="link-btn" [disabled]="v.importing()" (click)="v.importHomeWizard()">
            Importer l'historique HomeWizard
          </button>
        </p>
      }
    </section>
  `,
})
export class MeterProfileDayCard {
  protected readonly v = inject(MeterProfileView);
  protected readonly chart = computed(() =>
    quarterChart(this.v.quarters(), this.v.pvPoints(), dayNumberToDate(this.v.day()).getTime()),
  );

  /** Flèches du clavier sur la carte (pas dans le champ de date, qui les utilise lui-même). */
  protected onArrow(event: Event, delta: number): void {
    if (event.target instanceof HTMLInputElement) {
      return;
    }
    event.preventDefault();
    if (delta < 0 || !this.v.isToday()) {
      this.v.step(delta);
    }
  }
}

/** Soutirage et injection par jour sur 30 jours, 90 jours ou un an ; un clic ouvre la journée. */
@Component({
  selector: 'app-meter-profile-days-card',
  imports: [IconComponent, ChartComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card-host' },
  styleUrl: './meters-cards.css',
  template: `
    <div class="card">
      <div class="card-header">
        <div>
          <h2>Soutirage et injection par jour</h2>
          <span class="hint">clic sur un jour pour son détail · pâle : journée incomplète ou en partie estimée</span>
        </div>
        <div class="row">
          <div class="segmented" role="radiogroup" aria-label="Période">
            @for (o of v.rangeOptions; track o.label) {
              <button
                type="button"
                role="radio"
                [attr.aria-checked]="v.rangeDays() === o.days"
                [class.active]="v.rangeDays() === o.days"
                (click)="v.rangeDays.set(o.days)"
              >
                {{ o.label }}
              </button>
            }
          </div>
          <button type="button" class="btn sm" [disabled]="v.importing()" (click)="v.importHomeWizard()">
            <app-icon name="upload" [size]="14" /> Importer l'historique HomeWizard
          </button>
        </div>
      </div>
      @if (v.days().length > 0) {
        <div class="day-stats">
          <div>
            <span class="day-value">{{ totals().importKwh | num }}</span>
            <span class="small faint">kWh soutirés sur {{ v.days().length }} j</span>
          </div>
          <div>
            <span class="day-value inject">{{ totals().exportKwh | num }}</span>
            <span class="small faint">kWh injectés sur {{ v.days().length }} j</span>
          </div>
        </div>
        <app-chart [build]="chart()" [height]="260" />
      } @else {
        <p class="small faint day-empty">Pas encore de journée enregistrée sur cette période.</p>
      }
      <p class="small faint import-help">
        Le lecteur P1 ne garde pas d'historique : ConsoElec enregistre ses lectures quand l'app est ouverte. Pour les
        périodes où le Mac était éteint, exportez l'historique depuis l'app HomeWizard Energy (Réglages › Graphiques ›
        choisir le graphique › Exporter les données, au quart d'heure) et importez le fichier ici.
      </p>
    </div>
  `,
})
export class MeterProfileDaysCard {
  protected readonly v = inject(MeterProfileView);
  protected readonly totals = computed(() => ({
    importKwh: this.v.days().reduce((s, d) => s + d.importKwh, 0),
    exportKwh: this.v.days().reduce((s, d) => s + d.exportKwh, 0),
  }));
  protected readonly chart = computed(() =>
    dailyEnergyChart(this.v.days(), (date) => {
      this.v.showDate(date);
      document.querySelector('app-meter-profile-day-card')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }),
  );
}
