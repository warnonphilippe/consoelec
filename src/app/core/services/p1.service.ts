import { DestroyRef, Injectable, computed, effect, inject, signal } from '@angular/core';
import type { P1Reading } from '../../../../electron/shared/ipc-contract';
import { p1Reader } from '../../../../electron/shared/p1-readers';
import { p1Identity } from '../../../../electron/shared/device-names';
import { toLocalIso } from '../calc/time';
import type { MeterLogPoint } from '../models/app-data.model';
import { DataStore } from './data-store.service';

/** Une lecture plus ancienne n'est plus « en direct » (le relevé ne la propose plus). */
const LIVE_MAX_AGE_MS = 5 * 60 * 1000;

/** Les quatre index d'une lecture réussie, à la minute de la lecture ; `null` si l'un manque. */
export function meterPointOf(r: P1Reading): MeterLogPoint | null {
  if (
    r.error !== null ||
    r.importPeak === null ||
    r.importOff === null ||
    r.exportPeak === null ||
    r.exportOff === null
  ) {
    return null;
  }
  return {
    at: toLocalIso(new Date(r.at)),
    importPeak: r.importPeak,
    importOff: r.importOff,
    exportPeak: r.exportPeak,
    exportOff: r.exportOff,
  };
}

/**
 * Lecture locale du compteur intelligent par le port P1 : transmet la configuration au process principal (qui
 * interroge le lecteur chaque minute), reçoit les mesures et ajoute les index au journal des données.
 */
@Injectable({ providedIn: 'root' })
export class P1Service {
  private readonly store = inject(DataStore);
  private readonly api = typeof window !== 'undefined' ? (window.consoElec?.p1 ?? null) : null;

  readonly available = this.api !== null;
  readonly live = signal<P1Reading | null>(null);
  readonly busy = signal(false);
  readonly discovering = signal(false);
  readonly settings = computed(() => this.store.settings().p1);
  /** Type de lecteur choisi. */
  readonly reader = computed(() => p1Reader(this.settings().kind));
  /** Association en cours (HomeWizard API v2 : attente de l'appui sur le bouton). */
  readonly pairing = signal(false);
  /** Prêt à interroger le lecteur : activé et adresse connue. */
  readonly ready = computed(() => this.settings().enabled && this.settings().host !== '');
  /** Dernière lecture réussie récente (moins de 5 min). */
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
    effect(() => {
      const s = this.settings();
      void this.api?.configure({
        enabled: s.enabled,
        kind: s.kind,
        host: s.host,
        port: s.port,
        certFingerprint: s.certFingerprint,
      });
    });
  }

  async refresh(): Promise<P1Reading | null> {
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
   * Cherche les lecteurs P1 du type choisi sur le réseau local et pré-remplit l'adresse si elle est vide (ou si
   * `replace`). Renvoie les noms trouvés.
   */
  async discover(replace = false): Promise<string[]> {
    const reader = this.reader();
    if (this.api === null || (reader.bonjour === null && !reader.scan)) {
      return [];
    }
    this.discovering.set(true);
    try {
      const hosts = await this.api.discover(this.settings().kind);
      const current = this.settings();
      // Le même lecteur en tête : il a pu changer de nom (suffixe `-2`) après un conflit sur le réseau.
      const id = p1Identity(current.host);
      if (id !== null) {
        hosts.sort((a, b) => Number(p1Identity(b) === id) - Number(p1Identity(a) === id));
      }
      const host = hosts[0];
      if (host !== undefined && (replace || current.host === '') && current.host !== host) {
        this.store.updateSettings({ p1: { ...current, host } });
      }
      return hosts;
    } finally {
      this.discovering.set(false);
    }
  }

  /**
   * Associe le lecteur HomeWizard (API v2) : le process principal attend l'appui sur le bouton, range le jeton dans le
   * Trousseau ; l'empreinte du certificat est épinglée ici. Lève une erreur lisible en cas d'échec.
   */
  async pair(): Promise<void> {
    if (this.api === null) {
      return;
    }
    this.pairing.set(true);
    try {
      const { certFingerprint } = await this.api.pair();
      this.store.updateSettings({ p1: { ...this.settings(), certFingerprint } });
      await this.refresh();
    } finally {
      this.pairing.set(false);
    }
  }

  private onReading(reading: P1Reading): void {
    // Le lecteur a été retrouvé sous un autre nom : on enregistre ce nom.
    if (reading.movedTo && reading.movedTo !== this.settings().host) {
      this.store.updateSettings({ p1: { ...this.settings(), host: reading.movedTo } });
    }
    this.live.set(reading);
    const point = meterPointOf(reading);
    if (point !== null && this.store.loaded()) {
      this.store.recordMeterPoint(point);
    }
  }
}
