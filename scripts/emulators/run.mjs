// Compile les émulateurs (TypeScript) avec esbuild dans un dossier temporaire, puis les lance.
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outfile = join(mkdtempSync(join(tmpdir(), 'consoelec-emulate-')), 'cli.mjs');
await build({
  entryPoints: [join(here, 'cli.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile,
  logLevel: 'warning',
});
await import(pathToFileURL(outfile).href);
