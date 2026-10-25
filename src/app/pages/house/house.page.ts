import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MONTH_LABELS } from '../../core/calc/time';
import { evAnnualKwh } from '../../core/calc/ev';
import { measuredYield } from '../../core/calc/pv-yield';
import {
  pvKwp,
  type ChargeWindow,
  type EvMode,
  type House,
} from '../../core/models/app-data.model';
import { DataStore } from '../../core/services/data-store.service';
import { FORMAT_PIPES } from '../../shared/format';
import { IconComponent } from '../../shared/icon.component';

type NumberField = 'persons' | 'areaM2';
type PvNumberField = 'panelCount' | 'panelWp' | 'inverterKva' | 'tiltDeg';
type HeaterNumberField = 'powerKw' | 'startMonth' | 'endMonth' | 'usagePct';
type EvNumberField = 'kmPerYear' | 'kWhPer100km' | 'homeChargingPct' | 'chargerKw';

@Component({
  selector: 'app-house-page',
  imports: [IconComponent, ...FORMAT_PIPES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './house.page.html',
  styleUrl: './house.page.css',
})
export default class HousePage {
  protected readonly store = inject(DataStore);

  protected readonly house = this.store.house;
  protected readonly settings = this.store.settings;
  protected readonly reference = computed(() => this.store.analysis().reference);
  protected readonly evKwh = computed(() => evAnnualKwh(this.house().ev));
  protected readonly kwp = computed(() => pvKwp(this.house().pv));
  /** Rendement réel d'après l'index de production de l'onduleur enregistré au fil des jours. */
  protected readonly measured = computed(() =>
    measuredYield(this.store.data().pvDaily, this.reference(), this.kwp()),
  );
  protected readonly months = MONTH_LABELS;
  /** Rapport puissance des panneaux / puissance de l'onduleur. */
  protected readonly dcAcRatio = computed(() => this.kwp() / this.house().pv.inverterKva);
  protected readonly clippedPct = computed(() => {
    const a = this.reference().annual;
    const potential = a.production + a.clipped;
    return potential > 0 ? (a.clipped / potential) * 100 : 0;
  });

  protected readonly evModes: { mode: EvMode; label: string; hint: string }[] = [
    { mode: 'none', label: 'Pas de voiture électrique', hint: 'Situation actuelle' },
    { mode: 'planned', label: 'Voiture prévue', hint: 'Simulée dans les prévisions (avec / sans)' },
    { mode: 'owned', label: 'Voiture en service', hint: 'Incluse dans toutes les prévisions' },
  ];
  protected readonly windows: { value: ChargeWindow; label: string; hint: string }[] = [
    { value: 'night', label: 'De nuit', hint: 'Heures creuses' },
    { value: 'day', label: 'De jour', hint: 'Surplus solaire d’abord' },
    { value: 'mixed', label: 'Mixte', hint: 'Moitié nuit, moitié jour' },
  ];

  protected text(field: 'name', event: Event): void {
    this.store.updateHouse({ [field]: (event.target as HTMLInputElement).value });
  }

  protected number(field: NumberField, event: Event, min: number, max: number): void {
    const value = read(event, min, max);
    if (value !== null) {
      this.store.updateHouse({ [field]: field === 'persons' ? Math.round(value) : value });
    }
  }

  protected pvNumber(field: PvNumberField, event: Event, min: number, max: number): void {
    const value = read(event, min, max);
    if (value !== null) {
      this.store.updateHouse({ pv: { ...this.house().pv, [field]: value } });
    }
  }

  protected inverterPhases(phases: 1 | 3): void {
    this.store.updateHouse({ pv: { ...this.house().pv, inverterPhases: phases } });
  }

  protected heaterEnabled(event: Event): void {
    this.store.updateHouse({
      surplusHeater: {
        ...this.house().surplusHeater,
        enabled: (event.target as HTMLInputElement).checked,
      },
    });
  }

  protected heaterNumber(field: HeaterNumberField, event: Event, min: number, max: number): void {
    const value = read(event, min, max);
    if (value !== null) {
      this.store.updateHouse({ surplusHeater: { ...this.house().surplusHeater, [field]: value } });
    }
  }

  protected heaterMonth(field: 'startMonth' | 'endMonth', event: Event): void {
    this.store.updateHouse({
      surplusHeater: {
        ...this.house().surplusHeater,
        [field]: Number((event.target as HTMLSelectElement).value),
      },
    });
  }

  protected pvText(field: 'orientation' | 'installDate' | 'inverterModel', event: Event): void {
    this.store.updateHouse({
      pv: { ...this.house().pv, [field]: (event.target as HTMLInputElement).value },
    });
  }

  protected heating(patch: Partial<House['heating']>): void {
    this.store.updateHouse({ heating: { ...this.house().heating, ...patch } });
  }

  protected heatingNote(event: Event): void {
    this.heating({ note: (event.target as HTMLTextAreaElement).value });
  }

  protected evMode(mode: EvMode): void {
    this.store.updateHouse({ ev: { ...this.house().ev, mode } });
  }

  protected evNumber(field: EvNumberField, event: Event, min: number, max: number): void {
    const value = read(event, min, max);
    if (value !== null) {
      this.store.updateHouse({ ev: { ...this.house().ev, [field]: value } });
    }
  }

  protected evWindow(chargeWindow: ChargeWindow): void {
    this.store.updateHouse({ ev: { ...this.house().ev, chargeWindow } });
  }

  protected evDate(event: Event): void {
    this.store.updateHouse({
      ev: { ...this.house().ev, startDate: (event.target as HTMLInputElement).value },
    });
  }
}

function read(event: Event, min: number, max: number): number | null {
  const value = (event.target as HTMLInputElement).valueAsNumber;
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : null;
}
