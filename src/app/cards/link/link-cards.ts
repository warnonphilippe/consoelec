import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { STALE_AFTER_DAYS, summaryAgeDays } from '../../core/link/household-summary';
import { LinkService } from '../../core/link/link.service';
import { FORMAT_PIPES } from '../../shared/format';
import { IconComponent } from '../../shared/icon.component';

const dateFormat = new Intl.DateTimeFormat('fr-BE', { day: 'numeric', month: 'short', year: 'numeric' });

/** Consommation de mazout de la maison, d'après le résumé publié par ConsoMazout. */
@Component({
  selector: 'app-mazout-link-card',
  imports: [IconComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card-host' },
  template: `
    @if (link.peer(); as m) {
      <div class="card kpi">
        <span class="kpi-label"><app-icon name="flame" [size]="15" /> Mazout · par an</span>
        <span class="kpi-value">{{ m.estimationAnnuelle.litres | num }} L</span>
        <span class="kpi-sub">
          ≈ {{ m.estimationAnnuelle.equivalentKwh | kwh }}
          @if (m.estimationAnnuelle.coutEstime !== null) {
            · {{ m.estimationAnnuelle.coutEstime | euro }}
          }
          @if (m.derniers12Mois; as last) {
            <br />12 derniers mois : {{ last.litres | num }} L
          }
          @if (m.cuve?.commanderAvantLe; as order) {
            <br />Commander avant le {{ order | day }}
          }
          <br />
          <span [class.stale]="stale()">ConsoMazout, {{ updated() }}</span>
        </span>
      </div>
    } @else {
      <div class="card kpi">
        <span class="kpi-label"><app-icon name="flame" [size]="15" /> Mazout · par an</span>
        <span class="kpi-value muted">—</span>
        <span class="kpi-sub">ConsoMazout n'a encore rien partagé sur cet ordinateur.</span>
      </div>
    }
  `,
  styles: `
    .stale {
      color: var(--warning);
    }
  `,
})
export class MazoutLinkCard {
  protected readonly link = inject(LinkService);

  private readonly age = computed(() => {
    const peer = this.link.peer();
    return peer === null ? 0 : summaryAgeDays(peer, Date.now());
  });
  protected readonly stale = computed(() => this.age() > STALE_AFTER_DAYS);
  protected readonly updated = computed(() => {
    const peer = this.link.peer();
    if (peer === null) {
      return '';
    }
    const at = new Date(peer.genereLe);
    return Number.isNaN(at.getTime()) ? 'date inconnue' : `mis à jour le ${dateFormat.format(at)}`;
  });
}
