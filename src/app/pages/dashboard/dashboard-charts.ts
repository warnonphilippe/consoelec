import type { ChartConfiguration } from 'chart.js';
import type { FullAnalysis } from '../../core/calc/analysis';
import { MONTH_SHORT } from '../../core/calc/time';
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

const labelOf = (year: number, month: number): string =>
  `${MONTH_SHORT[month]} ${String(year).slice(2)}`;

/** Barres mensuelles : mois mesurés (les `historyMonths` derniers, ou tous) puis mois prévus. */
export function monthBars(
  analysis: FullAnalysis,
  historyMonths: number | null,
  forecastMonths: number,
): MonthBar[] {
  const measured = analysis.consumption.months;
  const shown = historyMonths === null ? measured : measured.slice(-historyMonths);
  const bars: MonthBar[] = shown.map((m) => ({
    key: m.key,
    label: labelOf(m.year, m.month),
    forecast: false,
    partial: !m.complete,
    importPeak: m.values.importPeak,
    importOff: m.values.importOff,
    exportPeak: m.values.exportPeak,
    exportOff: m.values.exportOff,
  }));
  const lastKey = measured.at(-1)?.key ?? '';
  const best = analysis.base.best;
  if (best !== null && forecastMonths > 0) {
    const future = best.months.filter((m) => m.key > lastKey).slice(0, forecastMonths);
    for (const m of future) {
      bars.push({
        key: m.key,
        label: labelOf(m.year, m.month),
        forecast: true,
        partial: false,
        importPeak: m.values.importPeak,
        importOff: m.values.importOff,
        exportPeak: m.values.exportPeak,
        exportOff: m.values.exportOff,
      });
    }
  }
  return bars;
}

const net = (b: MonthBar): number => b.importPeak + b.importOff - b.exportPeak - b.exportOff;

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
                return bar ? `Solde net : ${fmt.signedKwh(net(bar))}` : '';
              },
            },
          },
        },
      },
    };
  };
}

/** Solde net cumulé (soutirage − injection) à partir du premier mois affiché. */
export function cumulativeNetChart(bars: MonthBar[]) {
  return (c: ChartColors): ChartConfiguration => {
    let total = 0;
    const values = bars.map((b) => (total += net(b)));
    const firstForecast = bars.findIndex((b) => b.forecast);
    return {
      type: 'line',
      data: {
        labels: bars.map((b) => b.label),
        datasets: [
          {
            label: 'Solde net cumulé',
            data: values,
            borderColor: c.net,
            backgroundColor: alpha(c.net, 0.12),
            fill: 'origin',
            tension: 0.25,
            pointRadius: 2,
            segment: {
              borderDash: (ctx) =>
                firstForecast !== -1 && ctx.p1DataIndex >= firstForecast ? [5, 4] : undefined,
            },
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: c.muted, maxRotation: 0, autoSkip: true },
          },
          y: {
            grid: { color: c.grid },
            ticks: { color: c.muted, callback: (v) => fmt.number(Number(v)) },
            title: { display: true, text: 'kWh  (> 0 : plus soutiré qu’injecté)', color: c.muted },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: { label: (item) => fmt.signedKwh(Number(item.raw)) },
          },
        },
      },
    };
  };
}
