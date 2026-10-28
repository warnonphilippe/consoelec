import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { P1Service } from '../../core/services/p1.service';
import { FORMAT_PIPES } from '../format';
import { IconComponent } from '../icon.component';

/** Carte « Compteur en direct » : soutirage ou injection du moment et index, rafraîchis chaque minute. */
@Component({
  selector: 'app-live-meter',
  imports: [RouterLink, DatePipe, IconComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './live-meter.component.html',
  styleUrl: './live-meter.component.css',
})
export class LiveMeterComponent {
  protected readonly p1 = inject(P1Service);
  /** Sens du flux : soutirage (puissance positive) ou injection (négative). */
  protected readonly flow = computed(() => {
    const w = this.p1.live()?.powerW ?? null;
    if (w === null) {
      return null;
    }
    return { injecting: w < 0, watts: Math.abs(w) };
  });
}
