/**
 * Marques d'onduleurs lues sur le réseau local, partagées par le process principal et l'interface : protocole,
 * réglages par défaut et conseils de mise en service. Une marque absente de la liste reste utilisable avec la saisie
 * manuelle de l'index de production dans les relevés.
 */

export type InverterBrand =
  | 'sma'
  | 'fronius'
  | 'solaredge'
  | 'huawei'
  | 'sungrow-sg'
  | 'sungrow-sh'
  | 'solis'
  | 'goodwe-et'
  | 'goodwe-dt'
  | 'enphase'
  | 'kostal'
  | 'deye'
  | 'sofar'
  | 'sunspec';

/**
 * - `sma` : interface WebConnect des onduleurs SMA (HTTPS, connexion SRP ou mot de passe), avec leurs journaux ;
 * - `fronius` : Fronius Solar API (HTTP JSON, sans authentification) ;
 * - `sunspec` : Modbus TCP au format SunSpec (modèles 101-103 ou 111-113), commun à plusieurs marques ;
 * - `registers` : Modbus propre à la marque, en Modbus TCP, par une clé Wi-Fi Solarman (V5) ou en UDP (GoodWe) ;
 * - `enphase` : API locale de la passerelle IQ Gateway (HTTPS, jeton).
 */
export type InverterProtocol = 'sma' | 'fronius' | 'sunspec' | 'registers' | 'enphase';

/** Transport des registres Modbus d'une marque `registers`. */
export type RegisterTransport = 'modbus-tcp' | 'solarman' | 'goodwe-udp';

export interface InverterSecretInfo {
  readonly label: string;
  readonly placeholder: string;
  readonly help: string;
  /** Espaces et tirets retirés à l'enregistrement (clé recopiée de la plaque). */
  readonly compact: boolean;
}

export interface InverterBrandInfo {
  readonly id: InverterBrand;
  /** Nom affiché dans la liste. */
  readonly label: string;
  /** Modèles concernés, en clair. */
  readonly models: string;
  readonly protocol: InverterProtocol;
  /** Transport par défaut (marques `registers`) ; une clé Solarman renseignée l'emporte. */
  readonly transport?: RegisterTransport;
  /** Port par défaut. */
  readonly defaultPort: number;
  /** Identifiant Modbus (unit id, adresse de l'esclave) par défaut ; `null` : sans objet. */
  readonly defaultUnitId: number | null;
  /** Secret demandé (clé, mot de passe, jeton) ; `null` : aucun. */
  readonly secret: InverterSecretInfo | null;
  /** Le secret est indispensable (sinon la lecture n'est pas lancée). */
  readonly secretRequired: boolean;
  /** Champ « numéro de série de la clé Wi-Fi » (Solarman). */
  readonly loggerSerial: boolean;
  /** Recherche sur le réseau : Bonjour, balayage du réseau local, ou aucune. */
  readonly discovery: 'bonjour' | 'scan' | 'none';
  /** L'onduleur garde des journaux lisibles (historique des journées, courbe des journées passées). */
  readonly logs: boolean;
  /** Le certificat HTTPS est épinglé à la première connexion. */
  readonly pinsCertificate: boolean;
  readonly hostPlaceholder: string;
  /** Ce qu'il faut activer sur l'onduleur, en une ou deux phrases. */
  readonly setup: string;
}

const SMA_KEY: InverterSecretInfo = {
  label: 'Clé WPA2-PSK de la plaque, ou mot de passe « Utilisateur »',
  placeholder: '16 caractères',
  help: "Rangée dans le Trousseau. Les onduleurs SMA récents se connectent avec la clé WPA2-PSK de la plaque ; les plus anciens, avec le mot de passe du profil « Utilisateur » de leur interface web.",
  compact: false,
};

export const INVERTER_BRANDS: readonly InverterBrandInfo[] = [
  {
    id: 'sma',
    label: 'SMA',
    models: 'Sunny Boy, Sunny Tripower, Sunny Boy Storage (interface WebConnect)',
    protocol: 'sma',
    defaultPort: 443,
    defaultUnitId: null,
    secret: SMA_KEY,
    secretRequired: true,
    loggerSerial: false,
    discovery: 'bonjour',
    logs: true,
    pinsCertificate: true,
    hostPlaceholder: 'SMA3012345678.local',
    setup:
      "Rien à activer : l'onduleur doit être relié au réseau de la maison (Wi-Fi ou câble). Son nom réseau est « SMA » suivi de son numéro de série.",
  },
  {
    id: 'fronius',
    label: 'Fronius',
    models: 'Primo, Symo, Galvo, Eco (Datamanager), GEN24, Tauro',
    protocol: 'fronius',
    defaultPort: 80,
    defaultUnitId: null,
    secret: null,
    secretRequired: false,
    loggerSerial: false,
    discovery: 'scan',
    logs: false,
    pinsCertificate: false,
    hostPlaceholder: '192.168.1.40',
    setup:
      "Solar API activée (activée d'usine ; sur un GEN24 : interface web › Communication › Solar API › « Activer la communication par Solar API »).",
  },
  {
    id: 'solaredge',
    label: 'SolarEdge',
    models: 'onduleurs monophasés et triphasés, Home Hub, Energy Hub',
    protocol: 'sunspec',
    defaultPort: 1502,
    defaultUnitId: 1,
    secret: null,
    secretRequired: false,
    loggerSerial: false,
    discovery: 'scan',
    logs: false,
    pinsCertificate: false,
    hostPlaceholder: '192.168.1.40',
    setup:
      "Modbus TCP à activer par l'installateur dans SetApp (Communication › Modbus TCP) ; port 1502 sur les modèles récents, 502 sur les anciens.",
  },
  {
    id: 'huawei',
    label: 'Huawei',
    models: 'SUN2000 (L1, M1, KTL), avec SDongle ou Wi-Fi intégré',
    protocol: 'registers',
    transport: 'modbus-tcp',
    defaultPort: 502,
    defaultUnitId: 1,
    secret: null,
    secretRequired: false,
    loggerSerial: false,
    discovery: 'scan',
    logs: false,
    pinsCertificate: false,
    hostPlaceholder: '192.168.1.40',
    setup:
      "Modbus TCP à activer dans FusionSolar (Mise en service › Paramètres de communication › Dongle › Modbus TCP › « Activer (sans restriction) ») ; identifiant 1 par le SDongle, 0 par le Wi-Fi de l'onduleur (port 6607).",
  },
  {
    id: 'sungrow-sg',
    label: 'Sungrow réseau (SG)',
    models: 'SG…RS, SG…RT, avec WiNet-S',
    protocol: 'registers',
    transport: 'modbus-tcp',
    defaultPort: 502,
    defaultUnitId: 1,
    secret: null,
    secretRequired: false,
    loggerSerial: false,
    discovery: 'scan',
    logs: false,
    pinsCertificate: false,
    hostPlaceholder: '192.168.1.40',
    setup: 'Modbus TCP ouvert sur le WiNet-S (port 502) : utilisez l’adresse IP du WiNet-S.',
  },
  {
    id: 'sungrow-sh',
    label: 'Sungrow hybride (SH)',
    models: 'SH…RS, SH…RT, avec WiNet-S',
    protocol: 'registers',
    transport: 'modbus-tcp',
    defaultPort: 502,
    defaultUnitId: 1,
    secret: null,
    secretRequired: false,
    loggerSerial: false,
    discovery: 'scan',
    logs: false,
    pinsCertificate: false,
    hostPlaceholder: '192.168.1.40',
    setup:
      'Modbus TCP ouvert sur le WiNet-S (port 502). La puissance lue est celle des panneaux (courant continu), hors batterie.',
  },
  {
    id: 'solis',
    label: 'Solis (Ginlong)',
    models: 'S5, S6, mini, onduleurs réseau monophasés et triphasés',
    protocol: 'registers',
    transport: 'modbus-tcp',
    defaultPort: 502,
    defaultUnitId: 1,
    secret: null,
    secretRequired: false,
    loggerSerial: true,
    discovery: 'scan',
    logs: false,
    pinsCertificate: false,
    hostPlaceholder: '192.168.1.40',
    setup:
      "Par une clé Wi-Fi de type Solarman (port 8899, numéro de série de la clé requis) ou par un adaptateur RS485 vers Modbus TCP. Les clés Solis S3 récentes n'ouvrent pas d'accès local.",
  },
  {
    id: 'goodwe-et',
    label: 'GoodWe hybride',
    models: 'ET, EH, BT, BH (et ES-G2)',
    protocol: 'registers',
    transport: 'goodwe-udp',
    defaultPort: 8899,
    defaultUnitId: 0xf7,
    secret: null,
    secretRequired: false,
    loggerSerial: false,
    discovery: 'scan',
    logs: false,
    pinsCertificate: false,
    hostPlaceholder: '192.168.1.40',
    setup: "Rien à activer : la clé Wi-Fi ou LAN GoodWe répond en local (UDP 8899). Adresse d'onduleur 247 par défaut.",
  },
  {
    id: 'goodwe-dt',
    label: 'GoodWe réseau',
    models: 'DT, D-NS, DNS, XS, SDT, SMT, MS',
    protocol: 'registers',
    transport: 'goodwe-udp',
    defaultPort: 8899,
    defaultUnitId: 0x7f,
    secret: null,
    secretRequired: false,
    loggerSerial: false,
    discovery: 'scan',
    logs: false,
    pinsCertificate: false,
    hostPlaceholder: '192.168.1.40',
    setup: "Rien à activer : la clé Wi-Fi ou LAN GoodWe répond en local (UDP 8899). Adresse d'onduleur 127 par défaut.",
  },
  {
    id: 'enphase',
    label: 'Enphase',
    models: 'micro-onduleurs IQ, passerelle IQ Gateway (Envoy)',
    protocol: 'enphase',
    defaultPort: 443,
    defaultUnitId: null,
    secret: {
      label: 'Jeton Enphase (propriétaire)',
      placeholder: 'eyJraWQiOi…',
      help: "Rangé dans le Trousseau. Jeton d'un an, à créer sur entrez.enphaseenergy.com (compte Enlighten › passerelle › « Create access token »).",
      compact: false,
    },
    secretRequired: true,
    loggerSerial: false,
    discovery: 'bonjour',
    logs: false,
    pinsCertificate: true,
    hostPlaceholder: 'envoy.local',
    setup: "Rien à activer : la passerelle IQ Gateway répond en local (HTTPS) avec le jeton du propriétaire.",
  },
  {
    id: 'kostal',
    label: 'Kostal',
    models: 'Plenticore plus, Plenticore G3, Piko IQ / MP',
    protocol: 'sunspec',
    defaultPort: 1502,
    defaultUnitId: 71,
    secret: null,
    secretRequired: false,
    loggerSerial: false,
    discovery: 'scan',
    logs: false,
    pinsCertificate: false,
    hostPlaceholder: '192.168.1.40',
    setup: 'Modbus TCP / SunSpec à activer dans l’interface web (Réglages › Modbus / SunSpec (TCP)) : port 1502, identifiant 71.',
  },
  {
    id: 'deye',
    label: 'Deye',
    models: 'onduleurs réseau SUN-…K-G, micro-onduleurs SUN-M',
    protocol: 'registers',
    transport: 'solarman',
    defaultPort: 8899,
    defaultUnitId: 1,
    secret: null,
    secretRequired: false,
    loggerSerial: true,
    discovery: 'scan',
    logs: false,
    pinsCertificate: false,
    hostPlaceholder: '192.168.1.40',
    setup: 'Par la clé Wi-Fi Solarman (port 8899) : son numéro de série figure sur son étiquette.',
  },
  {
    id: 'sofar',
    label: 'Sofar',
    models: 'KTL-X, KTLM-G2 avec clé Wi-Fi LSW-3',
    protocol: 'registers',
    transport: 'solarman',
    defaultPort: 8899,
    defaultUnitId: 1,
    secret: null,
    secretRequired: false,
    loggerSerial: true,
    discovery: 'scan',
    logs: false,
    pinsCertificate: false,
    hostPlaceholder: '192.168.1.40',
    setup: 'Par la clé Wi-Fi Solarman LSW-3 (port 8899) : son numéro de série figure sur son étiquette.',
  },
  {
    id: 'sunspec',
    label: 'Autre onduleur SunSpec (Modbus TCP)',
    models: 'SMA, Fronius, ABB/FIMER, Delta, SolarEdge, Kostal… en Modbus SunSpec',
    protocol: 'sunspec',
    defaultPort: 502,
    defaultUnitId: 1,
    secret: null,
    secretRequired: false,
    loggerSerial: false,
    discovery: 'scan',
    logs: false,
    pinsCertificate: false,
    hostPlaceholder: '192.168.1.40',
    setup:
      'Modbus TCP au format SunSpec à activer sur l’onduleur. Identifiants usuels : SMA 3 (ou 126), Fronius 1, SolarEdge 1, Kostal 71.',
  },
];

export const DEFAULT_INVERTER_BRAND: InverterBrand = 'sma';

export function inverterBrand(id: string | null | undefined): InverterBrandInfo {
  return INVERTER_BRANDS.find((b) => b.id === id) ?? INVERTER_BRANDS[0]!;
}

export const isInverterBrand = (value: unknown): value is InverterBrand =>
  INVERTER_BRANDS.some((b) => b.id === value);

/** Transport effectif d'une marque `registers` : une clé Solarman renseignée impose le protocole Solarman. */
export function registerTransport(brand: InverterBrandInfo, loggerSerial: string | null): RegisterTransport {
  if (brand.loggerSerial && loggerSerial) {
    return 'solarman';
  }
  return brand.transport === 'solarman' && !loggerSerial ? 'modbus-tcp' : (brand.transport ?? 'modbus-tcp');
}

/** Port effectif : celui des réglages, sinon celui du transport. */
export function effectivePort(
  brand: InverterBrandInfo,
  port: number | null,
  loggerSerial: string | null,
): number {
  if (port !== null) {
    return port;
  }
  if (brand.protocol === 'registers') {
    const transport = registerTransport(brand, loggerSerial);
    return transport === 'solarman' || transport === 'goodwe-udp' ? 8899 : brand.loggerSerial ? 502 : brand.defaultPort;
  }
  return brand.defaultPort;
}
