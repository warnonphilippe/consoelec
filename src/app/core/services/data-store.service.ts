import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { analyze } from '../calc/analysis';
import { buildDemoData } from '../calc/demo-data';
import { dateToDayNumber } from '../calc/time';
import {
  DEFAULT_HOUSE,
  emptyData,
  type AppData,
  type House,
  type MeterReading,
  type Settings,
} from '../models/app-data.model';
import { mergeData, type MergeReport, type MergeResult } from '../models/merge';
import { newId, normalizeData } from '../models/normalize';
import { StorageService } from './storage.service';
import { ToastService } from './toast.service';

const SAVE_DELAY_MS = 300;

/** État de l'application (signals) et persistance automatique. */
@Injectable({ providedIn: 'root' })
export class DataStore {
  private readonly storage = inject(StorageService);
  private readonly toast = inject(ToastService);

  private readonly state = signal<AppData>(emptyData());
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  readonly data = this.state.asReadonly();
  readonly loaded = signal(false);
  readonly filePath = signal<string | null>(null);
  readonly saving = signal(false);
  readonly saveError = signal<string | null>(null);

  /** Instant présent (numéro de jour), rafraîchi chaque minute. */
  readonly now = signal(dateToDayNumber(new Date()));

  readonly house = computed(() => this.state().house);
  readonly settings = computed(() => this.state().settings);
  /** Relevés du plus récent au plus ancien. */
  readonly readings = computed(() =>
    this.state()
      .readings.slice()
      .sort((a, b) => b.date.localeCompare(a.date)),
  );
  readonly analysis = computed(() => analyze(this.state(), this.now()));

  constructor() {
    const timer = setInterval(() => this.now.set(dateToDayNumber(new Date())), 60_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  async init(): Promise<void> {
    try {
      const stored = await this.storage.load();
      this.filePath.set(stored.path);
      if (stored.content !== null) {
        this.state.set(normalizeData(JSON.parse(stored.content)));
      }
      if (stored.recoveredFromBackup) {
        this.toast.show(
          'Le fichier de données était illisible : la copie de secours a été restaurée.',
          'warning',
        );
      }
    } catch (error) {
      this.toast.show(`Impossible de lire les données : ${message(error)}`, 'error');
    } finally {
      this.loaded.set(true);
    }
  }

  updateHouse(patch: Partial<House>): void {
    this.update((d) => ({ ...d, house: { ...d.house, ...patch } }));
  }

  updateSettings(patch: Partial<Settings>): void {
    this.update((d) => ({ ...d, settings: { ...d.settings, ...patch } }));
  }

  saveReading(reading: Omit<MeterReading, 'id'> & { id?: string }): void {
    const entry: MeterReading = { ...reading, id: reading.id ?? newId() };
    this.update((d) => ({ ...d, readings: upsert(d.readings, entry) }));
  }

  deleteReading(id: string): void {
    this.update((d) => ({ ...d, readings: d.readings.filter((r) => r.id !== id) }));
  }

  /** Lit et valide un fichier exporté (lève une erreur s'il n'est pas reconnu). */
  parseImport(content: string): AppData {
    return normalizeData(JSON.parse(content));
  }

  /** Aperçu de la fusion d'un fichier importé avec les données locales, sans rien modifier. */
  previewMerge(incoming: AppData): MergeResult {
    return mergeData(this.state(), incoming, this.houseIsDefault());
  }

  /** Ajoute les relevés absents du fichier ; les données locales restent intactes. */
  mergeImport(incoming: AppData): MergeReport {
    const result = mergeData(this.state(), incoming, this.houseIsDefault());
    this.update(() => result.data);
    return result.report;
  }

  /** Fusionne des relevés seuls (import CSV). */
  mergeReadings(readings: MeterReading[]): MergeReport {
    return this.mergeImport({ ...this.state(), readings, house: this.state().house });
  }

  /** Remplace toutes les données par celles du fichier (le thème et le modèle IA locaux sont conservés). */
  replaceWithImport(incoming: AppData): void {
    this.update((d) => ({
      ...incoming,
      settings: { ...incoming.settings, theme: d.settings.theme, aiModel: d.settings.aiModel },
    }));
  }

  loadDemo(): void {
    const demo = buildDemoData(new Date());
    this.update((d) => ({
      ...demo,
      settings: { ...demo.settings, theme: d.settings.theme, aiModel: d.settings.aiModel },
    }));
  }

  reset(): void {
    this.update((d) => ({
      ...emptyData(),
      settings: { ...emptyData().settings, theme: d.settings.theme, aiModel: d.settings.aiModel },
    }));
  }

  exportJson(): string {
    return JSON.stringify(this.state(), null, 2);
  }

  /** La description de la maison n'a jamais été modifiée (importer celle d'un autre ordinateur est alors sans risque). */
  private houseIsDefault(): boolean {
    return JSON.stringify(this.state().house) === JSON.stringify(DEFAULT_HOUSE);
  }

  private update(change: (data: AppData) => AppData): void {
    this.state.update(change);
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => void this.flush(), SAVE_DELAY_MS);
  }

  async flush(): Promise<void> {
    this.saveTimer = null;
    this.saving.set(true);
    try {
      await this.storage.save(this.exportJson());
      this.saveError.set(null);
    } catch (error) {
      this.saveError.set(message(error));
      this.toast.show(`Échec de l'enregistrement : ${message(error)}`, 'error');
    } finally {
      this.saving.set(false);
    }
  }
}

function upsert<T extends { id: string }>(list: T[], entry: T): T[] {
  const index = list.findIndex((item) => item.id === entry.id);
  return index === -1 ? [...list, entry] : list.map((item, i) => (i === index ? entry : item));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
