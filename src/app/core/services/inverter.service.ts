import { DestroyRef, Injectable, computed, effect, inject, signal } from '@angular/core';
import type {
  InverterDayCurve,
  InverterHistory,
  InverterReading,
} from '../../../../electron/shared/ipc-contract';
import { smaSerial } from '../../../../electron/shared/device-names';
import { inverterBrand } from '../../../../electron/shared/inverter-brands';
import { dayWhFromTotal } from '../calc/pv-day';
import { toLocalIso } from '../calc/time';
import { DataStore } from './data-store.service';
import { SecretsService } from './secrets.service';

/** Une lecture plus ancienne n'est plus « en direct » (le relevé ne la propose plus). */
const LIVE_MAX_AGE_MS = 2 * 60 * 60 * 1000;
/** Les journaux de l'onduleur ne sont pas relus plus souvent. */
const HISTORY_MIN_INTERVAL_MS = 15 * 60 * 1000;

export interface PowerPoint {
  /** Horodatage (ms). */
  readonly at: number;
  readonly powerW: number;
}

const localDay = (ms: number): string => toLocalIso(new Date(ms)).slice(0, 10);

/**
 * Lecture locale de l'onduleur : transmet la configuration au process principal (qui interroge l'onduleur toutes les
 * 60 s), reçoit les mesures, enregistre la production du jour et épingle le certificat à la première connexion.
 */
@Injectable({ providedIn: 'root' })
export class InverterService {
  private readonly store = inject(DataStore);
  private readonly secrets = inject(SecretsService);
  private readonly api =
    typeof window !== 'undefined' ? (window.consoElec?.inverter ?? null) : null;

  readonly available = this.api !== null;
  readonly live = signal<InverterReading | null>(null);
  readonly busy = signal(false);
  readonly discovering = signal(false);
  /** Courbe de puissance d'aujourd'hui : journal des 5 minutes de l'onduleur, complété par les lectures en direct. */
  readonly todayCurve = signal<PowerPoint[]>([]);
  readonly historyBusy = signal(false);
  /** Courbes des journées passées déjà lues (elles ne changent plus). */
  private readonly curves = new Map<string, readonly PowerPoint[]>();

  /** Résultat de la dernière lecture des journaux : nombre de journées ajoutées ou message d'erreur. */
  readonly historyStatus = signal<{ at: number; added: number; error: string | null } | null>(null);
  readonly settings = computed(() => this.store.settings().inverter);
  /** Marque choisie : protocole, champs à afficher, journaux disponibles. */
  readonly brand = computed(() => inverterBrand(this.settings().brand));
  /** Prêt à interroger l'onduleur : activé, secret enregistré si la marque en demande un. */
  readonly ready = computed(
    () => this.settings().enabled && (!this.brand().secretRequired || this.secrets.has('inverterPsk')),
  );
  /** Dernière lecture réussie récente (moins de 2 h). */
  readonly fresh = computed(() => {
    const r = this.live();
    return r !== null && r.error === null && Date.now() - r.at < LIVE_MAX_AGE_MS ? r : null;
  });

  constructor() {
    if (this.api === null) {
      return;
    }
    const off = this.api.onReading((reading) => this.onReading(reading));
    inject(DestroyRef).onDestroy(off);
    // Adresse pas encore connue : on cherche l'onduleur sur le réseau dès le démarrage.
    if (this.store.loaded() && this.settings().host === '') {
      void this.discover();
    }
    effect(() => {
      const s = this.settings();
      // Relancé aussi quand la clé de l'onduleur change.
      this.secrets.status();
      void this.api?.configure({
        enabled: s.enabled,
        brand: s.brand,
        host: s.host,
        certFingerprint: s.certFingerprint,
        port: s.port,
        unitId: s.unitId,
        loggerSerial: s.loggerSerial,
      });
    });
  }

  async refresh(): Promise<InverterReading | null> {
    if (this.api === null) {
      return null;
    }
    this.busy.set(true);
    try {
      const reading = await this.api.refresh();
      this.onReading(reading);
      return reading;
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Cherche les onduleurs de la marque choisie sur le réseau local et pré-remplit l'adresse si elle est vide (ou si
   * `replace`), avec le numéro de série de la clé Wi-Fi quand la recherche le donne. Renvoie les adresses trouvées.
   */
  async discover(replace = false): Promise<string[]> {
    if (this.api === null || this.brand().discovery === 'none') {
      return [];
    }
    this.discovering.set(true);
    try {
      const current = this.settings();
      const found = await this.api.discover(current.brand);
      if (current.brand !== 'sma') {
        const first = found[0];
        if (first !== undefined && (replace || current.host === '') && current.host !== first.host) {
          this.store.updateSettings({
            inverter: {
              ...current,
              host: first.host,
              certFingerprint: null,
              loggerSerial: first.loggerSerial ?? current.loggerSerial,
            },
          });
        }
        return found.map((f) => f.host);
      }
      const hosts = found.map((f) => f.host);
      // Le même onduleur (même numéro de série) en tête : il a pu changer de nom après un conflit sur le réseau.
      const serial = smaSerial(current.host);
      if (serial !== null) {
        hosts.sort((a, b) => Number(smaSerial(b) === serial) - Number(smaSerial(a) === serial));
      }
      const host = hosts[0];
      if (host !== undefined && (replace || current.host === '') && current.host !== host) {
        // Même numéro de série : l'empreinte épinglée reste valable (et protège le changement d'adresse).
        const sameDevice = serial !== null && smaSerial(host) === serial;
        this.store.updateSettings({
          inverter: { ...current, host, certFingerprint: sameDevice ? current.certFingerprint : null },
        });
      }
      return hosts;
    } finally {
      this.discovering.set(false);
    }
  }

  /**
   * Lit les journaux de l'onduleur : production de chaque journée passée (ajoutée aux données) et courbe du jour.
   * Sans effet si une lecture a eu lieu il y a moins de 15 minutes, sauf `force`.
   */
  async loadHistory(force = false): Promise<void> {
    const last = this.historyStatus();
    if (this.api === null || !this.ready() || this.historyBusy() || !this.brand().logs) {
      return;
    }
    if (!force && last !== null && Date.now() - last.at < HISTORY_MIN_INTERVAL_MS) {
      return;
    }
    this.historyBusy.set(true);
    try {
      const history: InverterHistory = await this.api.history();
      if (history.error !== null) {
        this.historyStatus.set({ at: Date.now(), added: 0, error: history.error });
        return;
      }
      const added = this.store.importPvDays(history.days);
      this.mergeCurve(history.today);
      this.historyStatus.set({ at: Date.now(), added, error: null });
    } finally {
      this.historyBusy.set(false);
    }
  }

  /**
   * Courbe de puissance d'une journée passée (`AAAA-MM-JJ`), lue dans le journal des 5 minutes de l'onduleur puis
   * gardée en mémoire. Pour aujourd'hui, utiliser `todayCurve`.
   */
  async dayCurve(date: string): Promise<InverterDayCurve> {
    const cached = this.curves.get(date);
    if (cached) {
      return { date, points: cached, error: null };
    }
    if (this.api === null) {
      return { date, points: [], error: "La lecture de l'onduleur demande l'application de bureau." };
    }
    if (!this.ready()) {
      return { date, points: [], error: "Onduleur non configuré ou clé absente." };
    }
    if (!this.brand().logs) {
      return {
        date,
        points: [],
        error: `Les onduleurs ${this.brand().label} ne gardent pas de courbe des journées passées : seuls les totaux sont disponibles.`,
      };
    }
    const curve = await this.api.dayCurve(date);
    if (curve.error === null && curve.points.length > 0 && date < localDay(Date.now())) {
      this.curves.set(date, curve.points);
    }
    return curve;
  }

  /** Oublie l'empreinte du certificat (après un remplacement de l'onduleur ou de son certificat). */
  resetPin(): void {
    this.store.updateSettings({ inverter: { ...this.settings(), certFingerprint: null } });
  }

  /** Remplace la courbe par celle du journal et y rajoute les lectures en direct plus récentes. */
  private mergeCurve(logged: readonly PowerPoint[]): void {
    const today = localDay(Date.now());
    const points = logged.filter((p) => localDay(p.at) === today);
    const lastLogged = points.at(-1)?.at ?? 0;
    const live = this.todayCurve().filter((p) => p.at > lastLogged && localDay(p.at) === today);
    this.todayCurve.set([...points, ...live]);
  }

  private onReading(reading: InverterReading): void {
    // L'onduleur a été retrouvé sous un autre nom (même certificat) : on enregistre ce nom.
    if (reading.movedTo && reading.movedTo !== this.settings().host) {
      this.store.updateSettings({ inverter: { ...this.settings(), host: reading.movedTo } });
    }
    const firstSuccess = this.live()?.error !== null && reading.error === null;
    this.live.set(reading);
    if (reading.error === null) {
      const day = localDay(reading.at);
      this.todayCurve.update((curve) => [
        ...curve.filter((p) => localDay(p.at) === day && p.at < reading.at),
        { at: reading.at, powerW: reading.powerW ?? 0 },
      ]);
      // Première lecture réussie : on complète l'historique et la courbe du jour avec les journaux de l'onduleur.
      if (firstSuccess) {
        void this.loadHistory();
      }
    }
    const s = this.settings();
    if (reading.error === null && reading.certFingerprint && !s.certFingerprint) {
      this.store.updateSettings({ inverter: { ...s, certFingerprint: reading.certFingerprint } });
    }
    if (reading.error === null && reading.totalWh !== null) {
      const at = toLocalIso(new Date(reading.at));
      const date = at.slice(0, 10);
      // Onduleurs SunSpec : pas de production du jour, déduite de l'index total.
      const dayWh = reading.dayWh ?? dayWhFromTotal(reading.totalWh, date, this.store.data().pvDaily);
      this.store.recordPvDay({
        date,
        dayKwh: Math.round(dayWh) / 1000,
        totalKwh: Math.round(reading.totalWh) / 1000,
        at,
      });
    }
  }
}
