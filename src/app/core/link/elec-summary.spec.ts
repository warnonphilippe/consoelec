import { analyze } from '../calc/analysis';
import { buildDemoData } from '../calc/demo-data';
import { dateToDayNumber } from '../calc/time';
import { emptyData } from '../models/app-data.model';
import { normalizeData } from '../models/normalize';
import { buildElecSummary } from './elec-summary';
import {
  asElecSummary,
  asMazoutSummary,
  summaryAgeDays,
  summaryFingerprint,
} from './household-summary';

const NOW = new Date('2025-06-15T12:00:00');
const DAY = dateToDayNumber(NOW);

describe('résumé ConsoElec partagé', () => {
  it('résume l’estimation annuelle, les 12 derniers mois et la maison', () => {
    const data = buildDemoData(NOW);
    const analysis = analyze(data, DAY);
    const summary = buildElecSummary(data, analysis, null, NOW)!;
    expect(summary.application).toBe('consoelec');
    expect(summary.genereLe).toBe(NOW.toISOString());
    expect(summary.estimationAnnuelle.source).toBe('prevision');
    expect(summary.estimationAnnuelle.soutirageKwh).toBe(
      summary.estimationAnnuelle.soutirageHpKwh + summary.estimationAnnuelle.soutirageHcKwh,
    );
    expect(summary.estimationAnnuelle.soutirageKwh).toBeGreaterThan(0);
    expect(summary.derniers12Mois?.joursCouverts).toBeGreaterThan(0);
    expect(summary.mensuel.length).toBeLessThanOrEqual(24);
    expect(summary.maison.chaudiereMazout).toBe(data.house.heating.oilBoiler);
    expect(summary.anneeFacturation).toBeNull();
    expect(asElecSummary(JSON.parse(JSON.stringify(summary)))).not.toBeNull();
    expect(asMazoutSummary(summary)).toBeNull();
  });

  it('publie l’année de facturation quand elle est connue', () => {
    const data = buildDemoData(NOW);
    const billing = { start: DAY - 100, end: DAY + 265, hp: 812.4, hc: -40.2, cost: { total: 276.2 } };
    const summary = buildElecSummary(data, analyze(data, DAY), billing, NOW)!;
    expect(summary.anneeFacturation).toEqual({
      du: '2025-03-07',
      au: '2026-03-06',
      soldeHpKwh: 812,
      soldeHcKwh: -40,
      coutEstime: 276,
    });
  });

  it('ne publie rien sans relevé', () => {
    const data = emptyData();
    expect(buildElecSummary(data, analyze(data, DAY), null, NOW)).toBeNull();
  });

  it('compare deux résumés sans tenir compte de la date de publication', () => {
    const data = buildDemoData(NOW);
    const analysis = analyze(data, DAY);
    const a = buildElecSummary(data, analysis, null, NOW)!;
    const b = buildElecSummary(data, analysis, null, new Date('2025-06-16T08:00:00'))!;
    expect(summaryFingerprint(a)).toBe(summaryFingerprint(b));
    expect(summaryAgeDays(a, Date.parse('2025-06-20T13:00:00'))).toBe(5);
  });

  it('conserve le drapeau des données de démonstration', () => {
    const demo = normalizeData({ ...buildDemoData(NOW), demo: true });
    expect(demo.demo).toBe(true);
    expect(normalizeData(buildDemoData(NOW)).demo).toBeUndefined();
  });
});
