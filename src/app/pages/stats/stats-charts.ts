import type { ChartConfiguration } from 'chart.js';
import type { MonthBucket } from '../../core/calc/consumption';
import type { ReferenceProfile } from '../../core/calc/reference';
import type { YearRow } from '../../core/calc/stats';
import { MONTH_SHORT } from '../../core/calc/time';
import { alpha, chartLegend, type ChartColors } from '../../shared/chart/chart-colors';
import { fmt } from '../../shared/format';
import { metricValue, referenceValue, type MetricKey } from './stats-metrics';

/** Un jeu de barres par année, mois par mois, et la référence belge en pointillés. */
export function yearsChart(metric: MetricKey, years: YearRow[], reference: ReferenceProfile) {
  return (c: ChartColors): ChartConfiguration => {
    const bars = years.map((row, i) => {
      const color = c.years[i % c.years.length]!;
      const cells: (MonthBucket | null)[] = row.months;
      return {
        type: 'bar' as const,
        label: String(row.year),
        data: cells.map((b) => (b ? metricValue(metric, b) : null)),
        backgroundColor: cells.map((b) => (b && b.complete ? color : alpha(color, 0.4))),
        borderRadius: 3,
      };
    });
    return {
      type: 'bar',
      data: {
        labels: [...MONTH_SHORT],
        datasets: [
          ...bars,
          {
            type: 'line',
            label: 'Référence belge',
            data: Array.from({ length: 12 }, (_, m) => referenceValue(metric, reference, m)),
            borderColor: c.reference,
            borderDash: [6, 4],
            pointRadius: 2,
            tension: 0.25,
            borderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { grid: { display: false }, ticks: { color: c.muted } },
          y: {
            grid: { color: c.grid },
            ticks: { color: c.muted, callback: (v) => fmt.number(Number(v)) },
            title: { display: true, text: 'kWh', color: c.muted },
          },
        },
        plugins: {
          legend: chartLegend(c),
          tooltip: {
            callbacks: {
              label: (item) =>
                `${item.dataset.label}: ${fmt.kwh(Number(item.raw))}`,
            },
          },
        },
      },
    };
  };
}
