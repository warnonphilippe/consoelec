import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { AiService } from '../../core/ai/ai.service';
import { parseReadingsCsv } from '../../core/calc/csv-import';
import { intervalsCsv, monthlyCsv, readingsCsv } from '../../core/calc/csv';
import { UCCLE_DEGREE_DAYS } from '../../core/calc/degree-days';
import { MONTH_SHORT } from '../../core/calc/time';
import {
  AI_MODELS,
  LEGACY_OFF_PEAK,
  WALLONIA_2026_OFF_PEAK,
  REFERENCE_PRESETS,
  type AppData,
  type Presence,
  type ReferencePreset,
  type Settings,
  type ThemeMode,
} from '../../core/models/app-data.model';
import type { MergeReport } from '../../core/models/merge';
import { ConfirmService } from '../../core/services/confirm.service';
import { InverterService } from '../../core/services/inverter.service';
import { P1Service } from '../../core/services/p1.service';
import { SecretsService } from '../../core/services/secrets.service';
import { DataStore } from '../../core/services/data-store.service';
import { StorageService } from '../../core/services/storage.service';
import { ThemeService } from '../../core/services/theme.service';
import { ToastService } from '../../core/services/toast.service';
import { FORMAT_PIPES } from '../../shared/format';
import {
  INVERTER_BRANDS,
  effectivePort,
  inverterBrand,
  isInverterBrand,
} from '../../../../electron/shared/inverter-brands';
import { IconComponent, type IconName } from '../../shared/icon.component';

type NumericSetting =
  | 'referenceAnnualKwh'
  | 'winterSharePct'
  | 'specificYieldKwhPerKwp'
  | 'priceHp'
  | 'priceHc';

@Component({
  selector: 'app-settings-page',
  imports: [IconComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './settings.page.html',
  styleUrl: './settings.page.css',
})
export default class SettingsPage {
  protected readonly store = inject(DataStore);
  protected readonly storage = inject(StorageService);
  protected readonly theme = inject(ThemeService);
  protected readonly ai = inject(AiService);
  protected readonly secrets = inject(SecretsService);
  protected readonly inverter = inject(InverterService);
  protected readonly inverterSettings = computed(() => this.settings().inverter);
  protected readonly p1 = inject(P1Service);
  protected readonly p1Settings = computed(() => this.settings().p1);
  /** Phrase de passe de la clé SSH, pour l'import unique de l'ancien coffre. */
  protected readonly vaultPass = signal('');
  protected readonly importBusy = signal(false);
  protected readonly importError = signal<string | null>(null);
  protected readonly pskDraft = signal('');
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);

  protected readonly settings = this.store.settings;
  protected readonly monthShort = MONTH_SHORT;
  protected readonly degreeDays = UCCLE_DEGREE_DAYS;
  protected readonly models = AI_MODELS;
  protected readonly presences: { value: Presence; label: string; hint: string }[] = [
    { value: 'absent', label: 'Absents', hint: 'Personne à la maison en journée (école, travail)' },
    { value: 'partial', label: 'Partiellement', hint: 'Quelqu’un de temps en temps' },
    { value: 'home', label: 'À la maison', hint: 'Télétravail ou présence en journée' },
  ];

  protected readonly presets = (
    Object.keys(REFERENCE_PRESETS) as Exclude<ReferencePreset, 'custom'>[]
  ).map((key) => ({
    key,
    ...REFERENCE_PRESETS[key],
  }));

  protected readonly themeModes: { mode: ThemeMode; icon: IconName; label: string }[] = [
    { mode: 'light', icon: 'sun', label: 'Clair' },
    { mode: 'dark', icon: 'moon', label: 'Sombre' },
    { mode: 'system', icon: 'monitor', label: 'Système' },
  ];

  protected readonly analysis = this.store.analysis;
  protected readonly consumptionProfile = computed(() => this.analysis().reference.consumption);
  protected readonly consumptionMax = computed(() => Math.max(...this.consumptionProfile()));
  protected readonly productionProfile = computed(() => this.analysis().reference.production);
  protected readonly productionMax = computed(() => Math.max(...this.productionProfile(), 1));

  protected readonly pendingImport = signal<{ incoming: AppData; report: MergeReport } | null>(
    null,
  );
  private readonly importDialog = viewChild<ElementRef<HTMLDialogElement>>('importDialog');

  protected readonly counts = computed(() => ({ readings: this.store.data().readings.length }));

  // --- Clé API ---
  protected readonly keyDraft = signal('');
  protected readonly keyBusy = signal(false);
  protected readonly testResult = signal<{ ok: boolean; message: string } | null>(null);

  constructor() {
    effect(() => {
      const dialog = this.importDialog()?.nativeElement;
      if (!dialog) {
        return;
      }
      if (this.pendingImport() && !dialog.open) {
        dialog.showModal();
      } else if (!this.pendingImport() && dialog.open) {
        dialog.close();
      }
    });
  }

  protected selectPreset(key: Exclude<ReferencePreset, 'custom'>): void {
    this.store.updateSettings({
      referencePreset: key,
      referenceAnnualKwh: REFERENCE_PRESETS[key].kwh,
    });
  }

  protected setNumber(field: NumericSetting, event: Event, min: number, max: number): void {
    const value = (event.target as HTMLInputElement).valueAsNumber;
    if (!Number.isFinite(value)) {
      return;
    }
    const clamped = Math.min(max, Math.max(min, value));
    const patch: Partial<Settings> =
      field === 'referenceAnnualKwh'
        ? { referenceAnnualKwh: clamped, referencePreset: 'custom' }
        : { [field]: clamped };
    this.store.updateSettings(patch);
  }

  protected setPresence(presence: Presence): void {
    this.store.updateSettings({ presence });
  }

  protected readonly hours = Array.from({ length: 24 }, (_, h) => h);

  protected toggleHour(hour: number): void {
    const current = this.settings().offPeakHours;
    const next = current.includes(hour) ? current.filter((h) => h !== hour) : [...current, hour];
    this.store.updateSettings({ offPeakHours: next.sort((a, b) => a - b) });
  }

  protected applyOffPeak(preset: 'wallonia2026' | 'legacy'): void {
    this.store.updateSettings(
      preset === 'wallonia2026'
        ? { offPeakHours: [...WALLONIA_2026_OFF_PEAK], offPeakWeekends: false }
        : { offPeakHours: [...LEGACY_OFF_PEAK], offPeakWeekends: true },
    );
  }

  protected readonly billingDays = Array.from({ length: 31 }, (_, i) => i + 1);
  protected readonly billingMonths = Array.from({ length: 12 }, (_, i) => ({
    value: i + 1,
    label: new Intl.DateTimeFormat('fr-BE', { month: 'long' }).format(new Date(2026, i, 1)),
  }));
  protected readonly billingMonth = computed(() => Number(this.settings().billingStart.slice(0, 2)));
  protected readonly billingDay = computed(() => Number(this.settings().billingStart.slice(3, 5)));

  /** Début de l'année de facturation (`MM-JJ`), jour ramené au dernier jour du mois s'il le dépasse. */
  protected setBillingStart(event: Event, part: 'day' | 'month'): void {
    const value = Number((event.target as HTMLSelectElement).value);
    const month = part === 'month' ? value : this.billingMonth();
    const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    const day = Math.min(part === 'day' ? value : this.billingDay(), lengths[month - 1]!);
    const pad = (n: number) => String(n).padStart(2, '0');
    this.store.updateSettings({ billingStart: `${pad(month)}-${pad(day)}` });
  }

  protected setWeekends(event: Event): void {
    this.store.updateSettings({ offPeakWeekends: (event.target as HTMLInputElement).checked });
  }

  protected setModel(event: Event): void {
    this.store.updateSettings({ aiModel: (event.target as HTMLSelectElement).value });
    this.testResult.set(null);
  }

  // --- Clés ---
  protected async importVault(): Promise<void> {
    if (this.vaultPass() === '' || this.importBusy()) {
      return;
    }
    this.importBusy.set(true);
    this.importError.set(null);
    try {
      await this.secrets.importVault(this.vaultPass());
      this.vaultPass.set('');
      this.toast.show('Clés reprises dans le Trousseau ; l’ancien coffre est supprimé.');
    } catch (error) {
      this.importError.set(cleanError(error));
    } finally {
      this.importBusy.set(false);
    }
  }

  // --- Onduleur ---
  protected readonly inverterBrands = INVERTER_BRANDS;
  /** Port habituel de la marque, compte tenu de la clé Solarman. */
  protected readonly defaultInverterPort = computed(() => {
    const s = this.inverterSettings();
    return String(effectivePort(inverterBrand(s.brand), null, s.loggerSerial));
  });

  protected setInverterBrand(event: Event): void {
    const brand = (event.target as HTMLSelectElement).value;
    if (!isInverterBrand(brand) || brand === this.inverterSettings().brand) {
      return;
    }
    // Autre marque : autre appareil, autres réglages. Le secret enregistré est gardé (retour à la marque précédente) :
    // une marque qui en demande un autre le signale à la connexion.
    this.store.updateSettings({
      inverter: {
        ...this.inverterSettings(),
        brand,
        host: '',
        certFingerprint: null,
        port: null,
        unitId: null,
        loggerSerial: null,
      },
    });
    this.inverter.live.set(null);
    if (inverterBrand(brand).discovery === 'bonjour') {
      void this.inverter.discover();
    }
  }

  protected setInverterNumber(event: Event, key: 'port' | 'unitId', max: number): void {
    const input = event.target as HTMLInputElement;
    const text = input.value.trim();
    const value = text === '' ? null : Number(text);
    if (value !== null && (!Number.isInteger(value) || value < 0 || value > max)) {
      this.toast.show(`Valeur invalide : un entier de 0 à ${max}, ou vide pour la valeur habituelle.`, 'error');
      input.value = String(this.inverterSettings()[key] ?? '');
      return;
    }
    this.store.updateSettings({ inverter: { ...this.inverterSettings(), [key]: value } });
  }

  protected setInverterSerial(event: Event): void {
    const input = event.target as HTMLInputElement;
    const text = input.value.replace(/\s/g, '');
    if (text !== '' && !/^\d{1,10}$/.test(text)) {
      this.toast.show('Numéro de série de la clé : jusqu’à 10 chiffres, sur son étiquette.', 'error');
      input.value = this.inverterSettings().loggerSerial ?? '';
      return;
    }
    this.store.updateSettings({ inverter: { ...this.inverterSettings(), loggerSerial: text || null } });
  }

  protected setInverterEnabled(event: Event): void {
    this.store.updateSettings({
      inverter: { ...this.inverterSettings(), enabled: (event.target as HTMLInputElement).checked },
    });
  }

  protected setInverterHost(event: Event): void {
    const host = (event.target as HTMLInputElement).value.trim();
    // Autre appareil : l'ancienne empreinte de certificat ne vaut plus.
    this.store.updateSettings({
      inverter: { ...this.inverterSettings(), host, certFingerprint: null },
    });
  }

  protected async savePsk(): Promise<void> {
    const draft = this.pskDraft();
    // Clé de plaque SMA : espaces et tirets de la plaque retirés ; jeton Enphase : gardé tel quel.
    const value = this.inverter.brand().id === 'sma' ? draft.replace(/[\s-]/g, '') : draft.trim();
    if (value === '') {
      return;
    }
    try {
      await this.secrets.setSecret('inverterPsk', value);
      this.pskDraft.set('');
      this.toast.show(`${this.inverter.brand().secret?.label ?? 'Clé'} : enregistré dans le Trousseau.`);
      if (this.inverterSettings().enabled) {
        await this.inverter.refresh();
      }
    } catch (error) {
      this.toast.show(cleanError(error), 'error');
    }
  }

  protected async discoverInverter(): Promise<void> {
    const hosts = await this.inverter.discover(true);
    this.toast.show(
      hosts.length === 0
        ? `Aucun onduleur ${this.inverter.brand().label} trouvé sur le réseau : vérifiez qu’il est connecté au même réseau que ce Mac et que la lecture locale est activée.`
        : `Onduleur trouvé : ${hosts.join(', ')}`,
      hosts.length === 0 ? 'warning' : 'success',
    );
  }

  protected async testInverter(): Promise<void> {
    await this.inverter.refresh();
  }

  // --- Compteur (port P1) ---
  protected async setP1Enabled(event: Event): Promise<void> {
    const enabled = (event.target as HTMLInputElement).checked;
    this.store.updateSettings({ p1: { ...this.p1Settings(), enabled } });
    if (enabled && this.p1Settings().host === '') {
      await this.discoverP1();
    }
  }

  protected setP1Host(event: Event): void {
    const host = (event.target as HTMLInputElement).value.trim();
    this.store.updateSettings({ p1: { ...this.p1Settings(), host } });
  }

  protected async discoverP1(): Promise<void> {
    const hosts = await this.p1.discover(true);
    this.toast.show(
      hosts.length === 0
        ? 'Aucun lecteur P1 HomeWizard trouvé sur le réseau : vérifiez qu’il est connecté au même Wi-Fi que ce Mac.'
        : `Lecteur P1 trouvé : ${hosts.join(', ')}`,
      hosts.length === 0 ? 'warning' : 'success',
    );
  }

  // --- Clé API ---
  protected async saveKey(): Promise<void> {
    const key = this.keyDraft().trim();
    if (key === '') {
      return;
    }
    this.keyBusy.set(true);
    try {
      await this.ai.setKey(key);
      this.keyDraft.set('');
      this.testResult.set(null);
      this.toast.show('Clé API enregistrée (chiffrée sur cet ordinateur).');
    } catch (error) {
      this.toast.show(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      this.keyBusy.set(false);
    }
  }

  protected async removeKey(): Promise<void> {
    const ok = await this.confirm.ask({
      title: 'Supprimer la clé API ?',
      message:
        'L’assistant IA et la lecture des photos seront désactivés jusqu’à ce que vous enregistriez une nouvelle clé.',
      confirmLabel: 'Supprimer',
      danger: true,
    });
    if (ok) {
      await this.ai.clearKey();
      this.testResult.set(null);
      this.toast.show('Clé API supprimée.', 'info');
    }
  }

  protected async testKey(): Promise<void> {
    this.keyBusy.set(true);
    this.testResult.set(null);
    try {
      this.testResult.set(await this.ai.test());
    } catch (error) {
      this.testResult.set({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.keyBusy.set(false);
    }
  }

  // --- Export / import ---
  protected async exportJson(): Promise<void> {
    const name = `consoelec-${new Date().toISOString().slice(0, 10)}.json`;
    const path = await this.storage.exportFile(this.store.exportJson(), name, 'json');
    if (path) {
      this.toast.show(
        path === 'download' ? 'Sauvegarde téléchargée.' : `Sauvegarde enregistrée : ${path}`,
      );
    }
  }

  protected async exportCsv(kind: 'readings' | 'months' | 'intervals'): Promise<void> {
    const analysis = this.store.analysis();
    const data = this.store.data();
    const content =
      kind === 'readings'
        ? readingsCsv(data.readings)
        : kind === 'months'
          ? monthlyCsv(analysis.years)
          : intervalsCsv(analysis.consumption);
    const names = {
      readings: 'releves',
      months: 'consommation-mensuelle',
      intervals: 'entre-releves',
    };
    const path = await this.storage.exportFile(content, `consoelec-${names[kind]}.csv`, 'csv');
    if (path) {
      this.toast.show(path === 'download' ? 'Fichier CSV téléchargé.' : `CSV enregistré : ${path}`);
    }
  }

  /** Choix d'un fichier exporté, puis aperçu de ce qu'il apporte avant de l'appliquer. */
  protected async importJson(): Promise<void> {
    const content = await this.storage.importFile('json');
    if (content === null) {
      return;
    }
    try {
      const incoming = this.store.parseImport(content);
      this.pendingImport.set({ incoming, report: this.store.previewMerge(incoming).report });
    } catch (error) {
      this.toast.show(
        `Import impossible : ${error instanceof Error ? error.message : error}`,
        'error',
      );
    }
  }

  /** Import d'un CSV de relevés (export de ConsoElec ou tableau Excel) : fusion avec aperçu. */
  protected async importCsv(): Promise<void> {
    const content = await this.storage.importFile('csv');
    if (content === null) {
      return;
    }
    const { readings, errors } = parseReadingsCsv(content);
    if (errors.length > 0) {
      const first = errors
        .slice(0, 3)
        .map((e) => `ligne ${e.line} : ${e.message}`)
        .join(' · ');
      this.toast.show(
        `${errors.length} ligne(s) ignorée(s) — ${first}`,
        readings.length > 0 ? 'warning' : 'error',
      );
    }
    if (readings.length === 0) {
      return;
    }
    const incoming: AppData = { ...this.store.data(), readings };
    this.pendingImport.set({ incoming, report: this.store.previewMerge(incoming).report });
  }

  protected cancelImport(): void {
    this.pendingImport.set(null);
  }

  protected applyMerge(): void {
    const pending = this.pendingImport();
    if (!pending) {
      return;
    }
    const report = this.store.mergeImport(pending.incoming);
    this.pendingImport.set(null);
    const added = report.addedReadings + report.addedBills + report.addedMeterDays;
    const meterDays =
      report.addedMeterDays > 0 ? `, ${report.addedMeterDays} jour(s) d'index du compteur P1` : '';
    this.toast.show(
      added > 0
        ? `${report.addedReadings} relevé(s)${meterDays} et ${report.addedBills} facture(s) annuelle(s) ajouté(s) ; vos données existantes sont inchangées.`
        : 'Rien de nouveau dans ce fichier : vos données sont déjà à jour.',
      added > 0 ? 'success' : 'info',
    );
  }

  protected async applyReplace(): Promise<void> {
    const pending = this.pendingImport();
    if (!pending) {
      return;
    }
    this.pendingImport.set(null);
    const ok = await this.confirm.ask({
      title: 'Remplacer toutes les données ?',
      message:
        'La maison, les relevés et les réglages de cet ordinateur seront remplacés par le contenu du fichier. ' +
        'Les relevés absents du fichier seront perdus.',
      confirmLabel: 'Tout remplacer',
      danger: true,
    });
    if (ok) {
      this.store.replaceWithImport(pending.incoming);
      this.toast.show('Données remplacées par le contenu du fichier.');
    }
  }

  protected async loadDemo(): Promise<void> {
    const ok = await this.confirm.ask({
      title: 'Charger les données de démonstration ?',
      message:
        'Vos données actuelles seront remplacées par deux ans de relevés fictifs. Exportez-les d’abord si nécessaire.',
      confirmLabel: 'Charger la démo',
      danger: this.counts().readings > 0,
    });
    if (ok) {
      this.store.loadDemo();
      this.toast.show('Données de démonstration chargées.', 'info');
    }
  }

  protected async reset(): Promise<void> {
    const ok = await this.confirm.ask({
      title: 'Tout effacer ?',
      message:
        'La maison, tous les relevés et les réglages seront supprimés. Cette action est définitive (sauf sauvegarde exportée).',
      confirmLabel: 'Tout effacer',
      danger: true,
    });
    if (ok) {
      this.store.reset();
      this.toast.show('Toutes les données ont été effacées.', 'info');
    }
  }
}

function cleanError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
