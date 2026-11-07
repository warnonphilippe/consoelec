/**
 * Noms réseau (Bonjour) des appareils de la maison, partagés par le process principal et l'interface : identifier
 * un appareil quel que soit le suffixe de conflit (`-2`, `-3`…) ajouté à son nom.
 */

/**
 * Numéro de série d'un onduleur SMA d'après son nom réseau (`SMA3012345678.local`, `SMA3012345678-2.local`…),
 * en majuscules ; `null` pour une adresse IP ou un autre nom. Sert à reconnaître le même onduleur quand il change
 * de nom : en cas de conflit Bonjour, il se renomme avec un suffixe `-2`, `-3`…
 */
export function smaSerial(host: string): string | null {
  const match = /^(SMA\d{6,})(?:-\d+)?(?:\.local\.?)?$/i.exec(host.trim());
  return match ? match[1]!.toUpperCase() : null;
}

/** Identifiant d'un lecteur P1 HomeWizard d'après son nom réseau (`p1meter-1a2b3c[-2].local`), ou `null`. */
export function p1Identity(host: string): string | null {
  const match = /^(p1meter-[0-9a-z]{6})(?:-\d+)?(?:\.local\.?)?$/i.exec(host.trim());
  return match ? match[1]!.toLowerCase() : null;
}

/** Nouvelle adresse proposée par une redécouverte : le même appareil (même identifiant) sous un autre nom. */
export function relocatedHost(
  current: string,
  found: readonly string[],
  identity: (host: string) => string | null,
  /** Sans appareil reconnu, accepter le seul appareil trouvé (onduleur : le certificat épinglé garantit l'identité). */
  acceptSingle = false,
): string | null {
  const same = (a: string, b: string): boolean =>
    a.toLowerCase().replace(/\.$/, '') === b.toLowerCase().replace(/\.$/, '');
  const id = identity(current);
  const candidates = found.filter((h) => !same(h, current));
  const match = id === null ? undefined : candidates.find((h) => identity(h) === id);
  if (match) {
    return match;
  }
  return acceptSingle && found.length === 1 && candidates.length === 1 ? candidates[0]! : null;
}
