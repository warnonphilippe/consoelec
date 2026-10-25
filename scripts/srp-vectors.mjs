// Produit des vecteurs SRP figés avec l'implémentation TypeScript de ConsoElec (electron/sma-core.ts, compilée dans
// dist-electron/) pour vérifier que le port Swift du widget (widget/SmaKit) calcule exactement les mêmes valeurs.
// Usage : npm run build:main && node scripts/srp-vectors.mjs > widget/Tests/srp-vectors.json
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sma = require('../dist-electron/sma-core.js');

const seeded = (label, n) => crypto.createHash('sha512').update(label).digest().subarray(0, n);
const hash = (alg, ...parts) => {
  const h = crypto.createHash(alg);
  parts.forEach((p) => h.update(p));
  return h.digest();
};

const vectors = [];
for (const [i, secret] of ['ABCDEFGH12345678', 'Zz9yX8wV7uT6sR5q'].entries()) {
  const role = 'usr';
  const randomA = seeded(`a${i}`, 48);
  const salt = seeded(`salt${i}`, 16);
  const b = sma.toBn(seeded(`b${i}`, 48));
  const x = sma.toBn(hash('sha1', sma.strip(salt), hash('sha1', Buffer.from(`${role}:${secret}`))));
  const v = sma.modPow(sma.SRP_G, x, sma.SRP_N);
  const k = sma.toBn(hash('sha1', sma.pad(sma.toBuf(sma.SRP_N)), sma.pad(sma.toBuf(sma.SRP_G))));
  const B = sma.pad(sma.toBuf((k * v + sma.modPow(sma.SRP_G, b, sma.SRP_N)) % sma.SRP_N));
  const start = sma.srpStart(role, randomA);
  const finish = sma.srpFinish(start, role, secret, { B: B.toString('hex'), salt: salt.toString('hex') });
  vectors.push({
    role,
    secret,
    randomA: randomA.toString('hex'),
    salt: salt.toString('hex'),
    B: B.toString('hex'),
    A: start.body.A,
    M1: finish.body.M1,
    M2: finish.expectedM2,
  });
}
process.stdout.write(JSON.stringify(vectors, null, 2) + '\n');
