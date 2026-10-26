import type { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    title: 'Tableau de bord',
    loadComponent: () => import('./pages/dashboard/dashboard.page'),
  },
  {
    path: 'compteurs',
    title: 'Compteurs',
    loadComponent: () => import('./pages/meters/meters.page'),
  },
  {
    path: 'production',
    title: 'Production',
    loadComponent: () => import('./pages/production/production.page'),
  },
  {
    path: 'releves',
    title: 'Relevés',
    loadComponent: () => import('./pages/readings/readings.page'),
  },
  {
    path: 'statistiques',
    title: 'Statistiques',
    loadComponent: () => import('./pages/stats/stats.page'),
  },
  {
    path: 'previsions',
    title: 'Prévisions',
    loadComponent: () => import('./pages/forecast/forecast.page'),
  },
  { path: 'maison', title: 'Maison', loadComponent: () => import('./pages/house/house.page') },
  {
    path: 'reglages',
    title: 'Réglages',
    loadComponent: () => import('./pages/settings/settings.page'),
  },
  { path: 'aide', title: 'Aide', loadComponent: () => import('./pages/help/help.page') },
  { path: '**', redirectTo: '' },
];
