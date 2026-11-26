import type { ChartConfiguration } from 'chart.js';
import { alpha, chartLegend, type ChartColors } from '../../shared/chart/chart-colors';
import { fmt } from '../../shared/format';

export interface MonthBar {
  readonly key: string;
  readonly label: string;
  /** Mois prévu (pas encore mesuré). */
  readonly forecast: boolean;
  /** Mois mesuré mais entamé ou partiellement couvert. */
  readonly partial: boolean;
  readonly importPeak: number;
  readonly importOff: number;
  readonly exportPeak: number;
  readonly exportOff: number;
}

/** Soldes du mois par compteur : les heures pleines et creuses se facturent séparément. */
const balances = (b: MonthBar): string =>
  `Solde HP : ${fmt.signedKwh(b.importPeak - b.exportPeak)} · HC : ${fmt.signedKwh(b.importOff - b.exportOff)}`;

/** Soutirage (vers le haut) et injection (vers le bas), empilés par tarif. */
export function monthlyBalanceChart(bars: MonthBar[]) {
  return (c: ChartColors): ChartConfiguration => {
    const fill = (color: string): string[] =>
      bars.map((b) => (b.forecast || b.partial ? alpha(color, 0.4) : color));
    const dataset = (label: string, color: string, values: number[]) => ({
      label,
      data: values,
      backgroundColor: fill(color),
      borderColor: bars.map((b) => (b.forecast ? color : 'transparent')),
      borderWidth: bars.map((b) => (b.forecast ? 1 : 0)),
      borderDash: [4, 3],
      stack: 'bilan',
    });
    return {
      type: 'bar',
      data: {
        labels: bars.map((b) => b.label),
        datasets: [
          dataset(
            'Soutirage heures pleines',
            c.importPeak,
            bars.map((b) => b.importPeak),
          ),
          dataset(
            'Soutirage heures creuses',
            c.importOff,
            bars.map((b) => b.importOff),
          ),
          dataset(
            'Injection heures pleines',
            c.exportPeak,
            bars.map((b) => -b.exportPeak),
          ),
          dataset(
            'Injection heures creuses',
            c.exportOff,
            bars.map((b) => -b.exportOff),
          ),
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: {
            stacked: true,
            grid: { display: false },
            ticks: { color: c.muted, maxRotation: 0, autoSkip: true },
          },
          y: {
            stacked: true,
            grid: { color: c.grid },
            ticks: { color: c.muted, callback: (v) => fmt.number(Math.abs(Number(v))) },
            title: { display: true, text: 'kWh  (↑ soutiré · ↓ injecté)', color: c.muted },
          },
        },
        plugins: {
          legend: chartLegend(c),
          tooltip: {
            callbacks: {
              title: (items) => {
                const bar = bars[items[0]?.dataIndex ?? 0];
                return bar
                  ? `${bar.label}${bar.forecast ? ' (prévision)' : bar.partial ? ' (incomplet)' : ''}`
                  : '';
              },
              label: (item) =>
                `${item.dataset.label}: ${fmt.kwh(Math.abs(Number(item.raw)))}`,
              footer: (items) => {
                const bar = bars[items[0]?.dataIndex ?? 0];
                return bar ? balances(bar) : '';
              },
            },
          },
        },
      },
    };
  };
}
