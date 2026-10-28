import type { ChartConfiguration } from 'chart.js';
import { fr } from 'date-fns/locale';
import type { ChartColors } from './chart-colors';

type Scales = NonNullable<NonNullable<ChartConfiguration['options']>['scales']>;

/** Largeur de l'axe vertical (px) : fixe, pour que la zone de tracé de deux graphiques de la journée coïncide. */
const Y_AXIS_WIDTH = 64;

/**
 * Axes d'un graphique de la journée (courbe de production, index du compteur) : de 6 h à 22 h, ou jusqu'à maintenant
 * passé 22 h (`untilMs`), graduations toutes les deux heures. Les deux graphiques partagent ces axes, avec une largeur
 * d'axe vertical identique : placés l'un sous l'autre, leurs heures tombent sur les mêmes verticales.
 */
export function dayScales(
  c: ChartColors,
  dayStartMs: number,
  untilMs: number | null,
  y: { title: string; tick: (value: number) => string },
): Scales {
  const day = new Date(dayStartMs);
  const at = (hour: number): number =>
    new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour).getTime();
  return {
    x: {
      type: 'time',
      min: at(6),
      max: Math.max(at(22), untilMs ?? 0),
      adapters: { date: { locale: fr } },
      time: { unit: 'hour', tooltipFormat: 'HH:mm', displayFormats: { hour: 'HH:mm' } },
      grid: { color: c.grid },
      ticks: { color: c.muted, maxTicksLimit: 9 },
    },
    y: {
      beginAtZero: true,
      grid: { color: c.grid },
      ticks: { color: c.muted, callback: (v) => y.tick(Number(v)) },
      title: { display: true, text: y.title, color: c.muted },
      afterFit: (axis) => {
        axis.width = Y_AXIS_WIDTH;
      },
    },
  };
}
