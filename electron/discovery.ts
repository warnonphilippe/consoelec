import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const DNS_SD = '/usr/bin/dns-sd';
const BROWSE_MS = 3000;

/**
 * Extrait les onduleurs SMA d'une recherche Bonjour (`dns-sd -B _http._tcp`) : ils s'annoncent comme
 * « Website for SMA-Inverter: SMA<numéro de série> ». Renvoie les noms réseau `SMA<numéro>.local`.
 */
export function parseSmaHosts(output: string): string[] {
  const hosts = new Set<string>();
  for (const line of output.split('\n')) {
    if (!/\bAdd\b/.test(line)) {
      continue;
    }
    const match = /SMA-?Inverter:\s*(SMA\d{6,})/i.exec(line) ?? /\b(SMA\d{6,})\b/.exec(line);
    if (match) {
      hosts.add(`${match[1]!.toUpperCase()}.local`);
    }
  }
  return [...hosts];
}

/**
 * Extrait les lecteurs P1 HomeWizard d'une recherche Bonjour (`dns-sd -B _hwenergy._tcp`) : ils s'annoncent sous
 * le nom `p1meter-<6 caractères>`. Renvoie les noms réseau `p1meter-XXXXXX.local`.
 */
export function parseP1Hosts(output: string): string[] {
  const hosts = new Set<string>();
  for (const line of output.split('\n')) {
    if (!/\bAdd\b/.test(line)) {
      continue;
    }
    const match = /\b(p1meter-[0-9A-Za-z]{6})\b/i.exec(line);
    if (match) {
      hosts.add(`${match[1]!.toLowerCase()}.local`);
    }
  }
  return [...hosts];
}

/** Lance une recherche Bonjour de quelques secondes et renvoie la sortie de `dns-sd` (macOS seulement). */
function browse(serviceType: string): Promise<string> {
  if (process.platform !== 'darwin' || !existsSync(DNS_SD)) {
    return Promise.resolve('');
  }
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(DNS_SD, ['-B', serviceType, 'local.'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve(''));
    setTimeout(() => {
      child.kill();
      resolve(out);
    }, BROWSE_MS);
  });
}

/** Cherche les onduleurs SMA sur le réseau local (macOS : Bonjour via dns-sd). */
export async function discoverSmaInverters(): Promise<string[]> {
  return parseSmaHosts(await browse('_http._tcp'));
}

/** Cherche les lecteurs P1 HomeWizard sur le réseau local (macOS : Bonjour via dns-sd). */
export async function discoverP1Meters(): Promise<string[]> {
  return parseP1Hosts(await browse('_hwenergy._tcp'));
}
