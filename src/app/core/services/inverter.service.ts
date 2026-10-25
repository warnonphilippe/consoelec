import { DestroyRef, Injectable, computed, effect, inject, signal } from '@angular/core';
import type { InverterReading } from '../../../../electron/shared/ipc-contract';
import { toLocalIso } from '../calc/time';
import { DataStore } from './data-store.service';
import { VaultService } from './vault.service';

/** Une lecture plus ancienne n'est plus « en direct » (le relevé ne la propose plus). */
const LIVE_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/**
 * Lecture locale de l'onduleur : transmet la configuration au process principal (qui interroge l'onduleur toutes les
 * 60 s), reçoit les mesures, enregistre la production du jour et épingle le certificat à la première connexion.
 */
@Injectable({ providedIn: 'root' })
export class InverterService {
  private readonly store = inject(DataStore);
  private readonly vault = inject(VaultService);
  private readonly api =
    typeof window !== 'undefined' ? (window.consoElec?.inverter ?? null) : null;

  readonly available = this.api !== null;
  readonly live = signal<InverterReading | null>(null);
  readonly busy = signal(false);
  readonly settings = computed(() => this.store.settings().inverter);
  /** Prêt à interroger l'onduleur : activé, clé dans le coffre ouvert. */
  readonly ready = computed(() => this.settings().enabled && this.vault.has('inverterPsk'));
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
    effect(() => {
      const s = this.settings();
      // Relancé aussi quand le coffre s'ouvre ou que la clé change.
      this.vault.status();
      void this.api?.configure({
        enabled: s.enabled,
        host: s.host,
        certFingerprint: s.certFingerprint,
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

  /** Oublie l'empreinte du certificat (après un remplacement de l'onduleur ou de son certificat). */
  resetPin(): void {
    this.store.updateSettings({ inverter: { ...this.settings(), certFingerprint: null } });
  }

  private onReading(reading: InverterReading): void {
    this.live.set(reading);
    const s = this.settings();
    if (reading.error === null && reading.certFingerprint && !s.certFingerprint) {
      this.store.updateSettings({ inverter: { ...s, certFingerprint: reading.certFingerprint } });
    }
    if (reading.error === null && reading.totalWh !== null && reading.dayWh !== null) {
      const at = toLocalIso(new Date(reading.at));
      this.store.recordPvDay({
        date: at.slice(0, 10),
        dayKwh: Math.round(reading.dayWh) / 1000,
        totalKwh: Math.round(reading.totalWh) / 1000,
        at,
      });
    }
  }
}
