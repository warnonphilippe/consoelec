import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import type { BillYear } from '../../core/calc/annual-history';
import type { AnnualBill, BillSchedule } from '../../core/models/app-data.model';
import { ConfirmService } from '../../core/services/confirm.service';
import { DataStore } from '../../core/services/data-store.service';
import { ToastService } from '../../core/services/toast.service';
import { FORMAT_PIPES } from '../../shared/format';
import { IconComponent } from '../../shared/icon.component';

/** Début de l'horaire actuel des heures creuses en Wallonie (22 h-7 h et 11 h-17 h). */
const CURRENT_SCHEDULE_FROM = '2026-01-01';

interface Draft {
  id: string | null;
  from: string;
  to: string;
  netPeak: string;
  netOff: string;
  schedule: BillSchedule;
  note: string;
}

const addYear = (date: string): string => `${Number(date.slice(0, 4)) + 1}${date.slice(4)}`;

/**
 * Factures annuelles des années passées (ancien compteur compris) : soldes jour / nuit facturés, production de
 * l'onduleur sur la même période et consommation de la maison qu'on en déduit, qui cale les prévisions.
 */
@Component({
  selector: 'app-annual-bills',
  imports: [IconComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './annual-bills.component.html',
  styleUrl: './annual-bills.component.css',
})
export class AnnualBillsComponent {
  protected readonly store = inject(DataStore);
  private readonly confirm = inject(ConfirmService);
  private readonly toast = inject(ToastService);

  protected readonly annual = computed(() => this.store.analysis().annual);
  /** Lignes du tableau, de la plus récente à la plus ancienne. */
  protected readonly rows = computed<BillYear[]>(() => [...(this.annual()?.years ?? [])].reverse());
  protected readonly draft = signal<Draft | null>(null);

  protected add(): void {
    const last = this.store.data().annualBills.at(-1);
    const from = last?.to ?? `${new Date().getFullYear() - 1}-${this.store.settings().billingStart}`;
    const to = addYear(from);
    this.draft.set({
      id: null,
      from,
      to,
      netPeak: '',
      netOff: '',
      schedule: to <= CURRENT_SCHEDULE_FROM ? 'legacy' : 'current',
      note: '',
    });
  }

  protected edit(bill: AnnualBill): void {
    this.draft.set({
      id: bill.id,
      from: bill.from,
      to: bill.to,
      netPeak: String(bill.netPeak),
      netOff: String(bill.netOff),
      schedule: bill.schedule,
      note: bill.note,
    });
  }

  protected patch(change: Partial<Draft>): void {
    this.draft.update((d) => (d ? { ...d, ...change } : d));
  }

  protected save(): void {
    const d = this.draft();
    if (!d) {
      return;
    }
    const number = (v: string) => Number(v.replace(/\s/g, '').replace(',', '.').replace('−', '-'));
    const netPeak = number(d.netPeak);
    const netOff = number(d.netOff);
    if (!d.from || !d.to || d.to <= d.from || !Number.isFinite(netPeak) || !Number.isFinite(netOff)) {
      this.toast.show('Indiquez une période valide et les deux soldes (jour et nuit).', 'error');
      return;
    }
    this.store.saveBill({
      ...(d.id ? { id: d.id } : {}),
      from: d.from,
      to: d.to,
      netPeak,
      netOff,
      schedule: d.schedule,
      note: d.note.trim(),
    });
    this.draft.set(null);
    this.toast.show('Facture annuelle enregistrée.');
  }

  protected async remove(bill: AnnualBill): Promise<void> {
    const ok = await this.confirm.ask({
      title: 'Supprimer cette facture ?',
      message: `Facture du ${bill.from} au ${bill.to}.`,
      confirmLabel: 'Supprimer',
      danger: true,
    });
    if (ok) {
      this.store.deleteBill(bill.id);
    }
  }

  protected period(bill: AnnualBill): string {
    return `${bill.from.slice(0, 4)}-${bill.to.slice(0, 4)}`;
  }
}
