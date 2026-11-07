import os from 'node:os';
import { inverterBrand } from '../../electron/shared/inverter-brands';
import {
  EMULATOR_IDS,
  EMULATORS,
  startEmulator,
  type EmulatorId,
  type StartedEmulator,
} from './catalog';
import { p1Reader } from '../../electron/shared/p1-readers';
import {
  P1_EMULATOR_IDS,
  P1_EMULATORS,
  startP1Emulator,
  type P1EmulatorId,
  type StartedP1Emulator,
} from './p1-catalog';
import { startWifikit, type Running } from './servers';

/**
 * Lance des onduleurs émulés sur ce Mac, pour essayer ConsoElec avec une marque qu'on n'a pas :
 *
 *   npm run emulate                     tous : onduleurs (ports 15001…) et lecteurs P1 (ports 15101…)
 *   npm run emulate -- huawei solis     seulement ceux-là
 *   npm run emulate -- --lan fronius    sur le réseau local (adresse IP du Mac), avec réponse aux recherches
 *   npm run emulate -- --list           liste des émulateurs
 *
 * Les réglages à saisir dans ConsoElec (marque, adresse, port, identifiant, clé) s'affichent au démarrage.
 */

const PORT_BASE = 15001;
const P1_PORT_BASE = 15101;

function lanAddress(): string {
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal && !info.address.startsWith('169.254.')) {
        return info.address;
      }
    }
  }
  return '127.0.0.1';
}

function describe(e: StartedEmulator): string {
  const s = e.settings;
  const lines = [
    `● ${e.label}  [${e.id}]`,
    `    Marque : ${inverterBrand(s.brand).label}`,
    `    Adresse : ${s.host}    Port : ${s.port}`,
  ];
  if (s.unitId !== null) {
    lines.push(`    Identifiant Modbus : ${s.unitId}`);
  }
  if (s.loggerSerial !== null) {
    lines.push(`    N° de série de la clé Wi-Fi : ${s.loggerSerial}`);
  }
  if (s.secret !== null) {
    lines.push(`    ${s.brand === 'enphase' ? 'Jeton' : 'Clé / mot de passe'} : ${s.secret}`);
  }
  return lines.join('\n');
}

function describeP1(e: StartedP1Emulator): string {
  const lines = [
    `● ${e.label}  [${e.id}]`,
    `    Lecteur P1 : ${p1Reader(e.kind).label}`,
    `    Adresse : ${e.host}    Port : ${e.port}`,
  ];
  if (e.v2) {
    lines.push(
      '    Association : « Associer » dans les réglages (bouton pressé tout seul à la 3e demande)',
    );
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--list') || args.includes('-h') || args.includes('--help')) {
    console.log('Onduleurs :');
    for (const id of EMULATOR_IDS) {
      console.log(`  ${id.padEnd(17)} ${EMULATORS[id].label}`);
    }
    console.log('Lecteurs P1 :');
    for (const id of P1_EMULATOR_IDS) {
      console.log(`  ${id.padEnd(17)} ${P1_EMULATORS[id].label}`);
    }
    return;
  }
  const lan = args.includes('--lan');
  const wanted = args.filter((a) => !a.startsWith('--'));
  const isInverter = (a: string): a is EmulatorId => EMULATOR_IDS.includes(a as EmulatorId);
  const isP1 = (a: string): a is P1EmulatorId => P1_EMULATOR_IDS.includes(a as P1EmulatorId);
  const unknown = wanted.filter((a) => !isInverter(a) && !isP1(a));
  if (unknown.length > 0) {
    console.error(`Émulateur inconnu : ${unknown.join(', ')} (voir --list).`);
    process.exitCode = 1;
    return;
  }
  const ids = wanted.length > 0 ? wanted.filter(isInverter) : EMULATOR_IDS;
  const p1Ids = wanted.length > 0 ? wanted.filter(isP1) : P1_EMULATOR_IDS;
  const bindHost = lan ? '0.0.0.0' : '127.0.0.1';
  const shownHost = lan ? lanAddress() : '127.0.0.1';
  const started: StartedEmulator[] = [];
  const p1Started: StartedP1Emulator[] = [];
  const extra: Running[] = [];
  for (const id of ids) {
    const e = await startEmulator(id, {
      port: PORT_BASE + EMULATOR_IDS.indexOf(id),
      host: bindHost,
    });
    started.push({ ...e, settings: { ...e.settings, host: shownHost } });
  }
  for (const id of p1Ids) {
    const e = await startP1Emulator(id, {
      port: P1_PORT_BASE + P1_EMULATOR_IDS.indexOf(id),
      host: bindHost,
      autoPressAfter: 2,
    });
    p1Started.push({ ...e, host: shownHost });
  }
  // Recherche des clés Wi-Fi (Solarman, GoodWe) : une seule réponse possible sur le port 48899.
  const kit = started.find((e) => e.settings.loggerSerial !== null || e.id.startsWith('goodwe'));
  if (lan && kit) {
    try {
      extra.push(
        await startWifikit({
          ip: shownHost,
          mac: 'ACCF23000001',
          serial: kit.settings.loggerSerial ?? 'Solar-WiFi',
        }),
      );
      console.log(`Recherche sur le réseau : la clé Wi-Fi de « ${kit.label} » répond.\n`);
    } catch {
      console.log('Port 48899 occupé : pas de réponse aux recherches de clés Wi-Fi.\n');
    }
  }
  if (started.length > 0) {
    console.log('Onduleurs émulés (journée solaire simulée à l’heure du Mac) :\n');
    console.log(started.map(describe).join('\n\n'));
  }
  if (p1Started.length > 0) {
    console.log(
      '\nLecteurs P1 émulés (maison et panneaux simulés, tarif de nuit 22 h-7 h et week-ends) :\n',
    );
    console.log(p1Started.map(describeP1).join('\n\n'));
  }
  console.log(
    '\nDans ConsoElec : Réglages › Onduleur (marque) ou Réglages › Compteur (type de lecteur), puis adresse et port.' +
      '\nCtrl+C pour arrêter.',
  );
  const stop = async (): Promise<void> => {
    await Promise.all([
      ...started.map((e) => e.close()),
      ...p1Started.map((e) => e.close()),
      ...extra.map((r) => r.close()),
    ]);
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

void main();
