/**
 * Cadres que l'on peut placer sur le tableau de bord (clic droit sur un cadre d'une page de données). Le registre qui
 * associe chaque identifiant à son composant est dans `src/app/cards/card-registry.ts`.
 */
export const DASHBOARD_CARD_IDS = [
  'live-meter',
  'live-production',
  'billing-hp',
  'billing-hc',
  'billing-cost',
  'billing-schedule',
  'meters-total-import',
  'meters-total-export',
  'meters-register-importPeak',
  'meters-register-importOff',
  'meters-register-exportPeak',
  'meters-register-exportOff',
  'meters-recent-power',
  'meters-today-energy',
  'meters-index-chart',
  'meters-profile-day',
  'meters-profile-days',
  'meters-balance',
  'meters-balance-to-date',
  'meters-balance-current-year',
  'meters-balance-next-year',
  'meters-split-import',
  'meters-split-export',
  'production-day',
  'production-7d',
  'production-30d',
  'production-year',
  'production-best-day',
  'production-yield',
  'production-history',
  'stats-season-winter',
  'stats-season-spring',
  'stats-season-summer',
  'stats-season-autumn',
  'stats-years-chart',
  'stats-monthly-table',
  'stats-registers',
  'forecast-controls',
  'forecast-import',
  'forecast-export',
  'forecast-net',
  'forecast-ev',
  'forecast-monthly-chart',
  'forecast-index-chart',
  'forecast-reliability',
  'forecast-profiles',
  'forecast-year-ends',
] as const;

export type CardId = (typeof DASHBOARD_CARD_IDS)[number];

/** Tableau de bord d'origine : compteur et production en direct, soldes et coût de l'année, horaire HP / HC. */
export const DEFAULT_DASHBOARD: readonly CardId[] = [
  'live-meter',
  'live-production',
  'billing-hp',
  'billing-hc',
  'billing-cost',
  'billing-schedule',
];

const KNOWN = new Set<string>(DASHBOARD_CARD_IDS);

export function isCardId(value: unknown): value is CardId {
  return typeof value === 'string' && KNOWN.has(value);
}

/** Disposition lue dans un fichier : les seuls cadres connus, sans doublon ; absente, celle d'origine. */
export function normalizeDashboard(value: unknown): CardId[] {
  if (!Array.isArray(value)) {
    return [...DEFAULT_DASHBOARD];
  }
  return [...new Set(value.filter(isCardId))];
}

/** Ajoute le cadre à la fin, ou le retire s'il y est déjà. */
export function toggleDashboardCard(layout: readonly CardId[], id: CardId): CardId[] {
  return layout.includes(id) ? layout.filter((c) => c !== id) : [...layout, id];
}

/**
 * Déplace le cadre d'une place (−1 : monter, +1 : descendre) parmi les cadres affichés (`shown`) : il passe avant ou
 * après son voisin affiché, les cadres masqués (lecteur P1 désactivé…) gardent leur place.
 */
export function moveDashboardCard(
  layout: readonly CardId[],
  id: CardId,
  delta: -1 | 1,
  shown: readonly CardId[] = layout,
): CardId[] {
  const order = shown.filter((c) => layout.includes(c));
  const neighbor = order[order.indexOf(id) + delta];
  if (!order.includes(id) || neighbor === undefined) {
    return [...layout];
  }
  const next = layout.filter((c) => c !== id);
  const at = next.indexOf(neighbor);
  next.splice(delta < 0 ? at : at + 1, 0, id);
  return next;
}
