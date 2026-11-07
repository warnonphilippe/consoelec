/**
 * Lecteurs du port P1 du compteur, partagés par le process principal et l'interface. Le port P1 suit la norme
 * belge e-MUCS (dérivée de la norme néerlandaise DSMR 5) quel que soit le gestionnaire de réseau ; ce qui change d'un
 * lecteur à l'autre, c'est la façon dont il relaie les données sur le réseau de la maison.
 */

export type P1ReaderKind = 'homewizard' | 'homewizard-v2' | 'chargee' | 'youless' | 'dsmr-tcp';

export interface P1ReaderInfo {
  readonly id: P1ReaderKind;
  readonly label: string;
  readonly models: string;
  readonly defaultPort: number;
  /** Service Bonjour annoncé par le lecteur, ou `null` (recherche par balayage du réseau, ou aucune). */
  readonly bonjour: string | null;
  /** Recherche par balayage du réseau local (port ouvert puis vraie lecture). */
  readonly scan: boolean;
  /** Connexion HTTPS avec jeton obtenu en appuyant sur le bouton du lecteur ; certificat épinglé. */
  readonly pairing: boolean;
  readonly hostPlaceholder: string;
  readonly setup: string;
}

export const P1_READERS: readonly P1ReaderInfo[] = [
  {
    id: 'homewizard',
    label: 'HomeWizard Wi-Fi P1 (API v1)',
    models: 'HomeWizard Wi-Fi P1 Meter, API locale v1 (HTTP)',
    defaultPort: 80,
    bonjour: '_hwenergy._tcp',
    scan: false,
    pairing: false,
    hostPlaceholder: 'p1meter-abc123.local',
    setup:
      "Activez l'API locale dans l'application HomeWizard Energy (Réglages › Compteurs › votre compteur › API locale). HomeWizard compte retirer cette version à terme : préférez l'API v2 si votre lecteur la propose.",
  },
  {
    id: 'homewizard-v2',
    label: 'HomeWizard Wi-Fi P1 (API v2, recommandée)',
    models: 'HomeWizard Wi-Fi P1 Meter, logiciel 6.00 ou plus, API locale v2 (HTTPS)',
    defaultPort: 443,
    bonjour: '_homewizard._tcp',
    scan: false,
    pairing: true,
    hostPlaceholder: 'p1meter-abc123.local',
    setup:
      'Rien à activer : cliquez sur « Associer », puis appuyez sur le bouton du lecteur dans les 30 secondes. ConsoElec reçoit un jeton, rangé dans le Trousseau.',
  },
  {
    id: 'chargee',
    label: 'Chargee Sparky / Flint',
    models: 'lecteurs P1 Chargee, API locale compatible HomeWizard v1',
    defaultPort: 80,
    bonjour: '_chargee_p1._tcp',
    scan: false,
    pairing: false,
    hostPlaceholder: '192.168.1.60',
    setup: "Rien à activer sur les logiciels récents : l'API locale est ouverte d'usine.",
  },
  {
    id: 'youless',
    label: 'YouLess LS120',
    models: 'YouLess LS120 (et LS110 avec module P1)',
    defaultPort: 80,
    bonjour: null,
    scan: true,
    pairing: false,
    hostPlaceholder: '192.168.1.60',
    setup:
      'Rien à activer : ConsoElec lit la page de données locale du YouLess (sans mot de passe).',
  },
  {
    id: 'dsmr-tcp',
    label: 'Télégramme P1 brut (TCP)',
    models:
      'lecteurs qui relaient le télégramme du compteur tel quel : SlimmeLezer et autres ESPHome, P1-dongle, passerelles série vers Wi-Fi (ser2net…)',
    defaultPort: 23,
    bonjour: null,
    scan: false,
    pairing: false,
    hostPlaceholder: '192.168.1.60',
    setup:
      'Le lecteur doit diffuser le télégramme P1 sur un port TCP (souvent 23 ou 8088). ConsoElec vérifie son CRC et en lit les index e-MUCS / DSMR.',
  },
];

export const DEFAULT_P1_READER: P1ReaderKind = 'homewizard';

export function p1Reader(id: string | null | undefined): P1ReaderInfo {
  return P1_READERS.find((r) => r.id === id) ?? P1_READERS[0]!;
}

export const isP1ReaderKind = (value: unknown): value is P1ReaderKind =>
  P1_READERS.some((r) => r.id === value);
