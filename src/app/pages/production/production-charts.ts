import type { ChartConfiguration } from 'chart.js';
import type { ProductionDay, ProductionMonth, ProductionStatus } from '../../core/calc/production';
import { MONTH_SHORT, dayNumberToDate } from '../../core/calc/time';
import type { ChartBuilder } from '../../shared/chart/chart.component';
import { alpha, chartLegend, type ChartColors } from '../../shared/chart/chart-colors';
import { fmt } from '../../shared/format';

const STATUS_LABEL: Record<ProductionStatus, string> = {
  measured: 'lue sur l’onduleur',
  estimated: 'estimée entre deux index',
  partial: 'journée incomplète',
  today: 'en cours',
};

const DAY_FORMAT = new Intl.DateTimeFormat('fr-BE', { weekday: 'short', day: 'numeric', month: 'short' });

interface Bar {
  readonly label: string;
  readonly kwh: number;
  readonly expected: number;
  /** Barre pâle : valeur estimée ou période incomplète. */
  readonly faded: boolean;
  readonly detail: string;
}

/** `marks` : l'attendu est un trait horizontal par barre plutôt qu'une courbe (périodes sans continuité, les années). */
function barChart(bars: readonly Bar[], expectedLabel: string, marks = false): ChartBuilder {
  return (c: ChartColors): ChartConfiguration => ({
    type: 'bar',
    data: {
      labels: bars.map((b) => b.label),
      datasets: [
        {
          type: 'bar',
          label: 'Production',
          data: bars.map((b) => b.kwh),
          backgroundColor: bars.map((b) => alpha(c.pv, b.faded ? 0.35 : 0.85)),
          borderColor: c.pv,
          borderWidth: bars.map((b) => (b.faded ? 1 : 0)),
          borderRadius: 3,
          order: 2,
        },
        {
          type: 'line',
          label: expectedLabel,
          data: bars.map((b) => b.expected),
          borderColor: c.reference,
          backgroundColor: c.reference,
          borderDash: marks ? [] : [6, 4],
          borderWidth: marks ? 2 : 1.5,
          showLine: !marks,
          pointStyle: 'line',
          pointRadius: marks ? 28 : 0,
          pointHoverRadius: marks ? 28 : 3,
          tension: 0.3,
          order: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { grid: { display: false }, ticks: { color: c.muted, maxRotation: 0, autoSkipPadding: 8 } },
        y: {
          beginAtZero: true,
          grid: { color: c.grid },
          ticks: { color: c.muted, callback: (v) => fmt.number(Number(v)) },
          title: { display: true, text: 'kWh', color: c.muted },
        },
      },
      plugins: {
        legend: chartLegend(c),
        tooltip: {
          callbacks: {
            label: (item) => {
              const bar = bars[item.dataIndex]!;
              return item.datasetIndex === 0
                ? `Production : ${fmt.kwh(bar.kwh, 1)} (${bar.detail})`
                : `${expectedLabel} : ${fmt.kwh(bar.expected, 1)}`;
            },
          },
        },
      },
    },
  });
}

/** Production des derniers jours, une barre par jour, avec la production attendue. */
export function dailyChart(days: readonly ProductionDay[]): ChartBuilder {
  return barChart(
    days.map((d) => ({
      label: DAY_FORMAT.format(dayNumberToDate(d.day)),
      kwh: d.kwh,
      expected: d.expected,
      faded: d.status !== 'measured',
      detail: STATUS_LABEL[d.status],
    })),
    'Attendu (référence)',
  );
}

/** Production par mois ; l'attendu d'un mois incomplet ne porte que sur ses jours couverts. */
export function monthlyChart(months: readonly ProductionMonth[]): ChartBuilder {
  const multiYear = new Set(months.map((m) => m.year)).size > 1;
  return barChart(
    months.map((m) => ({
      label: multiYear ? `${MONTH_SHORT[m.month]} ${String(m.year).slice(2)}` : MONTH_SHORT[m.month]!,
      kwh: m.kwh,
      expected: m.complete ? m.expected : m.expectedCovered,
      faded: !m.complete,
      detail: m.complete ? 'mois complet' : `${m.days} jour${m.days > 1 ? 's' : ''} couvert${m.days > 1 ? 's' : ''}`,
    })),
    'Attendu (référence)',
  );
}

export interface YearTotal {
  readonly year: number;
  readonly kwh: number;
  readonly expected: number;
  readonly days: number;
  readonly complete: boolean;
}

/** Totaux par année civile, à partir des mois. */
export function yearTotals(months: readonly ProductionMonth[]): YearTotal[] {
  const years = new Map<number, { kwh: number; expected: number; days: number; complete: number }>();
  for (const m of months) {
    const y = years.get(m.year) ?? { kwh: 0, expected: 0, days: 0, complete: 0 };
    y.kwh += m.kwh;
    y.expected += m.complete ? m.expected : m.expectedCovered;
    y.days += m.days;
    y.complete += m.complete ? 1 : 0;
    years.set(m.year, y);
  }
  return [...years.entries()].map(([year, y]) => ({
    year,
    kwh: y.kwh,
    expected: y.expected,
    days: y.days,
    complete: y.complete === 12,
  }));
}

export function yearlyChart(years: readonly YearTotal[]): ChartBuilder {
  return barChart(
    years.map((y) => ({
      label: String(y.year),
      kwh: y.kwh,
      expected: y.expected,
      faded: !y.complete,
      detail: y.complete ? 'année complète' : `${y.days} jours couverts`,
    })),
    'Attendu (référence)',
    true,
  );
}
