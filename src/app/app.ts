import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  viewChild,
} from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ConfirmService } from './core/services/confirm.service';
import { DataStore } from './core/services/data-store.service';
import { ThemeService } from './core/services/theme.service';
import { ToastService } from './core/services/toast.service';
import type { ThemeMode } from './core/models/app-data.model';
import { fmt } from './shared/format';
import { IconComponent, type IconName } from './shared/icon.component';
import { AssistantPanelComponent } from './shared/assistant/assistant-panel.component';
import { AiService } from './core/ai/ai.service';
import { InverterService } from './core/services/inverter.service';
import { P1Service } from './core/services/p1.service';
import { SecretsService } from './core/services/secrets.service';

/** Durée couverte par les relevés à partir de laquelle les statistiques et les prévisions sont proposées. */
const MIN_HISTORY_DAYS = 60;

interface NavItem {
  readonly path: string;
  readonly label: string;
  readonly icon: IconName;
  readonly exact?: boolean;
}

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, IconComponent, AssistantPanelComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly store = inject(DataStore);
  protected readonly theme = inject(ThemeService);
  protected readonly toasts = inject(ToastService);
  protected readonly confirm = inject(ConfirmService);
  protected readonly ai = inject(AiService);
  private readonly secrets = inject(SecretsService);
  // Démarre la lecture de l'onduleur dès l'ouverture de l'application.
  protected readonly inverter = inject(InverterService);
  // … et celle du compteur par le port P1.
  private readonly p1 = inject(P1Service);
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('confirmDialog');

  /** `needs` : `readings` = assez de relevés ; `forecast` = assez de relevés ou des factures annuelles. */
  private readonly allNav: (NavItem & { needs?: 'readings' | 'forecast' })[] = [
    { path: '/', label: 'Tableau de bord', icon: 'gauge', exact: true },
    { path: '/production', label: 'Production', icon: 'sun' },
    { path: '/compteurs', label: 'Compteurs', icon: 'plug' },
    { path: '/releves', label: 'Relevés', icon: 'ruler' },
    { path: '/statistiques', label: 'Statistiques', icon: 'chart', needs: 'readings' },
    { path: '/previsions', label: 'Prévisions', icon: 'trend', needs: 'forecast' },
    { path: '/maison', label: 'Maison', icon: 'home' },
  ];

  /**
   * Statistiques et prévisions n'apparaissent qu'avec assez de données pour avoir un sens : les prévisions dès que des
   * factures annuelles décrivent la maison, les statistiques avec assez de relevés.
   */
  protected readonly nav = computed(() => {
    const analysis = this.store.analysis();
    const levels = analysis.consumption.levels;
    const span = levels.length > 1 ? levels.at(-1)!.day - levels[0]!.day : 0;
    const readings = span >= MIN_HISTORY_DAYS;
    const forecast = readings || (analysis.annual !== null && levels.length > 0);
    return this.allNav.filter(
      (item) => !item.needs || (item.needs === 'readings' ? readings : forecast),
    );
  });

  protected readonly secondaryNav: NavItem[] = [
    { path: '/reglages', label: 'Réglages', icon: 'settings' },
    { path: '/aide', label: 'Aide', icon: 'help' },
  ];

  protected readonly themeModes: { mode: ThemeMode; icon: IconName; label: string }[] = [
    { mode: 'light', icon: 'sun', label: 'Clair' },
    { mode: 'dark', icon: 'moon', label: 'Sombre' },
    { mode: 'system', icon: 'monitor', label: 'Système' },
  ];

  /** Indicateur de la barre latérale : facture estimée de l'année de facturation (soldes HP / HC au prix moyen). */
  protected readonly balance = computed(() => {
    const year = this.store.billingYear();
    if (!year) {
      return null;
    }
    return {
      label: fmt.euro(year.cost.total),
      surplus: year.cost.total <= 0,
      detail: `HP ${fmt.signedKwh(year.hp)} · HC ${fmt.signedKwh(year.hc)}`,
    };
  });

  constructor() {
    void this.secrets.refresh();
    effect(() => {
      const dialog = this.dialog()?.nativeElement;
      if (!dialog) {
        return;
      }
      if (this.confirm.pending() && !dialog.open) {
        dialog.showModal();
      } else if (!this.confirm.pending() && dialog.open) {
        dialog.close();
      }
    });
  }
}
