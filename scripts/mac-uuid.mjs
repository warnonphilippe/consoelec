// Hook electron-builder (afterPack, avant la signature) : donne aux exécutables macOS un UUID Mach-O propre à l'app.
//
// macOS rattache l'autorisation « Réseau local » à l'UUID Mach-O de l'exécutable. Toutes les apps construites avec
// la même version d'Electron ont le même UUID : la décision prise pour l'une (ConsoMazout…) s'appliquait à l'autre,
// et ConsoElec recevait EHOSTUNREACH vers l'onduleur. L'UUID est dérivé de l'appId et du chemin de l'exécutable :
// identique d'un build à l'autre (l'autorisation est conservée), différent d'une app à l'autre.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const LC_UUID = 0x1b;

/** UUID déterministe (format RFC 4122, version 5) tiré du SHA-256 de `seed`. */
export function deriveUuid(seed) {
  const bytes = createHash('sha256').update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return Buffer.from(bytes);
}

/** Remplace le LC_UUID d'un Mach-O 64 bits commençant à `offset`. Renvoie l'ancien UUID, ou null s'il n'y en a pas. */
function patchThin(buffer, offset, uuid) {
  if (buffer.readUInt32LE(offset) !== MH_MAGIC_64) {
    throw new Error('Mach-O 64 bits attendu');
  }
  const ncmds = buffer.readUInt32LE(offset + 16);
  let cmd = offset + 32;
  for (let i = 0; i < ncmds; i++) {
    if (buffer.readUInt32LE(cmd) === LC_UUID) {
      const previous = Buffer.from(buffer.subarray(cmd + 8, cmd + 24));
      uuid.copy(buffer, cmd + 8);
      return previous;
    }
    cmd += buffer.readUInt32LE(cmd + 4);
  }
  return null;
}

/** Remplace le LC_UUID de chaque architecture d'un Mach-O (simple ou universel). Renvoie le nombre de remplacements. */
export function setMachOUuid(buffer, uuid) {
  const magic = buffer.readUInt32BE(0);
  if (magic !== FAT_MAGIC && magic !== FAT_MAGIC_64) {
    return patchThin(buffer, 0, uuid) ? 1 : 0;
  }
  const count = buffer.readUInt32BE(4);
  const entry = magic === FAT_MAGIC ? 20 : 32;
  let patched = 0;
  for (let i = 0; i < count; i++) {
    const at = 8 + i * entry;
    const offset = magic === FAT_MAGIC ? buffer.readUInt32BE(at + 8) : Number(buffer.readBigUInt64BE(at + 8));
    patched += patchThin(buffer, offset, uuid) ? 1 : 0;
  }
  return patched;
}

/** Exécutables de l'app : Contents/MacOS/* et ceux des helpers (Contents/Frameworks/*.app). */
function executables(appPath) {
  const dirs = [path.join(appPath, 'Contents/MacOS')];
  const frameworks = path.join(appPath, 'Contents/Frameworks');
  if (existsSync(frameworks)) {
    for (const name of readdirSync(frameworks)) {
      if (name.endsWith('.app')) {
        dirs.push(path.join(frameworks, name, 'Contents/MacOS'));
      }
    }
  }
  return dirs
    .filter((d) => existsSync(d))
    .flatMap((d) => readdirSync(d).map((f) => path.join(d, f)))
    .filter((f) => statSync(f).isFile());
}

/** Point d'entrée electron-builder. */
export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') {
    return;
  }
  const { id, productFilename } = context.packager.appInfo;
  const appPath = path.join(context.appOutDir, `${productFilename}.app`);
  for (const file of executables(appPath)) {
    const relative = path.relative(appPath, file);
    const buffer = readFileSync(file);
    if (setMachOUuid(buffer, deriveUuid(`${id}/${relative}`)) > 0) {
      writeFileSync(file, buffer);
      console.log(`  • UUID Mach-O propre à l'app : ${relative}`);
    }
  }
}
