import type { EffectiveTheme } from '../../core/services/theme.service';

/** Couleurs des graphiques, alignées sur les tokens de `styles.css`. */
export interface ChartColors {
  readonly text: string;
  readonly muted: string;
  readonly grid: string;
  readonly surface: string;
  readonly importPeak: string;
  readonly importOff: string;
  readonly exportPeak: string;
  readonly exportOff: string;
  readonly pv: string;
  readonly net: string;
  readonly reference: string;
  readonly adjusted: string;
  readonly history: string;
  readonly years: readonly string[];
}

const DARK: ChartColors = {
  text: '#e2e8f0',
  muted: '#94a3b8',
  grid: 'rgba(148, 163, 184, 0.12)',
  surface: '#1e293b',
  importPeak: '#3b82f6',
  importOff: '#818cf8',
  exportPeak: '#f59e0b',
  exportOff: '#2dd4bf',
  pv: '#facc15',
  net: '#f472b6',
  reference: '#94a3b8',
  adjusted: '#a78bfa',
  history: '#10b981',
  years: ['#3b82f6', '#10b981', '#f59e0b', '#a78bfa', '#f472b6', '#22d3ee', '#94a3b8'],
};

const LIGHT: ChartColors = {
  text: '#0f172a',
  muted: '#475569',
  grid: 'rgba(15, 23, 42, 0.08)',
  surface: '#ffffff',
  importPeak: '#2563eb',
  importOff: '#4f46e5',
  exportPeak: '#d97706',
  exportOff: '#0d9488',
  pv: '#ca8a04',
  net: '#db2777',
  reference: '#64748b',
  adjusted: '#7c3aed',
  history: '#059669',
  years: ['#2563eb', '#059669', '#d97706', '#7c3aed', '#db2777', '#0891b2', '#64748b'],
};

export function chartColors(theme: EffectiveTheme): ChartColors {
  return theme === 'dark' ? DARK : LIGHT;
}

/** Couleur avec transparence (`#rrggbb` → `rgba`). */
export function alpha(hex: string, opacity: number): string {
  const value = hex.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

/** Légende commune : en bas, pastilles rondes, cliquable pour masquer une série. */
export function chartLegend(c: ChartColors) {
  return {
    position: 'bottom' as const,
    labels: { color: c.text, usePointStyle: true, pointStyleWidth: 14, boxHeight: 8, padding: 14 },
  };
}
