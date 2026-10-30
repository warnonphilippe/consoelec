/**
 * Vidéo de présentation de ConsoElec : `npm run video` → docs/video/consoelec-presentation.mp4.
 *
 * L'interface Angular (`ng serve`, lancé au besoin) tourne dans Google Chrome piloté par Playwright, avec un faux
 * `window.consoElec` (fake-api.js) : deux ans de données de démo et lectures « Wi-Fi » simulées du compteur P1 et de
 * l'onduleur, un jour d'été à midi (horloge de la page fixée par `page.clock`). Les images viennent du screencast de
 * Chrome (protocole CDP) ; chaque scène de scenes.mjs a sa voix off (`say`, macOS) ; ffmpeg assemble le tout en MP4.
 *
 * Variables : VIDEO_URL (défaut http://localhost:4200), VIDEO_TIME (heure locale simulée), VIDEO_VOICE (défaut Thomas),
 * VIDEO_KEEP=1 pour garder le dossier de travail.
 */
process.env.TZ = 'Europe/Brussels';

import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { scenes } from './scenes.mjs';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const URL_APP = process.env.VIDEO_URL ?? 'http://localhost:4200';
const NOW = new Date(process.env.VIDEO_TIME ?? '2026-06-17T13:20:00');
const VOICE = process.env.VIDEO_VOICE ?? 'Thomas';
const SIZE = { width: 1600, height: 1000 };
const OUT = join(root, 'docs/video/consoelec-presentation.mp4');
/** Silence après chaque voix avant la scène suivante (s). */
const GAP = 0.6;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`[video] ${msg}`);

async function duration(file) {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'csv=p=0',
    file,
  ]);
  return Number(stdout.trim());
}

async function voiceOver(work) {
  for (const [i, s] of scenes.entries()) {
    s.audio = join(work, `scene-${i}.aiff`);
    await run('say', ['-v', VOICE, '-r', '178', '-o', s.audio, s.say]);
    s.audioDuration = await duration(s.audio);
  }
  const total = scenes.reduce((a, s) => a + s.audioDuration + GAP, 0);
  log(`voix off : ${scenes.length} scènes, ${total.toFixed(0)} s`);
}

async function scenario(work) {
  const outfile = join(work, 'scenario.mjs');
  await build({
    entryPoints: [join(here, 'demo-scenario.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    logLevel: 'warning',
  });
  const { buildScenario } = await import(pathToFileURL(outfile).href);
  return buildScenario(NOW);
}

/** Démarre `ng serve` si l'interface ne répond pas encore ; renvoie le process lancé (ou `null`). */
async function ensureServer() {
  const up = () =>
    fetch(URL_APP).then(
      (r) => r.ok,
      () => false,
    );
  if (await up()) {
    return null;
  }
  const port = new URL(URL_APP).port || '4200';
  log(`lancement de ng serve sur le port ${port}…`);
  const child = spawn('npx', ['ng', 'serve', '--port', port], {
    cwd: root,
    stdio: 'ignore',
    detached: true,
  });
  for (let i = 0; i < 180; i++) {
    await sleep(1000);
    if (await up()) {
      return child;
    }
  }
  process.kill(-child.pid);
  throw new Error(`L'interface ne répond pas sur ${URL_APP}`);
}

/** Aides passées aux scènes. */
function helpers(page, sceneStart) {
  const video = (method, ...args) =>
    page.evaluate(([m, a]) => window.__video[m](...a), [method, args]);
  const box = async (selector) => {
    const loc = page.locator(selector).first();
    await loc.waitFor({ state: 'visible', timeout: 10_000 });
    return loc.boundingBox();
  };
  const moveTo = async (selector) => {
    const b = await box(selector);
    await page.mouse.move(b.x + Math.min(b.width / 2, 160), b.y + Math.min(b.height / 2, 60), {
      steps: 28,
    });
    await sleep(250);
  };
  const highlight = async (selector, pad) => {
    await video('highlight', selector, pad);
    await sleep(300);
  };
  const scrollTo = async (selector) => {
    await page
      .locator(selector)
      .first()
      .evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    await sleep(900);
  };
  return {
    page,
    video,
    moveTo,
    highlight,
    scrollTo,
    at: async (seconds) => {
      const wait = sceneStart() + seconds * 1000 - Date.now();
      if (wait > 0) await sleep(wait);
    },
    go: async (label) => {
      await video('highlight', null);
      const link = `a.nav-item:has-text("${label}")`;
      await moveTo(link);
      await page.mouse.down();
      await sleep(90);
      await page.mouse.up();
      await page.locator('.page h1', { hasText: label }).waitFor();
      // Le défilement de la page précédente est gardé par le conteneur.
      await page.locator('main.content').evaluate((el) => el.scrollTo({ top: 0 }));
      await sleep(1300);
    },
    clickText: async (selector, text) => {
      const loc = page.locator(selector, { hasText: text }).first();
      const b = await loc.boundingBox();
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 20 });
      await sleep(200);
      await loc.click();
      await sleep(900);
    },
    typeInto: async (selector, value) => {
      await moveTo(selector);
      await page.locator(selector).click({ clickCount: 3 });
      await page.keyboard.type(value, { delay: 75 });
      await sleep(250);
    },
    hoverChart: async (selector, from, to) => {
      const b = await box(`${selector} canvas`);
      const y = b.y + b.height * 0.55;
      await page.mouse.move(b.x + b.width * from, y, { steps: 18 });
      await page.mouse.move(b.x + b.width * to, y, { steps: 90 });
    },
  };
}

async function record(work, data) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({
    viewport: SIZE,
    deviceScaleFactor: 1,
    locale: 'fr-BE',
    timezoneId: 'Europe/Brussels',
    colorScheme: 'dark',
  });
  await context.addInitScript({ content: `window.__VIDEO_CONFIG__ = ${JSON.stringify(data)};` });
  await context.addInitScript({ path: join(here, 'fake-api.js') });
  await context.addInitScript({ path: join(here, 'overlay.js') });
  const page = await context.newPage();
  await page.clock.install({ time: NOW });
  page.on('pageerror', (e) => log(`erreur de la page : ${e.message}`));

  await page.goto(URL_APP);
  await page.locator('app-live-meter .live-value').first().waitFor({ timeout: 30_000 });
  await page.locator('app-live-production .live-value').first().waitFor({ timeout: 30_000 });
  await page.evaluate(() =>
    window.__video.card('ConsoElec', 'Électricité et solaire, à la maison'),
  );
  await sleep(1500);
  await page.mouse.move(SIZE.width / 2, SIZE.height / 2);

  const frames = await screencast(page, work);
  await sleep(500);
  const t0 = Date.now();
  let current = t0;
  const ctx = helpers(page, () => current);
  for (const s of scenes) {
    current = Date.now();
    s.start = (current - t0) / 1000;
    log(`scène ${s.id} (${s.audioDuration.toFixed(1)} s)`);
    await ctx.video('caption', s.caption);
    await Promise.all([s.run(ctx), sleep((s.audioDuration + GAP) * 1000)]);
  }
  await sleep((scenes.at(-1).tail ?? 0) * 1000);
  const end = (Date.now() - t0) / 1000;
  const list = await frames.stop(t0, end);
  await browser.close();
  return { list, end };
}

/**
 * Enregistre les images du screencast de Chrome dans `work` au fil de l'eau. Chrome n'envoie une image que quand
 * l'écran change : `stop` écrit la liste ffconcat où chaque image dure jusqu'à la suivante, à partir de `t0`.
 */
async function screencast(page, work) {
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  const writes = [];
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    const file = join(work, `f${String(frames.length).padStart(6, '0')}.jpg`);
    frames.push({ file, t: metadata.timestamp * 1000 });
    writes.push(writeFile(file, Buffer.from(data, 'base64')));
    void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 95,
    maxWidth: SIZE.width,
    maxHeight: SIZE.height,
  });
  return {
    async stop(t0, end) {
      await cdp.send('Page.stopScreencast');
      await Promise.all(writes);
      const shown = frames.filter((f, i) => i === frames.length - 1 || frames[i + 1].t > t0);
      const lines = ['ffconcat version 1.0'];
      shown.forEach((f, i) => {
        const from = Math.max(f.t, t0);
        const to = i + 1 < shown.length ? shown[i + 1].t : t0 + end * 1000;
        lines.push(
          `file '${f.file}'`,
          `duration ${Math.max(0.001, (to - from) / 1000).toFixed(4)}`,
        );
      });
      lines.push(`file '${shown.at(-1).file}'`);
      const list = join(work, 'frames.txt');
      await writeFile(list, lines.join('\n') + '\n');
      log(`${shown.length} images capturées`);
      return list;
    },
  };
}

async function assemble({ list, end }) {
  await mkdir(dirname(OUT), { recursive: true });
  const inputs = ['-f', 'concat', '-safe', '0', '-i', list];
  const filters = [];
  scenes.forEach((s, i) => {
    inputs.push('-i', s.audio);
    const ms = Math.round(s.start * 1000);
    filters.push(`[${i + 1}:a]aresample=48000,adelay=${ms}|${ms}[a${i}]`);
  });
  filters.push(
    `${scenes.map((_, i) => `[a${i}]`).join('')}amix=inputs=${scenes.length}:normalize=0:duration=longest[voice]`,
  );
  await run(
    'ffmpeg',
    [
      '-y',
      ...inputs,
      '-filter_complex',
      filters.join(';'),
      '-map',
      '0:v',
      '-map',
      '[voice]',
      '-t',
      end.toFixed(3),
      '-vf',
      'fps=30,format=yuv420p',
      '-c:v',
      'libx264',
      '-preset',
      'slow',
      '-crf',
      '18',
      '-c:a',
      'aac',
      '-b:a',
      '160k',
      '-ac',
      '2',
      '-movflags',
      '+faststart',
      OUT,
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  log(`vidéo : ${OUT} (${end.toFixed(0)} s)`);
}

const work = await mkdtemp(join(tmpdir(), 'consoelec-video-'));
let server = null;
try {
  const data = await scenario(work);
  await voiceOver(work);
  server = await ensureServer();
  const recorded = await record(work, data);
  await assemble(recorded);
} finally {
  if (server) process.kill(-server.pid);
  if (process.env.VIDEO_KEEP) log(`dossier de travail : ${work}`);
  else await rm(work, { recursive: true, force: true });
}
