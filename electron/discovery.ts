import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const DNS_SD = '/usr/bin/dns-sd';
const BROWSE_MS = 3000;
const RESOLVE_MS = 2000;

export { p1Identity, relocatedHost, smaSerial } from './shared/device-names';

/** Lignes « Add » d'une recherche Bonjour : nom d'instance annoncé (texte après le type de service). */
function addedInstances(output: string, serviceType: string): string[] {
  const instances = new Set<string>();
  for (const line of output.split('\n')) {
    if (!/\bAdd\b/.test(line)) {
      continue;
    }
    const at = line.indexOf(`${serviceType}.`);
    const name = at >= 0 ? line.slice(at + serviceType.length + 1).trim() : '';
    if (name) {
      instances.add(name);
    }
  }
  return [...instances];
}

/** Instances Bonjour des onduleurs SMA (« Website for SMA-Inverter: SMA<numéro de série>[-N] »). */
export function parseSmaInstances(output: string): string[] {
  return addedInstances(output, '_http._tcp').filter((name) =>
    /SMA-?Inverter:\s*SMA\d{6,}/i.test(name),
  );
}

/**
 * Extrait les onduleurs SMA d'une recherche Bonjour (`dns-sd -B _http._tcp`). Renvoie les noms réseau
 * `SMA<numéro>[-N].local` déduits des noms annoncés, suffixe de conflit compris.
 */
export function parseSmaHosts(output: string): string[] {
  const hosts = new Set<string>();
  for (const instance of parseSmaInstances(output)) {
    const match = /SMA-?Inverter:\s*(SMA\d{6,}(?:-\d+)?)/i.exec(instance);
    if (match) {
      hosts.add(`${match[1]!.toUpperCase()}.local`);
    }
  }
  return [...hosts];
}

/**
 * Extrait les lecteurs P1 HomeWizard d'une recherche Bonjour (`dns-sd -B _hwenergy._tcp`) : ils s'annoncent sous
 * le nom `p1meter-<6 caractères>`, suivi de `-N` en cas de conflit. Renvoie les noms réseau `p1meter-XXXXXX[-N].local`.
 */
export function parseP1Hosts(output: string): string[] {
  const hosts = new Set<string>();
  for (const line of output.split('\n')) {
    if (!/\bAdd\b/.test(line)) {
      continue;
    }
    const match = /\b(p1meter-[0-9A-Za-z]{6}(?:-\d+)?)\b/i.exec(line);
    if (match) {
      hosts.add(`${match[1]!.toLowerCase()}.local`);
    }
  }
  return [...hosts];
}

/** Nom réseau donné par une résolution Bonjour (`dns-sd -L`) : « … can be reached at HOTE.local.:443 ». */
export function parseResolvedHost(output: string): string | null {
  const match = /can be reached at (\S+?)\.?:\d+/.exec(output);
  return match ? match[1]! : null;
}

/** Lance `dns-sd` quelques instants et renvoie sa sortie (macOS seulement). */
function runDnsSd(args: string[], durationMs: number): Promise<string> {
  if (process.platform !== 'darwin' || !existsSync(DNS_SD)) {
    return Promise.resolve('');
  }
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(DNS_SD, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve(''));
    setTimeout(() => {
      child.kill();
      resolve(out);
    }, durationMs);
  });
}

/** Recherche Bonjour de quelques secondes. */
const browse = (serviceType: string): Promise<string> =>
  runDnsSd(['-B', serviceType, 'local.'], BROWSE_MS);

/**
 * Cherche les onduleurs SMA sur le réseau local (macOS : Bonjour via dns-sd). Chaque annonce est résolue pour
 * obtenir le vrai nom réseau ; à défaut, le nom est déduit de l'annonce.
 */
export async function discoverSmaInverters(): Promise<string[]> {
  const output = await browse('_http._tcp');
  const instances = parseSmaInstances(output);
  const resolved = await Promise.all(
    instances.map(async (instance) =>
      parseResolvedHost(await runDnsSd(['-L', instance, '_http._tcp', 'local.'], RESOLVE_MS)),
    ),
  );
  const hosts = new Set<string>();
  instances.forEach((instance, i) => {
    const host = resolved[i] ?? parseSmaHosts(`Add _http._tcp. ${instance}`)[0];
    if (host) {
      hosts.add(host);
    }
  });
  return [...hosts];
}

/** Cherche les lecteurs P1 HomeWizard sur le réseau local (macOS : Bonjour via dns-sd). */
export async function discoverP1Meters(): Promise<string[]> {
  return parseP1Hosts(await browse('_hwenergy._tcp'));
}

/**
 * Cherche les passerelles Enphase IQ Gateway (Bonjour `_enphase-envoy._tcp`) ; renvoie leurs noms réseau
 * (`envoy.local` en général).
 */
export function discoverEnphaseGateways(): Promise<string[]> {
  return discoverBonjourHosts('_enphase-envoy._tcp');
}

/** Noms réseau des appareils annonçant un service Bonjour (chaque annonce est résolue). */
export async function discoverBonjourHosts(serviceType: string): Promise<string[]> {
  const output = await browse(serviceType);
  const instances = addedInstances(output, serviceType);
  const resolved = await Promise.all(
    instances.map(async (instance) =>
      parseResolvedHost(await runDnsSd(['-L', instance, serviceType, 'local.'], RESOLVE_MS)),
    ),
  );
  return [...new Set(resolved.filter((h): h is string => h !== null))];
}
