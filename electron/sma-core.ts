/**
 * Partie pure du client WebConnect des onduleurs SMA (aucune dépendance à Electron) : connexion SRP « YAP »,
 * comme le fait l'interface web de l'onduleur, et lecture des mesures. Testée sans réseau.
 *
 * Paramètres relevés dans l'interface web de l'onduleur : groupe SRP de 8192 bits (RFC 5054), g = 19,
 * SHA-1 pour x, k et u, SHA-256 pour la clé de session K et les preuves M1 / M2 (variante RFC 2945).
 * Le secret est la clé WLAN-PSK de la plaque quand l'onduleur l'annonce (`sessionCheck` : `usrSct = "WLAN-PSK"`).
 */
import crypto from 'node:crypto';

const N_HEX =
  'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DD' +
  'EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED' +
  'EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F' +
  '83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B' +
  'E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA0510' +
  '15728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7' +
  'ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200C' +
  'BBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A92108011A723C12A787E6D7' +
  '88719A10BDBA5B2699C327186AF4E23C1A946834B6150BDA2583E9CA2AD44CE8DBBBC2DB04DE8EF92E8EFC141FBECAA6' +
  '287C59474E6BC05D99B2964FA090C3A2233BA186515BE7ED1F612970CEE2D7AFB81BDD762170481CD0069127D5B05AA9' +
  '93B4EA988D8FDDC186FFB7DC90A6C08F4DF435C93402849236C3FAB4D27C7026C1D4DCB2602646DEC9751E763DBA37BD' +
  'F8FF9406AD9E530EE5DB382F413001AEB06A53ED9027D831179727B0865A8918DA3EDBEBCF9B14ED44CE6CBACED4BB1B' +
  'DB7F1447E6CC254B332051512BD7AF426FB8F401378CD2BF5983CA01C64B92ECF032EA15D1721D03F482D7CE6E74FEF6' +
  'D55E702F46980C82B5A84031900B1C9E59E7C97FBEC7E8F323A97A7E36CC88BE0F1D45B7FF585AC54BD407B22B4154AA' +
  'CC8F6D7EBF48E1D814CC5ED20F8037E0A79715EEF29BE32806A1D58BB7C5DA76F550AA3D8A1FBFF0EB19CCB1A313D55C' +
  'DA56C9EC2EF29632387FE8D76E3C0468043E8F663F4860EE12BF2D5B0B7474D6E694F91E6DBE115974A3926F12FEE5E4' +
  '38777CB6A932DF8CD8BEC4D073B931BA3BC832B68D9DD300741FA7BF8AFC47ED2576F6936BA424663AAB639C5AE4F568' +
  '3423B4742BF1C978238F16CBE39D652DE3FDB8BEFC848AD922222E04A4037C0713EB57A81A23F0C73473FC646CEA306B' +
  '4BCBC8862F8385DDFA9D4B7FA2C087E879683303ED5BDD3A062B3CF5B3A278A66D2A13F83F44F82DDF310EE074AB6A36' +
  '4597E899A0255DC164F31CC50846851DF9AB48195DED7EA1B1D510BD7EE74D73FAF36BC31ECFA268359046F4EB879F92' +
  '4009438B481C6CD7889A002ED5EE382BC9190DA6FC026E479558E4475677E9AA9E3050E2765694DFC81F56E880B96E71' +
  '60C980DD98EDD3DFFFFFFFFFFFFFFFFF';

export const SRP_N = BigInt('0x' + N_HEX);
export const SRP_G = 19n;
const N_BYTES = 1024;

export type InverterRole = 'usr' | 'istl';

/** Clés des mesures lues : puissance AC totale (W), production totale (Wh), production du jour (Wh). */
export const MEASUREMENT_KEYS = {
  powerW: '6100_40263F00',
  totalWh: '6400_00260100',
  dayWh: '6400_00262200',
} as const;

export interface Measurements {
  readonly powerW: number | null;
  readonly totalWh: number | null;
  readonly dayWh: number | null;
}

export const toBuf = (n: bigint): Buffer => {
  let h = n.toString(16);
  if (h.length % 2) {
    h = '0' + h;
  }
  return Buffer.from(h, 'hex');
};
export const toBn = (b: Buffer): bigint => BigInt('0x' + (b.toString('hex') || '0'));
export const pad = (b: Buffer): Buffer =>
  Buffer.concat([Buffer.alloc(Math.max(0, N_BYTES - b.length)), b]);
export const strip = (b: Buffer): Buffer => {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) {
    i++;
  }
  return b.subarray(i);
};
const hash = (alg: string, ...parts: Buffer[]): Buffer => {
  const h = crypto.createHash(alg);
  for (const p of parts) {
    h.update(p);
  }
  return h.digest();
};
const mod = (a: bigint, m: bigint): bigint => ((a % m) + m) % m;

export function modPow(base: bigint, exp: bigint, m: bigint): bigint {
  let result = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) {
      result = (result * b) % m;
    }
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

export interface SrpStart {
  /** Corps à envoyer à `/dyn/authYAPStart.json`. */
  readonly body: { username: string; A: string };
  readonly a: bigint;
  readonly A: Buffer;
}

export function srpStart(role: InverterRole, randomA: Buffer = crypto.randomBytes(48)): SrpStart {
  const a = toBn(randomA);
  const A = pad(toBuf(modPow(SRP_G, a, SRP_N)));
  return { body: { username: role, A: A.toString('hex') }, a, A };
}

export interface SrpFinish {
  /** Corps à envoyer à `/dyn/authYAPFinish.json`. */
  readonly body: { M1: string; id: unknown };
  /** Preuve que l'onduleur doit renvoyer (authentifie l'onduleur). */
  readonly expectedM2: string;
}

export function srpFinish(
  start: SrpStart,
  role: InverterRole,
  secret: string,
  server: { B: string; salt: string; id?: unknown },
): SrpFinish {
  const I = Buffer.from(role);
  const salt = strip(Buffer.from(server.salt, 'hex'));
  const Bbuf = pad(Buffer.from(server.B, 'hex'));
  const B = toBn(Bbuf);
  if (B % SRP_N === 0n) {
    throw new Error("Réponse invalide de l'onduleur (B).");
  }
  const k = toBn(hash('sha1', pad(toBuf(SRP_N)), pad(toBuf(SRP_G))));
  const x = toBn(
    hash('sha1', salt, hash('sha1', Buffer.concat([I, Buffer.from(':'), Buffer.from(secret)]))),
  );
  const u = toBn(hash('sha1', start.A, Bbuf));
  const S = modPow(mod(B - k * modPow(SRP_G, x, SRP_N), SRP_N), start.a + u * x, SRP_N);
  const K = hash('sha256', toBuf(S));
  const hN = hash('sha256', toBuf(SRP_N));
  const hG = hash('sha256', toBuf(SRP_G));
  for (let i = 0; i < hN.length; i++) {
    hN[i] = hN[i]! ^ hG[i]!;
  }
  const M1 = hash('sha256', hN, hash('sha256', I), salt, strip(start.A), strip(Bbuf), K);
  const M2 = hash('sha256', strip(start.A), M1, K);
  return { body: { M1: M1.toString('hex'), id: server.id }, expectedM2: M2.toString('hex') };
}

/** Message lisible pour une réponse d'erreur de l'onduleur. */
export function inverterError(status: number, json: unknown): string {
  const res = (json as { result?: { res?: number } } | null)?.result?.res;
  if (res === -28607) {
    return "Clé refusée par l'onduleur : vérifiez la clé WPA2-PSK de la plaque.";
  }
  if (res === -28603) {
    return "Connexion désactivée sur l'onduleur pour ce profil.";
  }
  if (status === 401) {
    return "Clé refusée par l'onduleur (401).";
  }
  if (status === 403) {
    return "Profil inconnu ou bloqué sur l'onduleur (403) : réessayez dans quelques minutes.";
  }
  if (status === 503) {
    return "L'onduleur n'accepte plus de session pour l'instant (503) : réessayez plus tard.";
  }
  return `Réponse inattendue de l'onduleur (HTTP ${status}).`;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Extrait les mesures de la réponse de `/dyn/getValues.json` (valeurs `null` la nuit). */
export function parseMeasurements(json: unknown): Measurements {
  const result = (json as { result?: Record<string, Record<string, unknown>> } | null)?.result;
  const device = result ? Object.values(result)[0] : undefined;
  if (!device) {
    throw new Error("Réponse de mesures inattendue de l'onduleur.");
  }
  const read = (key: string): number | null => {
    const entry = device[key] as Record<string, { val?: unknown }[]> | undefined;
    const first = entry ? Object.values(entry)[0] : undefined;
    return Array.isArray(first) ? numberOrNull(first[0]?.val) : null;
  };
  return {
    powerW: read(MEASUREMENT_KEYS.powerW),
    totalWh: read(MEASUREMENT_KEYS.totalWh),
    dayWh: read(MEASUREMENT_KEYS.dayWh),
  };
}

/** La session a-t-elle expiré (l'onduleur répond `err: 401` dans le corps) ? */
export function isSessionExpired(status: number, json: unknown): boolean {
  return status === 401 || (json as { err?: number } | null)?.err === 401;
}

// --- Journaux de production de l'onduleur (`/dyn/getLogger.json`) ---------------------------------------------

/** Journaux d'énergie : index total (Wh) toutes les 5 minutes, et une fois par jour. */
export const LOGGER_KEYS = { fiveMinutes: 28672, daily: 28704 } as const;

export interface LoggerPoint {
  /** Horodatage (s, UTC). */
  readonly t: number;
  /** Index de production totale (Wh). */
  readonly v: number;
}

/** Points d'un journal (triés, sans valeurs manquantes). */
export function parseLogger(json: unknown): LoggerPoint[] {
  const result = (json as { result?: Record<string, unknown> } | null)?.result;
  const device = result ? Object.values(result)[0] : undefined;
  if (!Array.isArray(device)) {
    throw new Error("Réponse de journal inattendue de l'onduleur.");
  }
  return device
    .map((p) => p as { t?: unknown; v?: unknown })
    .filter((p): p is LoggerPoint => typeof p.t === 'number' && typeof p.v === 'number' && Number.isFinite(p.v))
    .map((p) => ({ t: p.t, v: p.v }))
    .sort((a, b) => a.t - b.t);
}

export interface LoggerDay {
  /** `AAAA-MM-JJ`, date locale. */
  readonly date: string;
  readonly dayKwh: number;
  /** Index en fin de journée (kWh). */
  readonly totalKwh: number;
}

/**
 * Production par jour à partir du journal quotidien : la différence entre deux points espacés d'environ un jour est
 * attribuée à la date locale du milieu de l'intervalle (que l'onduleur horodate le début ou la fin de la journée).
 */
export function dailyFromLogger(points: readonly LoggerPoint[], localDate: (ms: number) => string): LoggerDay[] {
  const days: LoggerDay[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const hours = (b.t - a.t) / 3600;
    const energy = b.v - a.v;
    if (hours < 20 || hours > 28 || energy < 0) {
      continue;
    }
    days.push({
      date: localDate(((a.t + b.t) / 2) * 1000),
      dayKwh: Math.round(energy) / 1000,
      totalKwh: Math.round(b.v) / 1000,
    });
  }
  return days;
}

/** Puissance moyenne (W) de chaque intervalle du journal des 5 minutes, horodatée à sa fin (ms). */
export function powerFromLogger(points: readonly LoggerPoint[]): { at: number; powerW: number }[] {
  const curve: { at: number; powerW: number }[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const hours = (b.t - a.t) / 3600;
    if (hours <= 0 || hours > 1 || b.v < a.v) {
      continue;
    }
    curve.push({ at: b.t * 1000, powerW: Math.round((b.v - a.v) / hours) });
  }
  return curve;
}
