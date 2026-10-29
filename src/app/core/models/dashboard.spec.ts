import { DEFAULT_SETTINGS } from './app-data.model';
import {
  DASHBOARD_CARD_IDS,
  DEFAULT_DASHBOARD,
  moveDashboardCard,
  normalizeDashboard,
  toggleDashboardCard,
  type CardId,
} from './dashboard';
import { normalizeData } from './normalize';

describe('disposition du tableau de bord', () => {
  it('reprend le tableau de bord d’origine quand le fichier n’en a pas', () => {
    expect(normalizeDashboard(undefined)).toEqual(DEFAULT_DASHBOARD);
    expect(normalizeData({ readings: [] }).settings.dashboard).toEqual(DEFAULT_DASHBOARD);
    expect(DEFAULT_SETTINGS.dashboard).toEqual(DEFAULT_DASHBOARD);
  });

  it('écarte les cadres inconnus et les doublons, garde un tableau vide', () => {
    expect(normalizeDashboard(['billing-hp', 'inconnu', 3, 'billing-hp', 'stats-registers'])).toEqual([
      'billing-hp',
      'stats-registers',
    ]);
    expect(normalizeDashboard([])).toEqual([]);
    expect(DEFAULT_DASHBOARD.every((id) => DASHBOARD_CARD_IDS.includes(id))).toBe(true);
  });

  it('ajoute un cadre à la fin, ou le retire', () => {
    const layout: CardId[] = ['billing-hp', 'billing-hc'];
    expect(toggleDashboardCard(layout, 'meters-recent-power')).toEqual(['billing-hp', 'billing-hc', 'meters-recent-power']);
    expect(toggleDashboardCard(layout, 'billing-hp')).toEqual(['billing-hc']);
  });

  it('monte et descend un cadre sans sortir de la liste', () => {
    const layout: CardId[] = ['billing-hp', 'billing-hc', 'billing-cost'];
    expect(moveDashboardCard(layout, 'billing-hc', -1)).toEqual(['billing-hc', 'billing-hp', 'billing-cost']);
    expect(moveDashboardCard(layout, 'billing-hc', 1)).toEqual(['billing-hp', 'billing-cost', 'billing-hc']);
    expect(moveDashboardCard(layout, 'billing-hp', -1)).toEqual(layout);
    expect(moveDashboardCard(layout, 'billing-cost', 1)).toEqual(layout);
  });

  it('déplace parmi les cadres affichés : un cadre masqué garde sa place', () => {
    // Compteur en direct masqué (lecteur P1 désactivé) : « Monter » passe devant le cadre affiché précédent.
    const layout: CardId[] = ['billing-hp', 'live-meter', 'billing-hc'];
    const shown: CardId[] = ['billing-hp', 'billing-hc'];
    expect(moveDashboardCard(layout, 'billing-hc', -1, shown)).toEqual(['billing-hc', 'billing-hp', 'live-meter']);
    expect(moveDashboardCard(layout, 'billing-hp', 1, shown)).toEqual(['live-meter', 'billing-hc', 'billing-hp']);
    expect(moveDashboardCard(layout, 'billing-hp', -1, shown)).toEqual(layout);
  });
});
