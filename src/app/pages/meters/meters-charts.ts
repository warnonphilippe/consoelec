import type { Chart, ChartConfiguration, Plugin } from 'chart.js';
import { fr } from 'date-fns/locale';
import type { FullAnalysis } from '../../core/calc/analysis';
import type { BalancePoint, BalanceSeries, LimitPoint } from '../../core/calc/balance';
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

/** Suffixe des courbes de prévision (« Soutirage HP (prévision) »). */
const FORECAST_SUFFIX = ' (prévision)';

/**
 * Faut-il garder une ligne dans l'infobulle ? Une prévision est masquée quand la valeur mesurée de la même série est
 * déjà dans l'infobulle : à la date du dernier relevé, la prévision démarre sur le même point et doublerait la liste.
 */
export function keepTooltipItem(
  label: string | undefined,
  labels: readonly (string | undefined)[],
): boolean {
  if (!label?.endsWith(FORECAST_SUFFIX)) {
    return true;
  }
  return !labels.includes(label.slice(0, -FORECAST_SUFFIX.length));
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

/**
 * Jours de prévision à montrer : si une fin d'année de facturation tombe dans les 15 jours qui suivent la période
 * choisie, on va jusqu'à elle (la vue « + 12 mois » du 27 octobre montre ainsi la facturation du 1er novembre).
 */
export function billingHorizon(yearEnds: readonly number[], now: number, forecastDays: number): number {
  if (forecastDays <= 0) {
    return forecastDays;
  }
  const end = yearEnds.find((e) => e > now + forecastDays && e <= now + forecastDays + 15);
  return end === undefined ? forecastDays : Math.ceil(end - now) + 2;
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
            filter: (item, _index, items) =>
              keepTooltipItem(
                item.dataset.label,
                items.map((i) => i.dataset.label),
              ),
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
 * Points à partir de `day` seulement : la courbe démarre sur un point interpolé à cette date (prévision et limites
 * ne s'affichent pas dans le passé).
 */
export function pointsFrom<T extends LimitPoint>(points: readonly T[], day: number): T[] {
  const kept: T[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (p.day < day) {
      continue;
    }
    const before = points[i - 1];
    if (kept.length === 0 && before && p.day > day) {
      const f = (day - before.day) / (p.day - before.day);
      const lerp = (a: number | null, b: number | null) => (a === null || b === null ? null : a + (b - a) * f);
      kept.push({ day, hp: lerp(before.hp, p.hp), hc: lerp(before.hc, p.hc) } as T);
    }
    kept.push(p);
  }
  return kept;
}

interface BalanceDatum {
  x: number;
  y: number | null;
  kind: BalancePoint['kind'];
}

interface CurveLabel {
  /** Libellé du jeu de données à annoter. */
  readonly dataset: string;
  readonly text: string;
  /** `top` : au point le plus haut de la courbe visible (le dernier, à égalité) ; `end` : à son dernier point visible. */
  readonly at: 'top' | 'end';
  readonly color: string;
}

/**
 * Libellés courts posés sur les courbes (« Limite HC », « Prévision HC ») pour les distinguer sans passer par la
 * légende ; décalés vers le bas quand ils se chevauchent, ignorés pour une courbe masquée.
 */
function curveLabels(labels: readonly CurveLabel[], background: string): Plugin {
  return {
    id: 'curveLabels',
    afterDatasetsDraw(chart: Chart) {
      const { ctx, chartArea } = chart;
      ctx.save();
      ctx.font = '600 11px ui-sans-serif, system-ui, -apple-system, sans-serif';
      ctx.textBaseline = 'middle';
      const placed: { x: number; y: number; w: number; h: number }[] = [];
      const overlaps = (r: { x: number; y: number; w: number; h: number }) =>
        placed.some((p) => r.x < p.x + p.w && p.x < r.x + r.w && r.y < p.y + p.h && p.y < r.y + r.h);
      for (const label of labels) {
        const index = chart.data.datasets.findIndex((d) => d.label === label.dataset);
        if (index < 0 || !chart.isDatasetVisible(index)) {
          continue;
        }
        const points = chart
          .getDatasetMeta(index)
          .data.filter(
            (p) =>
              !(p as unknown as { skip?: boolean }).skip &&
              p.x >= chartArea.left &&
              p.x <= chartArea.right &&
              Number.isFinite(p.y),
          );
        if (points.length === 0) {
          continue;
        }
        const anchor =
          // À égalité (palier d'hiver), le dernier point le plus haut : la bascule de la courbe.
          label.at === 'top' ? points.reduce((a, b) => (b.y <= a.y + 0.5 ? b : a)) : points[points.length - 1]!;
        const w = ctx.measureText(label.text).width + 10;
        const h = 17;
        const rect = {
          x: Math.min(Math.max(anchor.x - w / 2, chartArea.left), chartArea.right - w),
          y: Math.min(Math.max(anchor.y - h - 6, chartArea.top), chartArea.bottom - h),
          w,
          h,
        };
        for (let i = 0; i < 6 && overlaps(rect); i++) {
          rect.y = Math.min(rect.y + h + 2, chartArea.bottom - h);
        }
        placed.push(rect);
        ctx.fillStyle = background;
        ctx.strokeStyle = label.color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(rect.x, rect.y, rect.w, rect.h, 4);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = label.color;
        ctx.textAlign = 'center';
        ctx.fillText(label.text, rect.x + rect.w / 2, rect.y + rect.h / 2 + 0.5);
      }
      ctx.restore();
    },
  };
}

/** Trait vertical pointillé « Facturation » à chaque début d'année de facturation. */
function billingLines(days: readonly number[], color: string): Plugin {
  return {
    id: 'billingLines',
    afterDatasetsDraw(chart: Chart) {
      const x = chart.scales['x'];
      const { ctx, chartArea } = chart;
      if (!x) {
        return;
      }
      ctx.save();
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.setLineDash([3, 4]);
      ctx.lineWidth = 1;
      ctx.font = '11px ui-sans-serif, system-ui, -apple-system, sans-serif';
      ctx.textAlign = 'center';
      for (const day of days) {
        const px = x.getPixelForValue(ms(day));
        if (px < chartArea.left || px > chartArea.right) {
          continue;
        }
        ctx.beginPath();
        ctx.moveTo(px, chartArea.top);
        ctx.lineTo(px, chartArea.bottom);
        ctx.stroke();
        ctx.fillText('Facturation', px, chartArea.top - 4);
      }
      ctx.restore();
    },
  };
}

/**
 * Soldes de facturation HP et HC (soutiré − injecté par période tarifaire) depuis le début de l'année de facturation :
 * mesurés aux relevés, puis prévus (tirets) ; ils repartent de zéro à chaque début d'année. Les courbes limites (gros
 * points, étiquetés) sont le plafond à ne pas dépasser pour ne rien payer en fin d'année. Prévision et limites ne
 * s'affichent qu'à partir d'aujourd'hui.
 */
export function balanceChart(
  series: BalanceSeries,
  levelDays: readonly number[],
  fromDay: number | null,
  forecastDays: number,
  now: number,
) {
  return (c: ChartColors): ChartConfiguration => {
    const shownDays = billingHorizon(
      series.years.map((y) => y.end),
      now,
      series.forecast.length > 0 ? forecastDays : 0,
    );
    const range = indexAxisRange(levelDays, fromDay, shownDays, now);
    const visible = (p: LimitPoint) => p.day >= range.min && p.day <= range.max;
    // À chaque facturation, la courbe s'arrête sur le solde facturé (point marqué), puis repart de zéro : un point
    // vide entre les deux évite le trait vertical, qui ressemblerait à une chute de consommation.
    const toData = (points: readonly LimitPoint[], key: 'hp' | 'hc') => {
      const data: BalanceDatum[] = [];
      for (const p of points.filter(visible)) {
        if (p.kind === 'yearStart' && data.length > 0) {
          data.push({ x: ms(p.day), y: null, kind: undefined });
        }
        data.push({ x: ms(p.day), y: p[key], kind: p.kind });
      }
      return data;
    };
    const radius = (base: number) => (ctx: { raw: unknown }) =>
      (ctx.raw as BalanceDatum | undefined)?.kind === 'yearEnd' ? 6 : base;
    const billingDays = [...series.history, ...pointsFrom(series.forecast, now)]
      .filter((p) => p.kind === 'yearStart' && visible(p))
      .map((p) => p.day);
    const lines = [
      { key: 'hp' as const, short: 'HP', label: 'Solde heures pleines', limit: 'Limite heures pleines', color: c[COLOR.importPeak] as string },
      { key: 'hc' as const, short: 'HC', label: 'Solde heures creuses', limit: 'Limite heures creuses', color: c[COLOR.importOff] as string },
    ];
    const limitLabels: string[] = lines.map((l) => l.limit);
    const onCurves: CurveLabel[] = lines.flatMap((l) => [
      { dataset: l.limit, text: `Limite ${l.short} (max.)`, at: 'top' as const, color: l.color },
      { dataset: `${l.label} (prévision)`, text: `Prévision ${l.short}`, at: 'end' as const, color: l.color },
    ]);
    const datasets: ChartConfiguration['data']['datasets'] = [];
    for (const line of lines) {
      datasets.push({
        type: 'line',
        label: line.label,
        data: toData(series.history, line.key) as unknown as XY[],
        borderColor: line.color,
        backgroundColor: line.color,
        pointRadius: radius(3),
        pointHoverRadius: radius(5),
        tension: 0,
      });
      if (series.forecast.length > 0 && forecastDays > 0) {
        datasets.push({
          type: 'line',
          label: `${line.label} (prévision)`,
          data: toData(pointsFrom(series.forecast, now), line.key) as unknown as XY[],
          borderColor: alpha(line.color, 0.75),
          backgroundColor: alpha(line.color, 0.75),
          borderDash: [6, 4],
          pointRadius: radius(0),
          pointHoverRadius: radius(4),
          borderWidth: 1.5,
          tension: 0,
        });
      }
      if (series.limit.length > 0) {
        datasets.push({
          type: 'line',
          label: line.limit,
          data: toData(pointsFrom(series.limit, now), line.key) as unknown as XY[],
          // Points ronds espacés, plus épais que les tirets de la prévision : on ne confond pas les deux.
          borderColor: line.color,
          backgroundColor: line.color,
          borderDash: [0.5, 5],
          borderCapStyle: 'round',
          borderWidth: 3,
          pointRadius: 0,
          pointHoverRadius: 3,
          tension: 0.3,
        });
      }
    }
    return {
      type: 'line',
      data: { datasets },
      plugins: [billingLines(billingDays, c.muted), curveLabels(onCurves, alpha(c.surface, 0.9))],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        parsing: false,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        layout: { padding: { top: 16 } },
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
            filter: (item, _index, items) =>
              keepTooltipItem(
                item.dataset.label,
                items.map((i) => i.dataset.label),
              ),
            callbacks: {
              label: (item) => {
                const raw = item.raw as BalanceDatum;
                const y = raw.y ?? 0;
                if (limitLabels.includes(item.dataset.label ?? '')) {
                  return `${item.dataset.label} : ne pas dépasser ${fmt.signedKwh(y)} (en dessous, l'année finit à zéro ou en surplus)`;
                }
                if (raw.kind === 'yearEnd') {
                  return `${item.dataset.label} facturé : ${fmt.signedKwh(y)} ${y > 0 ? '(à payer)' : y < 0 ? '(surplus perdu)' : ''}`;
                }
                if (raw.kind === 'yearStart') {
                  return `${item.dataset.label} : nouvelle année de facturation`;
                }
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
