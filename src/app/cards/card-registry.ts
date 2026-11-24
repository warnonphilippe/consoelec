import type { Type } from '@angular/core';
import type { CardId } from '../core/models/dashboard';
import { LiveMeterComponent } from '../shared/live-meter/live-meter.component';
import { LiveProductionComponent } from '../shared/live-production/live-production.component';
import { BalanceCardComponent } from '../shared/balance-card/balance-card.component';
import { BillingCostCard, BillingPeriodCard, BillingScheduleCard } from './billing/billing-cards';
import {
  ForecastControlsCard,
  ForecastIndexChartCard,
  ForecastKpiCard,
  ForecastMonthlyChartCard,
  ForecastProfilesCard,
  ForecastReliabilityCard,
  ForecastYearEndsCard,
} from './forecast/forecast-cards';
import {
  MeterBalanceCard,
  MeterIndexChartCard,
  MeterRecentPowerCard,
  MeterRegisterCard,
  MeterSplitCard,
  MeterTodayEnergyCard,
  MeterTotalCard,
} from './meters/meters-cards';
import { MazoutLinkCard } from './link/link-cards';
import { MeterProfileDayCard, MeterProfileDaysCard } from './meters/profile-cards';
import { ProductionDayCard, ProductionHistoryCard, ProductionKpiCard } from './production/production-cards';
import {
  StatsMonthlyTableCard,
  StatsRegistersCard,
  StatsSeasonCard,
  StatsYearsChartCard,
} from './stats/stats-cards';

export interface CardDef {
  readonly component: Type<unknown>;
  /** Entrées du composant (registre, saison…) quand un même composant sert à plusieurs cadres. */
  readonly inputs?: Record<string, unknown>;
  /** Le cadre prend toute la largeur du tableau de bord (graphiques, tableaux, cadres « en direct »). */
  readonly wide?: boolean;
}

/** Composant de chaque cadre que l'on peut placer sur le tableau de bord. */
export const CARDS: Record<CardId, CardDef> = {
  'live-meter': { component: LiveMeterComponent, wide: true },
  'live-production': { component: LiveProductionComponent, wide: true },
  'billing-hp': { component: BillingPeriodCard, inputs: { key: 'hp' } },
  'billing-hc': { component: BillingPeriodCard, inputs: { key: 'hc' } },
  'billing-cost': { component: BillingCostCard },
  'billing-schedule': { component: BillingScheduleCard },
  'meters-total-import': { component: MeterTotalCard, inputs: { kind: 'import' } },
  'meters-total-export': { component: MeterTotalCard, inputs: { kind: 'export' } },
  'meters-register-importPeak': { component: MeterRegisterCard, inputs: { register: 'importPeak' } },
  'meters-register-importOff': { component: MeterRegisterCard, inputs: { register: 'importOff' } },
  'meters-register-exportPeak': { component: MeterRegisterCard, inputs: { register: 'exportPeak' } },
  'meters-register-exportOff': { component: MeterRegisterCard, inputs: { register: 'exportOff' } },
  'meters-recent-power': { component: MeterRecentPowerCard },
  'meters-today-energy': { component: MeterTodayEnergyCard },
  'meters-index-chart': { component: MeterIndexChartCard, wide: true },
  'meters-profile-day': { component: MeterProfileDayCard, wide: true },
  'meters-profile-days': { component: MeterProfileDaysCard, wide: true },
  'meters-balance': { component: BalanceCardComponent, wide: true },
  'meters-balance-to-date': { component: MeterBalanceCard, inputs: { period: 'to-date' } },
  'meters-balance-current-year': { component: MeterBalanceCard, inputs: { period: 'current-year' } },
  'meters-balance-next-year': { component: MeterBalanceCard, inputs: { period: 'next-year' } },
  'meters-split-import': { component: MeterSplitCard, inputs: { kind: 'import' } },
  'meters-split-export': { component: MeterSplitCard, inputs: { kind: 'export' } },
  'production-day': { component: ProductionDayCard, wide: true },
  'production-7d': { component: ProductionKpiCard, inputs: { kind: '7d' } },
  'production-30d': { component: ProductionKpiCard, inputs: { kind: '30d' } },
  'production-year': { component: ProductionKpiCard, inputs: { kind: 'year' } },
  'production-best-day': { component: ProductionKpiCard, inputs: { kind: 'best-day' } },
  'production-yield': { component: ProductionKpiCard, inputs: { kind: 'yield' } },
  'production-history': { component: ProductionHistoryCard, wide: true },
  'stats-season-winter': { component: StatsSeasonCard, inputs: { season: 'winter' } },
  'stats-season-spring': { component: StatsSeasonCard, inputs: { season: 'spring' } },
  'stats-season-summer': { component: StatsSeasonCard, inputs: { season: 'summer' } },
  'stats-season-autumn': { component: StatsSeasonCard, inputs: { season: 'autumn' } },
  'stats-years-chart': { component: StatsYearsChartCard, wide: true },
  'stats-monthly-table': { component: StatsMonthlyTableCard, wide: true },
  'stats-registers': { component: StatsRegistersCard, wide: true },
  'forecast-controls': { component: ForecastControlsCard, wide: true },
  'forecast-import': { component: ForecastKpiCard, inputs: { kind: 'import' } },
  'forecast-export': { component: ForecastKpiCard, inputs: { kind: 'export' } },
  'forecast-net': { component: ForecastKpiCard, inputs: { kind: 'net' } },
  'forecast-ev': { component: ForecastKpiCard, inputs: { kind: 'ev' } },
  'forecast-monthly-chart': { component: ForecastMonthlyChartCard, wide: true },
  'forecast-index-chart': { component: ForecastIndexChartCard, wide: true },
  'forecast-reliability': { component: ForecastReliabilityCard, wide: true },
  'forecast-profiles': { component: ForecastProfilesCard, wide: true },
  'forecast-year-ends': { component: ForecastYearEndsCard, wide: true },
  'link-mazout': { component: MazoutLinkCard },
};
