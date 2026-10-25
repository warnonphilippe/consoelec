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

/** Cherche les onduleurs SMA sur le réseau local (macOS : Bonjour via dns-sd). */
export function discoverSmaInverters(): Promise<string[]> {
  if (process.platform !== 'darwin' || !existsSync(DNS_SD)) {
    return Promise.resolve([]);
  }
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(DNS_SD, ['-B', '_http._tcp', 'local.'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve([]));
    setTimeout(() => {
      child.kill();
      resolve(parseSmaHosts(out));
    }, BROWSE_MS);
  });
}
