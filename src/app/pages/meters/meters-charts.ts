import type { ChartConfiguration, TooltipItem } from 'chart.js';
import { fr } from 'date-fns/locale';
import type { FullAnalysis } from '../../core/calc/analysis';
import type { Forecast } from '../../core/calc/forecast';
import { dayNumberToDate } from '../../core/calc/time';
import { REGISTERS, type RegisterKey } from '../../core/models/app-data.model';
import { alpha, chartLegend, type ChartColors } from '../../shared/chart/chart-colors';
import { fmt } from '../../shared/format';

const ms = (day: number): number => dayNumberToDate(day).getTime();

const COLOR: Record<RegisterKey, keyof ChartColors> = {
  importPeak: 'importPeak',
  importOff: 'importOff',
  exportPeak: 'exportPeak',
  exportOff: 'exportOff',
};

interface XY {
  x: number;
  y: number;
}

/** Index cumulés des registres choisis : relevés réels (points) puis projection (pointillés). */
export function indexChart(
  analysis: FullAnalysis,
  forecast: Forecast | null,
  keys: readonly RegisterKey[],
  fromDay: number | null,
  forecastDays: number,
  now: number,
) {
  return (c: ChartColors): ChartConfiguration => {
    const levels = analysis.consumption.levels.filter((l) => fromDay === null || l.day >= fromDay);
    const datasets: ChartConfiguration['data']['datasets'] = [];
    for (const key of keys) {
      const color = c[COLOR[key]] as string;
      const info = REGISTERS.find((r) => r.key === key)!;
      const real: XY[] = levels.map((l) => ({ x: ms(l.day), y: l.values[key] ?? 0 }));
      datasets.push({
        type: 'line',
        label: info.short,
        data: real,
        borderColor: color,
        backgroundColor: alpha(color, 0.15),
        pointRadius: 3,
        pointHoverRadius: 5,
        tension: 0.15,
      });
      if (forecast !== null && forecastDays > 0) {
        const last = levels.at(-1);
        const from = last?.day ?? now;
        const points = forecast.points
          .filter((p) => p.day >= from && p.day <= now + forecastDays)
          .filter((_, i, all) => i % 7 === 0 || i === all.length - 1)
          .map((p) => ({ x: ms(p.day), y: p.values[key] }));
        datasets.push({
          type: 'line',
          label: `${info.short} (prévision)`,
          data: points,
          borderColor: alpha(color, 0.75),
          borderDash: [6, 4],
          pointRadius: 0,
          borderWidth: 1.5,
        });
      }
    }
    return {
      type: 'line',
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        parsing: false,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        scales: {
          x: {
            type: 'time',
            adapters: { date: { locale: fr } },
            grid: { color: c.grid },
            ticks: { color: c.muted },
          },
          y: {
            grid: { color: c.grid },
            ticks: { color: c.muted, callback: (v) => fmt.number(Number(v)) },
            title: { display: true, text: 'Index (kWh)', color: c.muted },
          },
        },
        plugins: {
          legend: chartLegend(c),
          tooltip: {
            callbacks: {
              label: (item: TooltipItem<'line'>) =>
                `${item.dataset.label}: ${fmt.kwh((item.raw as XY).y, 1)}`,
            },
          },
        },
      },
    };
  };
}

/** Répartition heures pleines / heures creuses. */
export function splitChart(
  peak: number,
  off: number,
  peakColor: keyof ChartColors,
  offColor: keyof ChartColors,
) {
  return (c: ChartColors): ChartConfiguration => {
    const config: ChartConfiguration<'doughnut'> = {
      type: 'doughnut',
      data: {
        labels: ['Heures pleines', 'Heures creuses'],
        datasets: [
          {
            data: [peak, off],
            backgroundColor: [c[peakColor] as string, c[offColor] as string],
            borderColor: c.surface,
            borderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '62%',
        plugins: {
          legend: chartLegend(c),
          tooltip: {
            callbacks: {
              label: (item: TooltipItem<'doughnut'>) =>
                `${item.label}: ${fmt.kwh(Number(item.raw))}`,
            },
          },
        },
      },
    };
    return config as unknown as ChartConfiguration;
  };
}
