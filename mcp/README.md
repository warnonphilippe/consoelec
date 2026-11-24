# Serveur MCP « conso-maison »

ConsoElec et ConsoMazout publient chacune, à chaque changement de leurs données, un **résumé JSON** de leurs
estimations dans un dossier commun :

```
~/.config/conso-maison/consoelec.json     ← ConsoElec (électricité)
~/.config/conso-maison/consomazout.json   ← ConsoMazout (mazout)
```

Chaque application lit le résumé de l'autre : son assistant IA le reçoit dans son contexte, et un cadre le résume
(page Prévisions de ConsoElec, tableau de bord de ConsoMazout). Ce serveur MCP, en lecture seule, expose les mêmes
résumés à Claude Desktop ou Claude Code.

- Format : `src/app/core/link/household-summary.ts` (fichier recopié à l'identique dans les deux applications).
- Les applications de développement (`npm run dev`) publient dans `~/.config/conso-maison-dev`.
- Les données de démonstration ne sont jamais publiées.
- Dossier différent : variable d'environnement `CONSO_MAISON_DIR` (chemin absolu), pour les applications comme pour
  ce serveur.

## Outils

| Outil                | Contenu                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `resume_maison`      | Synthèse électricité + mazout (énergie totale, part du mazout, coûts), puis les deux résumés |
| `resume_consoelec`   | Résumé complet de ConsoElec                                                                 |
| `resume_consomazout` | Résumé complet de ConsoMazout                                                               |

Ressources : `conso-maison://consoelec` et `conso-maison://consomazout`. Chaque réponse donne l'âge du résumé en
jours et explique pourquoi un résumé manque.

## Installation

```bash
cd ~/sources/consoelec/mcp && npm install
```

Claude Code :

```bash
claude mcp add --scope user conso-maison -- node ~/sources/consoelec/mcp/server.mjs
```

Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`) :

```json
{
  "mcpServers": {
    "conso-maison": {
      "command": "node",
      "args": ["/Users/<vous>/sources/consoelec/mcp/server.mjs"]
    }
  }
}
```

## Tests

```bash
npm test
```

Essai manuel avec l'inspecteur MCP :

```bash
npx @modelcontextprotocol/inspector node server.mjs
```
