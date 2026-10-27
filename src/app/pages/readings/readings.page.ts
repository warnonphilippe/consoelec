import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import type {
  Confidence,
  MeterPhoto,
  PhotoReading,
} from '../../../../electron/shared/ipc-contract';
import { AiService } from '../../core/ai/ai.service';
import { InverterService } from '../../core/services/inverter.service';
import { ANOMALY_LABELS } from '../../core/calc/csv';
import { type Interval } from '../../core/calc/consumption';
import { toDayNumber, toLocalIso } from '../../core/calc/time';
import { REGISTERS, type MeterReading, type RegisterKey } from '../../core/models/app-data.model';
import { ConfirmService } from '../../core/services/confirm.service';
import { DataStore } from '../../core/services/data-store.service';
import { ToastService } from '../../core/services/toast.service';
import { FORMAT_PIPES, fmt } from '../../shared/format';
import { IconComponent } from '../../shared/icon.component';
import { photoDataUrl, prepareMeterPhoto } from '../../shared/meter-image';
import { AnnualBillsComponent } from './annual-bills.component';

interface ReadingRow {
  readonly reading: MeterReading;
  readonly interval: Interval | null;
}

interface PreviewRow {
  readonly key: RegisterKey;
  readonly code: string;
  readonly label: string;
  readonly value: number;
  /** Variation depuis le relevé précédent (kWh) et par jour. */
  readonly sincePrevious: number | null;
  readonly perDay: number | null;
  /** Variation jusqu'au relevé suivant, si on insère un relevé dans le passé. */
  readonly untilNext: number | null;
  readonly problem: boolean;
}

interface PhotoItem {
  readonly name: string;
  readonly url: string;
  readonly photo: MeterPhoto;
}

type FormKey = RegisterKey | 'pvTotal';

@Component({
  selector: 'app-readings-page',
  imports: [ReactiveFormsModule, RouterLink, DatePipe, IconComponent, AnnualBillsComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './readings.page.html',
  styleUrl: './readings.page.css',
})
export default class ReadingsPage {
  protected readonly store = inject(DataStore);
  protected readonly ai = inject(AiService);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  private readonly fb = inject(FormBuilder).nonNullable;
  protected readonly inverter = inject(InverterService);
  /** Index de production lu sur l'onduleur il y a moins de 2 h (kWh), proposé dans le relevé. */
  protected readonly inverterTotal = computed(() => {
    const r = this.inverter.fresh();
    return r?.totalWh !== null && r?.totalWh !== undefined
      ? { kwh: Math.round(r.totalWh) / 1000, at: r.at }
      : null;
  });

  protected readonly registers = REGISTERS;
  protected readonly editingId = signal<string | null>(null);
  /** Le relevé en cours de saisie provient d'une photo lue par Claude (vérifiée par l'utilisateur). */
  private readonly fromPhoto = signal(false);

  protected readonly form = this.fb.group({
    date: [toLocalIso(new Date()), Validators.required],
    importPeak: [null as number | null, [Validators.required, Validators.min(0)]],
    importOff: [null as number | null, [Validators.required, Validators.min(0)]],
    exportPeak: [null as number | null, [Validators.required, Validators.min(0)]],
    exportOff: [null as number | null, [Validators.required, Validators.min(0)]],
    pvTotal: [null as number | null, Validators.min(0)],
    meterChange: [false],
    note: [''],
  });

  private readonly value = toSignal(this.form.valueChanges, {
    initialValue: this.form.getRawValue(),
  });

  constructor() {
    // Nouveau relevé : la production totale est pré-remplie avec l'index lu sur l'onduleur.
    effect(() => {
      const total = this.inverterTotal();
      if (
        total !== null &&
        this.editingId() === null &&
        this.form.controls.pvTotal.value === null
      ) {
        this.form.controls.pvTotal.setValue(total.kwh);
      }
    });
  }

  protected readonly canSave = computed(() => {
    const v = this.value();
    return (
      this.form.controls.date.valid && REGISTERS.every((r) => isNum(v[r.key]) && v[r.key]! >= 0)
    );
  });

  /** Aperçu en direct : variation de chaque index par rapport aux relevés voisins. */
  protected readonly preview = computed<PreviewRow[] | null>(() => {
    const v = this.value();
    if (!REGISTERS.every((r) => isNum(v[r.key]))) {
      return null;
    }
    const day = toDayNumber(v.date ?? '');
    const levels = this.store
      .analysis()
      .consumption.levels.filter((l) => l.reading.id !== this.editingId());
    const previous = levels.filter((l) => l.day < day).at(-1);
    const next = levels.find((l) => l.day > day);
    return REGISTERS.map((r) => {
      const value = v[r.key]!;
      const since = previous ? value - previous.values[r.key]! : null;
      const until = next ? next.values[r.key]! - value : null;
      const days = previous ? day - previous.day : 0;
      return {
        key: r.key,
        code: r.code,
        label: r.short,
        value,
        sincePrevious: since,
        perDay: since !== null && since >= 0 && days >= 1 ? since / days : null,
        untilNext: until,
        problem: (since !== null && since < 0) || (until !== null && until < 0),
      };
    });
  });

  protected readonly hasProblem = computed(() => this.preview()?.some((p) => p.problem) === true);

  protected readonly rows = computed<ReadingRow[]>(() => {
    const consumption = this.store.analysis().consumption;
    const byTo = new Map(consumption.intervals.map((i) => [i.to.reading.id, i]));
    return consumption.levels
      .map((l) => ({ reading: l.reading, interval: byTo.get(l.reading.id) ?? null }))
      .reverse();
  });

  protected readonly anomalies = computed(() => this.store.analysis().consumption.anomalyCount);
  protected readonly estimates = computed(() => this.store.analysis().currentIndices);

  // --- Lecture par photo ---
  protected readonly photos = signal<PhotoItem[]>([]);
  protected readonly photoBusy = signal(false);
  protected readonly photoError = signal<string | null>(null);
  protected readonly photoResult = signal<PhotoReading | null>(null);
  protected readonly dragging = signal(false);
  protected readonly canReadPhoto = computed(() => this.ai.available && this.ai.hasKey());

  protected confidenceOf(key: FormKey): Confidence | null {
    return this.photoResult()?.confidence[key] ?? null;
  }

  protected useEstimate(): void {
    const e = this.estimates();
    if (e === null) {
      return;
    }
    this.form.patchValue({
      importPeak: Math.round(e.importPeak),
      importOff: Math.round(e.importOff),
      exportPeak: Math.round(e.exportPeak),
      exportOff: Math.round(e.exportOff),
    });
  }

  protected save(): void {
    if (!this.canSave()) {
      this.form.markAllAsTouched();
      return;
    }
    const v = this.form.getRawValue();
    const id = this.editingId();
    const existing = id ? this.store.data().readings.find((r) => r.id === id) : undefined;
    this.store.saveReading({
      ...(id ? { id } : {}),
      date: v.date,
      importPeak: v.importPeak!,
      importOff: v.importOff!,
      exportPeak: v.exportPeak!,
      exportOff: v.exportOff!,
      pvTotal: isNum(v.pvTotal) ? v.pvTotal : null,
      meterChange: v.meterChange,
      source: this.fromPhoto() ? 'photo' : (existing?.source ?? 'manual'),
      note: v.note.trim(),
    });
    this.toast.show(id ? 'Relevé modifié.' : `Relevé du ${fmt.dateTime(v.date)} enregistré.`);
    this.resetForm();
  }

  protected edit(reading: MeterReading): void {
    this.editingId.set(reading.id);
    this.fromPhoto.set(false);
    this.clearPhotos();
    this.form.setValue({
      date: reading.date,
      importPeak: reading.importPeak,
      importOff: reading.importOff,
      exportPeak: reading.exportPeak,
      exportOff: reading.exportOff,
      pvTotal: reading.pvTotal,
      meterChange: reading.meterChange,
      note: reading.note,
    });
    document.querySelector('.content')?.scrollTo({ top: 0, behavior: 'smooth' });
  }

  protected async remove(reading: MeterReading): Promise<void> {
    const ok = await this.confirm.ask({
      title: 'Supprimer ce relevé ?',
      message: `Le relevé du ${fmt.dateTime(reading.date)} sera supprimé. Les statistiques seront recalculées.`,
      confirmLabel: 'Supprimer',
      danger: true,
    });
    if (ok) {
      this.store.deleteReading(reading.id);
      if (this.editingId() === reading.id) {
        this.resetForm();
      }
      this.toast.show('Relevé supprimé.');
    }
  }

  protected resetForm(): void {
    this.editingId.set(null);
    this.fromPhoto.set(false);
    this.clearPhotos();
    this.form.reset({
      date: toLocalIso(new Date()),
      importPeak: null,
      importOff: null,
      exportPeak: null,
      exportOff: null,
      pvTotal: this.inverterTotal()?.kwh ?? null,
      meterChange: false,
      note: '',
    });
  }

  protected anomalyText(interval: Interval): string {
    return interval.anomalies.map((a) => ANOMALY_LABELS[a]).join(', ');
  }

  protected isAnomaly(interval: Interval | null): boolean {
    return (
      interval !== null && interval.anomalies.some((a) => a !== 'long' && a !== 'meter-change')
    );
  }

  // --- Photos ---
  protected onFilePick(event: Event): void {
    const input = event.target as HTMLInputElement;
    void this.addFiles(Array.from(input.files ?? []));
    input.value = '';
  }

  protected onDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(false);
    void this.addFiles(Array.from(event.dataTransfer?.files ?? []));
  }

  protected onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(true);
  }

  protected removePhoto(index: number): void {
    this.photos.update((list) => list.filter((_, i) => i !== index));
    this.photoResult.set(null);
  }

  protected clearPhotos(): void {
    this.photos.set([]);
    this.photoResult.set(null);
    this.photoError.set(null);
  }

  private async addFiles(files: File[]): Promise<void> {
    if (files.length === 0) {
      return;
    }
    this.photoError.set(null);
    this.photoBusy.set(true);
    try {
      const api = typeof window !== 'undefined' ? (window.consoElec ?? null) : null;
      const added: PhotoItem[] = [];
      for (const file of files.slice(0, 4 - this.photos().length)) {
        const photo = await prepareMeterPhoto(file, api);
        added.push({ name: file.name, url: photoDataUrl(photo), photo });
      }
      this.photos.update((list) => [...list, ...added]);
      this.photoResult.set(null);
      if (this.canReadPhoto()) {
        await this.readPhotos();
      }
    } catch (error) {
      this.photoError.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.photoBusy.set(false);
    }
  }

  protected async readPhotos(): Promise<void> {
    const photos = this.photos();
    if (photos.length === 0) {
      return;
    }
    this.photoError.set(null);
    this.photoBusy.set(true);
    try {
      const reading = await this.ai.readMeter(photos.map((p) => p.photo));
      this.photoResult.set(reading);
      this.fromPhoto.set(true);
      const patch: Partial<Record<FormKey, number>> = {};
      for (const key of [...REGISTERS.map((r) => r.key), 'pvTotal'] as FormKey[]) {
        const found = reading[key];
        if (found !== null) {
          patch[key] = found;
        }
      }
      this.form.patchValue(patch);
    } catch (error) {
      this.photoError.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.photoBusy.set(false);
    }
  }

  protected useDisplayedDate(): void {
    const date = this.photoResult()?.displayedDate;
    if (date) {
      this.form.controls.date.setValue(date);
    }
  }
}

function isNum(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
