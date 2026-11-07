import os from 'node:os';
import { inverterBrand } from '../../electron/shared/inverter-brands';
import { EMULATOR_IDS, EMULATORS, startEmulator, type EmulatorId, type StartedEmulator } from './catalog';
import { startWifikit, type Running } from './servers';

/**
 * Lance des onduleurs émulés sur ce Mac, pour essayer ConsoElec avec une marque qu'on n'a pas :
 *
 *   npm run emulate                     tous les émulateurs, sur 127.0.0.1, ports 15001 et suivants
 *   npm run emulate -- huawei solis     seulement ceux-là
 *   npm run emulate -- --lan fronius    sur le réseau local (adresse IP du Mac), avec réponse aux recherches
 *   npm run emulate -- --list           liste des émulateurs
 *
 * Les réglages à saisir dans ConsoElec (marque, adresse, port, identifiant, clé) s'affichent au démarrage.
 */

const PORT_BASE = 15001;

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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--list') || args.includes('-h') || args.includes('--help')) {
    console.log('Émulateurs disponibles :');
    for (const id of EMULATOR_IDS) {
      console.log(`  ${id.padEnd(14)} ${EMULATORS[id].label}`);
    }
    return;
  }
  const lan = args.includes('--lan');
  const wanted = args.filter((a) => !a.startsWith('--'));
  const unknown = wanted.filter((a) => !EMULATOR_IDS.includes(a as EmulatorId));
  if (unknown.length > 0) {
    console.error(`Émulateur inconnu : ${unknown.join(', ')} (voir --list).`);
    process.exitCode = 1;
    return;
  }
  const ids = (wanted.length > 0 ? wanted : EMULATOR_IDS) as EmulatorId[];
  const bindHost = lan ? '0.0.0.0' : '127.0.0.1';
  const shownHost = lan ? lanAddress() : '127.0.0.1';
  const started: StartedEmulator[] = [];
  const extra: Running[] = [];
  for (const id of ids) {
    const e = await startEmulator(id, { port: PORT_BASE + EMULATOR_IDS.indexOf(id), host: bindHost });
    started.push({ ...e, settings: { ...e.settings, host: shownHost } });
  }
  // Recherche des clés Wi-Fi (Solarman, GoodWe) : une seule réponse possible sur le port 48899.
  const kit = started.find((e) => e.settings.loggerSerial !== null || e.id.startsWith('goodwe'));
  if (lan && kit) {
    try {
      extra.push(
        await startWifikit({ ip: shownHost, mac: 'ACCF23000001', serial: kit.settings.loggerSerial ?? 'Solar-WiFi' }),
      );
      console.log(`Recherche sur le réseau : la clé Wi-Fi de « ${kit.label} » répond.\n`);
    } catch {
      console.log('Port 48899 occupé : pas de réponse aux recherches de clés Wi-Fi.\n');
    }
  }
  console.log('Onduleurs émulés (journée solaire simulée à l’heure du Mac) :\n');
  console.log(started.map(describe).join('\n\n'));
  console.log(
    '\nDans ConsoElec : Réglages › Onduleur › choisir la marque, puis saisir l’adresse, le port et le reste.' +
      '\nCtrl+C pour arrêter.',
  );
  const stop = async (): Promise<void> => {
    await Promise.all([...started.map((e) => e.close()), ...extra.map((r) => r.close())]);
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

void main();
