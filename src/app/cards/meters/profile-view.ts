import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { parseHomeWizardCsv } from '../../core/calc/homewizard-csv';
import { dailyEnergy, dayQuarters } from '../../core/calc/meter-profile';
import { dayNumberToDate, toDayNumber, toLocalIso } from '../../core/calc/time';
import { DataStore } from '../../core/services/data-store.service';
import { InverterService, type PowerPoint } from '../../core/services/inverter.service';
import { StorageService } from '../../core/services/storage.service';
import { ToastService } from '../../core/services/toast.service';
import { fmt } from '../../shared/format';

const isoDay = (day: number): string => toLocalIso(dayNumberToDate(day)).slice(0, 10);
const DAY_TITLE = new Intl.DateTimeFormat('fr-BE', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

/**
 * Soutirage et injection au quart d'heure (profil tiré du lecteur P1 et des exports HomeWizard) : journée affichée,
 * période de l'historique et import des exports, partagés par les cadres de la page Compteurs et du tableau de bord.
 */
@Injectable({ providedIn: 'root' })
export class MeterProfileView {
  private readonly store = inject(DataStore);
  private readonly inverter = inject(InverterService);
  private readonly storage = inject(StorageService);
  private readonly toast = inject(ToastService);

  readonly profile = computed(() => this.store.data().meterProfile);
  readonly hasProfile = computed(() => this.profile().length > 0);

  // --- Journée ----------------------------------------------------------------------------------

  readonly today = computed(() => Math.floor(this.store.now()));
  /** Jour affiché ; `null` = aujourd'hui (suit le changement de date). */
  private readonly picked = signal<number | null>(null);
  readonly day = computed(() => this.picked() ?? this.today());
  readonly isToday = computed(() => this.day() === this.today());
  readonly dayIso = computed(() => isoDay(this.day()));
  readonly todayIso = computed(() => isoDay(this.today()));
  readonly firstIso = computed(() => this.profile()[0]?.date ?? this.todayIso());
  readonly dayTitle = computed(() => {
    const title = DAY_TITLE.format(dayNumberToDate(this.day()));
    return title.charAt(0).toUpperCase() + title.slice(1);
  });
  readonly quarters = computed(() => dayQuarters(this.profile(), this.dayIso()));
  readonly dayTotals = computed(() => {
    const q = this.quarters();
    if (q.length === 0) {
      return null;
    }
    return {
      importKwh: q.reduce((s, x) => s + x.importWh, 0) / 1000,
      exportKwh: q.reduce((s, x) => s + x.exportWh, 0) / 1000,
      estimated: q.filter((x) => x.estimated).length,
      covered: q.length,
    };
  });

  /** Courbe de production de l'onduleur pour la journée affichée (superposée au graphique). */
  private readonly pastCurve = signal<{ date: string; points: readonly PowerPoint[] } | null>(null);
  readonly pvPoints = computed<readonly PowerPoint[]>(() => {
    if (this.isToday()) {
      return this.inverter.todayCurve();
    }
    const curve = this.pastCurve();
    return curve?.date === this.dayIso() ? curve.points : [];
  });

  // --- Journées précédentes ---------------------------------------------------------------------

  readonly rangeOptions = [
    { label: '30 jours', days: 30 },
    { label: '90 jours', days: 90 },
    { label: '1 an', days: 365 },
  ] as const;
  readonly rangeDays = signal<number>(30);
  readonly days = computed(() =>
    dailyEnergy(this.profile(), isoDay(this.today() - this.rangeDays() + 1), this.todayIso()),
  );

  readonly importing = signal(false);

  constructor() {
    effect(() => {
      const date = this.dayIso();
      if (!this.isToday()) {
        untracked(() => void this.loadPvCurve(date));
      }
    });
  }

  showDay(day: number): void {
    const bounded = Math.min(day, this.today());
    this.picked.set(bounded === this.today() ? null : bounded);
  }

  /** Affiche la journée `AAAA-MM-JJ` (ignoré si la date est invalide). */
  showDate(date: string): void {
    const day = Math.floor(toDayNumber(date));
    if (Number.isFinite(day)) {
      this.showDay(day);
    }
  }

  step(delta: number): void {
    this.showDay(this.day() + delta);
  }

  /**
   * Importe un export CSV de l'app HomeWizard Energy : ses index mesurés complètent le profil et remplacent les
   * périodes estimées (Mac éteint, app fermée).
   */
  async importHomeWizard(): Promise<void> {
    const content = await this.storage.importFile('csv');
    if (content === null) {
      return;
    }
    this.importing.set(true);
    try {
      const parsed = parseHomeWizardCsv(content);
      if (parsed.error !== null) {
        this.toast.show(parsed.error, 'error');
        return;
      }
      const changed = this.store.importMeterProfile(parsed.days);
      const period = `du ${fmt.date(parsed.from)} au ${fmt.date(parsed.to)}`;
      this.toast.show(
        changed === 0
          ? `Export HomeWizard ${period} : rien de nouveau.`
          : `Export HomeWizard ${period} : ${changed} journée${changed > 1 ? 's' : ''} complétée${changed > 1 ? 's' : ''}${parsed.daily ? ' (totaux par jour seulement : exportez au quart d’heure pour le détail)' : ''}.`,
        changed === 0 ? 'info' : 'success',
      );
    } finally {
      this.importing.set(false);
    }
  }

  private async loadPvCurve(date: string): Promise<void> {
    if (!this.inverter.ready()) {
      return;
    }
    const curve = await this.inverter.dayCurve(date);
    if (date === this.dayIso() && curve.error === null) {
      this.pastCurve.set({ date, points: curve.points });
    }
  }
}
