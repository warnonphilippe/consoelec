import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  viewChild,
  signal,
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
import { VaultService } from './core/services/vault.service';

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
  protected readonly vault = inject(VaultService);
  // Démarre la lecture de l'onduleur dès l'ouverture de l'application.
  protected readonly inverter = inject(InverterService);
  private readonly unlockDialog = viewChild<ElementRef<HTMLDialogElement>>('unlockDialog');
  protected readonly unlockPassphrase = signal('');
  protected readonly unlockBusy = signal(false);
  protected readonly unlockError = signal<string | null>(null);
  /** Demande la phrase de passe au démarrage si le coffre existe et n'est pas encore ouvert. */
  protected readonly askUnlock = computed(() => this.vault.locked() && !this.vault.postponed());
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('confirmDialog');

  protected readonly nav: NavItem[] = [
    { path: '/', label: 'Tableau de bord', icon: 'gauge', exact: true },
    { path: '/production', label: 'Production', icon: 'sun' },
    { path: '/compteurs', label: 'Compteurs', icon: 'plug' },
    { path: '/releves', label: 'Relevés', icon: 'ruler' },
    { path: '/statistiques', label: 'Statistiques', icon: 'chart' },
    { path: '/previsions', label: 'Prévisions', icon: 'trend' },
    { path: '/maison', label: 'Maison', icon: 'home' },
  ];

  protected readonly secondaryNav: NavItem[] = [
    { path: '/reglages', label: 'Réglages', icon: 'settings' },
    { path: '/aide', label: 'Aide', icon: 'help' },
  ];

  protected readonly themeModes: { mode: ThemeMode; icon: IconName; label: string }[] = [
    { mode: 'light', icon: 'sun', label: 'Clair' },
    { mode: 'dark', icon: 'moon', label: 'Sombre' },
    { mode: 'system', icon: 'monitor', label: 'Système' },
  ];

  /** Indicateur de la barre latérale : solde net des 12 derniers mois (soutirage − injection). */
  protected readonly balance = computed(() => {
    const total = this.store.analysis().last365;
    if (!total) {
      return null;
    }
    const net = total.derived.net;
    return {
      label: `${net > 0 ? '+' : net < 0 ? '−' : ''}${fmt.number(Math.abs(net))} kWh`,
      surplus: net <= 0,
      detail: `${fmt.number(total.derived.import)} soutirés · ${fmt.number(total.derived.export)} injectés`,
    };
  });

  protected async unlock(): Promise<void> {
    const passphrase = this.unlockPassphrase();
    if (passphrase === '' || this.unlockBusy()) {
      return;
    }
    this.unlockBusy.set(true);
    this.unlockError.set(null);
    try {
      await this.vault.unlock(passphrase);
      this.unlockPassphrase.set('');
      this.toasts.show('Coffre déverrouillé.');
    } catch (error) {
      this.unlockError.set(
        error instanceof Error
          ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
          : String(error),
      );
    } finally {
      this.unlockBusy.set(false);
    }
  }

  protected postponeUnlock(): void {
    this.unlockPassphrase.set('');
    this.vault.postponed.set(true);
  }

  constructor() {
    void this.vault.refresh();
    effect(() => {
      const dialog = this.unlockDialog()?.nativeElement;
      if (!dialog) {
        return;
      }
      if (this.askUnlock() && !dialog.open && !this.confirm.pending()) {
        dialog.showModal();
      } else if (!this.askUnlock() && dialog.open) {
        dialog.close();
      }
    });
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
