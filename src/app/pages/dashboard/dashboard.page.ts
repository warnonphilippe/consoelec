import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { hourRanges, isOffPeakHour } from '../../core/calc/reference';
import { dayNumberToDate } from '../../core/calc/time';
import { pvKwp } from '../../core/models/app-data.model';
import { DataStore } from '../../core/services/data-store.service';
import { InverterService } from '../../core/services/inverter.service';
import { ToastService } from '../../core/services/toast.service';
import { FORMAT_PIPES } from '../../shared/format';
import { IconComponent, type IconName } from '../../shared/icon.component';
import { LiveProductionComponent } from '../../shared/live-production/live-production.component';

/** Période tarifaire d'un panneau de solde : ce qui est compensé ensemble sur la facture. */
interface Period {
  readonly key: 'hp' | 'hc';
  readonly label: string;
  readonly codes: string;
  readonly icon: IconName;
  readonly importKey: 'importPeak' | 'importOff';
  readonly exportKey: 'exportPeak' | 'exportOff';
}

@Component({
  selector: 'app-dashboard-page',
  imports: [RouterLink, IconComponent, LiveProductionComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './dashboard.page.html',
  styleUrl: './dashboard.page.css',
})
export default class DashboardPage {
  protected readonly store = inject(DataStore);
  protected readonly inverter = inject(InverterService);
  private readonly toast = inject(ToastService);

  protected readonly analysis = this.store.analysis;
  protected readonly kwp = computed(() => pvKwp(this.store.house().pv));
  protected readonly lastReading = computed(
    () => this.analysis().consumption.levels.at(-1) ?? null,
  );

  protected readonly periods: readonly Period[] = [
    {
      key: 'hp',
      label: 'Heures pleines',
      codes: '1.8.1 − 2.8.1',
      icon: 'sun',
      importKey: 'importPeak',
      exportKey: 'exportPeak',
    },
    {
      key: 'hc',
      label: 'Heures creuses',
      codes: '1.8.2 − 2.8.2',
      icon: 'moon',
      importKey: 'importOff',
      exportKey: 'exportOff',
    },
  ];

  /** Horaire des heures pleines / creuses (réglages) et période en cours. */
  protected readonly schedule = computed(() => {
    const s = this.store.settings();
    const date = dayNumberToDate(this.store.now());
    const weekend = date.getDay() === 0 || date.getDay() === 6;
    const hour = date.getHours();
    const off = (h: number) => isOffPeakHour(h, weekend, s);
    const current = off(hour);
    let until: number | null = null;
    for (let i = 1; i < 24; i++) {
      if (off((hour + i) % 24) !== current) {
        until = (hour + i) % 24;
        break;
      }
    }
    const weekday = Array.from({ length: 24 }, (_, h) => h).filter((h) => s.offPeakHours.includes(h));
    return {
      current,
      until,
      hour,
      weekend,
      hours: Array.from({ length: 24 }, (_, h) => ({ h, off: off(h) })),
      off: hourRanges(weekday),
      peak: hourRanges(Array.from({ length: 24 }, (_, h) => h).filter((h) => !weekday.includes(h))),
      weekends: s.offPeakWeekends,
    };
  });

  protected loadDemo(): void {
    this.store.loadDemo();
    this.toast.show(
      'Données de démonstration chargées. Vous pourrez les effacer dans les réglages.',
      'info',
    );
  }
}
