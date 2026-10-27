import type { ChartConfiguration } from 'chart.js';
import { fr } from 'date-fns/locale';
import type { FullAnalysis } from '../../core/calc/analysis';
import type { BalancePoint, BalanceSeries } from '../../core/calc/balance';
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

/**
 * Bornes de l'axe du temps : au plus tôt le début de la période choisie, sinon un peu avant le premier relevé
 * affiché, pour qu'il ne soit pas collé au bord ; à droite, la fin de la prévision ou aujourd'hui.
 */
export function indexAxisRange(
  levelDays: readonly number[],
  fromDay: number | null,
  forecastDays: number,
  now: number,
): { min: number; max: number } {
  const max = now + Math.max(0, forecastDays);
  const first = levelDays[0];
  if (first === undefined) {
    return { min: fromDay ?? now - 30, max };
  }
  const margin = Math.max(2, Math.round((max - first) * 0.04));
  return { min: Math.max(fromDay ?? -Infinity, first - margin), max };
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
    const range = indexAxisRange(
      levels.map((l) => l.day),
      fromDay,
      forecast !== null ? forecastDays : 0,
      now,
    );
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
            min: ms(range.min),
            max: ms(range.max),
            adapters: { date: { locale: fr } },
            time: {
              tooltipFormat: 'd MMMM yyyy',
              displayFormats: { day: 'd MMM', week: 'd MMM', month: 'MMM yyyy', quarter: 'MMM yyyy' },
            },
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
              label: (item) =>
                `${item.dataset.label}: ${fmt.kwh((item.raw as XY).y, 1)}`,
            },
          },
        },
      },
    };
  };
}

/**
 * Soldes de facturation HP et HC (soutiré − injecté par période tarifaire) depuis le début de l'année de facturation :
 * mesurés aux relevés, puis prévus (pointillés) ; ils repartent de zéro à chaque début d'année.
 */
export function balanceChart(
  series: BalanceSeries,
  levelDays: readonly number[],
  fromDay: number | null,
  forecastDays: number,
  now: number,
) {
  return (c: ChartColors): ChartConfiguration => {
    const range = indexAxisRange(levelDays, fromDay, series.forecast.length > 0 ? forecastDays : 0, now);
    const visible = (p: BalancePoint) => p.day >= range.min && p.day <= range.max;
    const lines = [
      { key: 'hp' as const, label: 'Solde heures pleines', color: c[COLOR.importPeak] as string },
      { key: 'hc' as const, label: 'Solde heures creuses', color: c[COLOR.importOff] as string },
    ];
    const datasets: ChartConfiguration['data']['datasets'] = [];
    for (const line of lines) {
      datasets.push({
        type: 'line',
        label: line.label,
        data: series.history.filter(visible).map((p) => ({ x: ms(p.day), y: p[line.key] })),
        borderColor: line.color,
        backgroundColor: alpha(line.color, 0.15),
        pointRadius: 3,
        pointHoverRadius: 5,
        tension: 0,
      });
      if (series.forecast.length > 0 && forecastDays > 0) {
        datasets.push({
          type: 'line',
          label: `${line.label} (prévision)`,
          data: series.forecast.filter(visible).map((p) => ({ x: ms(p.day), y: p[line.key] })),
          borderColor: alpha(line.color, 0.75),
          borderDash: [6, 4],
          pointRadius: 0,
          borderWidth: 1.5,
          tension: 0,
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
            min: ms(range.min),
            max: ms(range.max),
            adapters: { date: { locale: fr } },
            time: {
              tooltipFormat: 'd MMMM yyyy',
              displayFormats: { day: 'd MMM', week: 'd MMM', month: 'MMM yyyy', quarter: 'MMM yyyy' },
            },
            grid: { color: c.grid },
            ticks: { color: c.muted },
          },
          y: {
            // La ligne zéro sépare ce qui sera facturé (au-dessus) du surplus non remboursé (en dessous).
            grid: { color: (ctx) => (ctx.tick.value === 0 ? c.muted : c.grid) },
            ticks: { color: c.muted, callback: (v) => fmt.number(Number(v)) },
            title: { display: true, text: 'Solde (kWh)', color: c.muted },
          },
        },
        plugins: {
          legend: chartLegend(c),
          tooltip: {
            callbacks: {
              label: (item) => {
                const y = (item.raw as XY).y;
                return `${item.dataset.label}: ${fmt.signedKwh(y)} ${y > 0 ? '(à payer)' : y < 0 ? '(surplus)' : ''}`;
              },
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
              label: (item) =>
                `${item.label}: ${fmt.kwh(Number(item.raw))}`,
            },
          },
        },
      },
    };
    return config as unknown as ChartConfiguration;
  };
}
