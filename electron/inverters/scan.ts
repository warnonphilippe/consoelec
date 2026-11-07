import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';
import {
  effectivePort,
  inverterBrand,
  type InverterBrand,
  type InverterBrandInfo,
} from '../shared/inverter-brands';
import type { InverterFound } from '../shared/ipc-contract';
import { LocalInverterClient } from './local-client';

/**
 * Recherche des onduleurs sans Bonjour sur le réseau local :
 * - les clés Wi-Fi Solarman et GoodWe répondent à une diffusion UDP (« WIFIKIT-214028-READ » sur le port 48899) par
 *   « adresse IP,adresse MAC,numéro de série » ;
 * - les autres sont cherchés par un balayage du réseau local (/24) sur leur port, puis confirmés par une vraie lecture.
 */

const WIFIKIT_PORT = 48899;
const WIFIKIT_REQUEST = 'WIFIKIT-214028-READ';
const CONNECT_TIMEOUT_MS = 500;
const SCAN_CONCURRENCY = 64;

export interface LocalNetwork {
  readonly address: string;
  readonly broadcast: string;
  /** Adresses de la plage /24 de cette interface (la sienne comprise : un émulateur peut tourner sur ce Mac). */
  readonly hosts: readonly string[];
}

const toInt = (ip: string): number => ip.split('.').reduce((n, p) => (n << 8) + Number(p), 0) >>> 0;
const toIp = (n: number): string => [24, 16, 8, 0].map((s) => (n >>> s) & 0xff).join('.');

/** Réseaux IPv4 locaux (Wi-Fi, Ethernet), réduits à la plage /24 de chaque interface. */
export function localNetworks(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): LocalNetwork[] {
  const networks: LocalNetwork[] = [];
  for (const infos of Object.values(interfaces)) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || info.internal || info.address.startsWith('169.254.')) {
        continue;
      }
      const address = toInt(info.address);
      const mask = toInt(info.netmask);
      const base = (address & 0xffffff00) >>> 0;
      const hosts: string[] = [];
      for (let i = 1; i < 255; i++) {
        hosts.push(toIp(base + i));
      }
      networks.push({ address: info.address, broadcast: toIp((address | (~mask >>> 0)) >>> 0), hosts });
    }
  }
  return networks;
}

/** Réponse d'une clé Wi-Fi à la diffusion (« ip,mac,numéro ») ; `null` si elle est illisible. */
export function parseWifikitReply(text: string): InverterFound | null {
  const [ip, , serial] = text.trim().split(',');
  if (!ip || net.isIPv4(ip) === false) {
    return null;
  }
  return /^\d{1,10}$/.test(serial ?? '') ? { host: ip, loggerSerial: serial! } : { host: ip };
}

/** Diffuse la requête « WIFIKIT » et rassemble les réponses des clés Wi-Fi (Solarman, GoodWe). */
export function broadcastWifikit(
  targets: readonly string[],
  port = WIFIKIT_PORT,
  durationMs = 2000,
): Promise<InverterFound[]> {
  return new Promise((resolve) => {
    const found = new Map<string, InverterFound>();
    const socket = dgram.createSocket('udp4');
    const finish = (): void => {
      socket.close();
      resolve([...found.values()]);
    };
    socket.on('error', () => finish());
    socket.on('message', (msg) => {
      const reply = parseWifikitReply(msg.toString('utf8'));
      if (reply !== null) {
        found.set(reply.host, reply);
      }
    });
    socket.bind(0, () => {
      socket.setBroadcast(true);
      for (const target of targets) {
        socket.send(WIFIKIT_REQUEST, port, target, () => undefined);
      }
      setTimeout(finish, durationMs);
    });
  });
}

/** Le port TCP est-il ouvert ? */
function portOpen(host: string, port: number, timeoutMs = CONNECT_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (open: boolean): void => {
      socket.removeAllListeners();
      socket.on('error', () => undefined);
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Adresses dont le port est ouvert, testées par lots. */
export async function scanPort(hosts: readonly string[], port: number): Promise<string[]> {
  const open: string[] = [];
  for (let i = 0; i < hosts.length; i += SCAN_CONCURRENCY) {
    const batch = hosts.slice(i, i + SCAN_CONCURRENCY);
    const results = await Promise.all(batch.map((h) => portOpen(h, port)));
    batch.forEach((h, j) => {
      if (results[j]) {
        open.push(h);
      }
    });
  }
  return open;
}

/** L'appareil se lit-il comme un onduleur de cette marque ? */
async function readsAs(brand: InverterBrandInfo, candidate: InverterFound, port: number | null): Promise<boolean> {
  const client = new LocalInverterClient(() => null, 2000);
  client.configure({
    enabled: true,
    brand: brand.id,
    host: candidate.host,
    certFingerprint: null,
    port,
    unitId: null,
    loggerSerial: candidate.loggerSerial ?? null,
  });
  try {
    return (await client.read()).error === null;
  } finally {
    await client.close();
  }
}

export interface ScanOptions {
  /** Adresses à essayer (par défaut : réseau local /24). */
  readonly hosts?: readonly string[];
  /** Adresses de diffusion (par défaut : celles des interfaces). */
  readonly broadcasts?: readonly string[];
  /** Port de l'onduleur (par défaut : celui de la marque). */
  readonly port?: number | null;
  /** Port de la diffusion WIFIKIT (tests). */
  readonly wifikitPort?: number;
}

/** Cherche les onduleurs d'une marque lue par le client local (hors SMA et Enphase, trouvés par Bonjour). */
export async function scanInverters(id: InverterBrand, options: ScanOptions = {}): Promise<InverterFound[]> {
  const brand = inverterBrand(id);
  const networks = options.hosts === undefined || options.broadcasts === undefined ? localNetworks() : [];
  const hosts = options.hosts ?? networks.flatMap((n) => n.hosts);
  const broadcasts = options.broadcasts ?? networks.map((n) => n.broadcast);
  const port = options.port ?? null;
  const candidates: InverterFound[] = [];
  if (brand.transport === 'goodwe-udp' || brand.loggerSerial) {
    candidates.push(...(await broadcastWifikit(broadcasts, options.wifikitPort)));
  }
  if (brand.transport !== 'goodwe-udp') {
    // Sans clé Solarman (ou en plus), l'appareil répond sur son port TCP.
    const tcpPort = port ?? effectivePort(brand, null, null);
    const known = new Set(candidates.map((c) => c.host));
    for (const host of await scanPort(hosts, tcpPort)) {
      if (!known.has(host)) {
        candidates.push({ host });
      }
    }
  }
  const confirmed = await Promise.all(candidates.map((c) => readsAs(brand, c, port)));
  return candidates.filter((_, i) => confirmed[i]);
}
