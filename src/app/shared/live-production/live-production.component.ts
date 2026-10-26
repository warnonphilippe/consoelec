import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { InverterService } from '../../core/services/inverter.service';
import { VaultService } from '../../core/services/vault.service';
import { FORMAT_PIPES } from '../format';
import { IconComponent } from '../icon.component';

/** Carte « Production en direct » : puissance, production du jour et index total, rafraîchis chaque minute. */
@Component({
  selector: 'app-live-production',
  imports: [RouterLink, DatePipe, IconComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './live-production.component.html',
  styleUrl: './live-production.component.css',
})
export class LiveProductionComponent {
  protected readonly inverter = inject(InverterService);
  protected readonly vault = inject(VaultService);
}
