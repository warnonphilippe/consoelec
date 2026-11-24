import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { householdOverview, readSummary, resolveLinkDir } from './lib.mjs';

const NOW = Date.parse('2026-11-24T12:00:00Z');

const elec = {
  schema: 1,
  application: 'consoelec',
  genereLe: '2026-11-20T08:00:00.000Z',
  estimationAnnuelle: { soutirageKwh: 3100, injectionKwh: 4200 },
  derniers12Mois: { joursCouvertsSolaire: 364, consommationMaisonKwh: 5000, productionPvKwh: 6100 },
  anneeFacturation: { coutEstime: 420 },
};
const mazout = {
  schema: 1,
  application: 'consomazout',
  genereLe: '2026-08-01T08:00:00.000Z',
  estimationAnnuelle: { litres: 2000, equivalentKwh: 20000, coutEstime: 1900 },
  cuve: { commanderAvantLe: '2026-12-10' },
};

describe('conso-maison MCP', () => {
  let dir;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'conso-maison-mcp-'));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('résout le dossier d’échange', () => {
    assert.equal(resolveLinkDir({}, '/Users/t'), '/Users/t/.config/conso-maison');
    assert.equal(resolveLinkDir({ CONSO_MAISON_DIR: '~/x' }, '/Users/t'), '/Users/t/x');
    assert.equal(resolveLinkDir({ CONSO_MAISON_DIR: 'relatif' }, '/Users/t'), '/Users/t/.config/conso-maison');
  });

  it('signale un résumé absent, invalide ou d’un autre format', async () => {
    assert.equal((await readSummary(dir, 'consoelec', NOW)).status, 'absent');
    await writeFile(join(dir, 'consoelec.json'), '{ cassé');
    assert.equal((await readSummary(dir, 'consoelec', NOW)).status, 'invalide');
    await writeFile(join(dir, 'consoelec.json'), JSON.stringify({ ...elec, schema: 2 }));
    assert.equal((await readSummary(dir, 'consoelec', NOW)).status, 'incompatible');
    await writeFile(join(dir, 'consoelec.json'), JSON.stringify({ ...elec, application: 'consomazout' }));
    assert.equal((await readSummary(dir, 'consoelec', NOW)).status, 'invalide');
  });

  it('assemble la vue d’ensemble avec l’âge des résumés', async () => {
    await writeFile(join(dir, 'consoelec.json'), JSON.stringify(elec));
    await writeFile(join(dir, 'consomazout.json'), JSON.stringify(mazout));
    const e = await readSummary(dir, 'consoelec', NOW);
    const m = await readSummary(dir, 'consomazout', NOW);
    assert.equal(e.ageJours, 4);
    const overview = householdOverview(e, m);
    assert.equal(overview.synthese.energieTotaleKwhParAn, 25000);
    assert.equal(overview.synthese.baseElectricite, 'consommation de la maison');
    assert.equal(overview.synthese.partMazoutPct, 80);
    assert.equal(overview.synthese.coutTotalParAn, 2320);
    assert.equal(overview.consomazout.ageJours, 115);
    assert.match(overview.remarques.join(' '), /ConsoMazout date de 115 jours/);
  });

  it('se rabat sur le soutirage prévu quand la consommation de la maison couvre moins d’un an', () => {
    const partial = { ...elec, derniers12Mois: { joursCouvertsSolaire: 208, consommationMaisonKwh: 2550 } };
    const overview = householdOverview(
      { app: 'consoelec', status: 'ok', ageJours: 0, summary: partial },
      { app: 'consomazout', status: 'ok', ageJours: 0, summary: mazout },
    );
    assert.equal(overview.synthese.baseElectricite, 'soutirage');
    assert.equal(overview.synthese.energieTotaleKwhParAn, 23100);
  });

  it('reste utile quand une application n’a rien publié', () => {
    const overview = householdOverview({ app: 'consoelec', status: 'absent' }, {
      app: 'consomazout',
      status: 'ok',
      ageJours: 1,
      summary: mazout,
    });
    assert.equal(overview.synthese.electricite, null);
    assert.equal(overview.synthese.energieTotaleKwhParAn, null);
    assert.equal(overview.synthese.mazout.litresParAn, 2000);
    assert.equal(overview.consoelec.status, 'absent');
    assert.match(overview.remarques[0], /ConsoElec n'a encore rien publié/);
  });
});
