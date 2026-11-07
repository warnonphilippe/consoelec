/** Échecs consécutifs avant de chercher l'appareil sur le réseau. */
const FAILURES_BEFORE_SEARCH = 2;
/** Une recherche au plus toutes les 10 minutes (une recherche Bonjour dure quelques secondes). */
const MIN_SEARCH_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Reprise automatique quand un appareil du réseau local ne répond plus sous son nom : après quelques échecs
 * consécutifs, cherche l'appareil sur le réseau (Bonjour) et propose son nouveau nom. L'appelant vérifie que
 * l'appareil répond sous ce nom avant de l'adopter.
 */
export class HostRecovery {
  private failures = 0;
  private lastSearch = -Infinity;

  constructor(
    /** Recherche les appareils du réseau ; renvoie leurs noms réseau. */
    private readonly search: () => Promise<string[]>,
    /** Choisit le nouveau nom de l'appareil parmi ceux trouvés, ou `null`. */
    private readonly pick: (current: string, found: readonly string[]) => string | null,
    private readonly now: () => number = Date.now,
  ) {}

  /** La lecture a réussi sous le nom configuré, ou le nom a changé : on repart de zéro. */
  reset(): void {
    this.failures = 0;
  }

  /**
   * Signale une lecture en difficulté (appareil injoignable, ou joint seulement par sa dernière adresse IP).
   * Renvoie le nom réseau à essayer, ou `null` s'il n'est pas encore temps de chercher ou si rien n'a été trouvé.
   */
  async trouble(current: string): Promise<string | null> {
    this.failures++;
    if (
      this.failures < FAILURES_BEFORE_SEARCH ||
      this.now() - this.lastSearch < MIN_SEARCH_INTERVAL_MS
    ) {
      return null;
    }
    this.lastSearch = this.now();
    try {
      return this.pick(current, await this.search());
    } catch {
      return null;
    }
  }
}
