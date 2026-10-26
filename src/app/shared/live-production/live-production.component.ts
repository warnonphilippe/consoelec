import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import type { ChartConfiguration } from 'chart.js';
import { fr } from 'date-fns/locale';
import { InverterService, type PowerPoint } from '../../core/services/inverter.service';
import { VaultService } from '../../core/services/vault.service';
import { ChartComponent, type ChartBuilder } from '../chart/chart.component';
import { alpha, type ChartColors } from '../chart/chart-colors';
import { FORMAT_PIPES, fmt } from '../format';
import { IconComponent } from '../icon.component';

/** Courbe de puissance du jour : de 6 h à 22 h au moins, étendue si des points sortent de cette plage. */
export function dayCurveChart(points: readonly PowerPoint[], now = Date.now()): ChartBuilder {
  return (c: ChartColors): ChartConfiguration => {
    const day = new Date(now);
    const at = (h: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), h).getTime();
    const min = Math.min(at(6), points[0]?.at ?? Infinity);
    const max = Math.max(at(22), points.at(-1)?.at ?? -Infinity);
    return {
      type: 'line',
      data: {
        datasets: [
          {
            label: 'Puissance',
            data: points.map((p) => ({ x: p.at, y: p.powerW })),
            borderColor: c.pv,
            backgroundColor: alpha(c.pv, 0.18),
            fill: 'origin',
            pointRadius: 0,
            pointHoverRadius: 4,
            borderWidth: 2,
            tension: 0.25,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        parsing: false,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        scales: {
          x: {
            type: 'time',
            min,
            max,
            adapters: { date: { locale: fr } },
            time: { unit: 'hour', tooltipFormat: 'HH:mm', displayFormats: { hour: 'HH:mm' } },
            grid: { color: c.grid },
            ticks: { color: c.muted, maxTicksLimit: 9 },
          },
          y: {
            beginAtZero: true,
            grid: { color: c.grid },
            ticks: { color: c.muted, callback: (v) => fmt.number(Number(v)) },
            title: { display: true, text: 'W', color: c.muted },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: { label: (item) => `${fmt.number((item.raw as { y: number }).y)} W` },
          },
        },
      },
    };
  };
}

/** Carte « Production en direct » : puissance, production du jour, index total, et courbe du jour en option. */
@Component({
  selector: 'app-live-production',
  imports: [RouterLink, DatePipe, IconComponent, ChartComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './live-production.component.html',
  styleUrl: './live-production.component.css',
})
export class LiveProductionComponent {
  protected readonly inverter = inject(InverterService);
  protected readonly vault = inject(VaultService);

  /** Affiche la courbe de puissance de la journée sous les valeurs. */
  readonly showCurve = input(false);

  protected readonly curve = computed(() => dayCurveChart(this.inverter.todayCurve()));
  protected readonly hasCurve = computed(() => this.inverter.todayCurve().length >= 2);
}
