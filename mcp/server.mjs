#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { entryPayload, householdOverview, readSummary, resolveLinkDir } from './lib.mjs';

/**
 * Serveur MCP « conso-maison » (stdio, lecture seule) : expose les résumés que ConsoElec et ConsoMazout publient dans
 * `~/.config/conso-maison` (ou `CONSO_MAISON_DIR`), pour que Claude Desktop ou Claude Code raisonnent sur l'électricité
 * et le mazout de la maison ensemble. Il ne lit rien d'autre et n'écrit rien.
 */
const dir = resolveLinkDir();

const server = new McpServer({ name: 'conso-maison', version: '1.0.0' });

const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

server.registerTool(
  'resume_maison',
  {
    title: 'Énergie de la maison (électricité + mazout)',
    description:
      "Vue d'ensemble annuelle de l'énergie de la maison : électricité (ConsoElec : soutirage et injection prévus sur 12 mois, " +
      'consommation de la maison et production solaire des 12 derniers mois, coût de l’année de facturation) et mazout ' +
      '(ConsoMazout : litres par an, équivalent kWh, coût), part du mazout dans le total, puis les deux résumés complets. ' +
      'Chaque résumé indique son âge en jours.',
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => {
    const [elec, mazout] = await Promise.all([readSummary(dir, 'consoelec'), readSummary(dir, 'consomazout')]);
    return json(householdOverview(elec, mazout));
  },
);

server.registerTool(
  'resume_consoelec',
  {
    title: 'Électricité (ConsoElec)',
    description:
      'Résumé publié par ConsoElec : prévision des 12 prochains mois côté compteur (soutirage / injection, heures pleines ' +
      'et creuses), 12 derniers mois mesurés avec la production solaire, historique annuel et mensuel (24 mois), année de ' +
      'facturation, prix du kWh et description de la maison.',
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => json(entryPayload(await readSummary(dir, 'consoelec'))),
);

server.registerTool(
  'resume_consomazout',
  {
    title: 'Mazout (ConsoMazout)',
    description:
      'Résumé publié par ConsoMazout : consommation annuelle estimée (litres, équivalent kWh, coût), 12 derniers mois, ' +
      'historique annuel et mensuel (24 mois), prévision par mois, part eau chaude, contenu de la cuve et date limite de ' +
      'commande, prix au litre.',
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => json(entryPayload(await readSummary(dir, 'consomazout'))),
);

for (const app of ['consoelec', 'consomazout']) {
  server.registerResource(
    app,
    `conso-maison://${app}`,
    {
      title: app === 'consoelec' ? 'Résumé ConsoElec' : 'Résumé ConsoMazout',
      description: `Dernier résumé publié par ${app === 'consoelec' ? 'ConsoElec' : 'ConsoMazout'}.`,
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(entryPayload(await readSummary(dir, app)), null, 2),
        },
      ],
    }),
  );
}

await server.connect(new StdioServerTransport());
