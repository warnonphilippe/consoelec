import { inverterBrand, type InverterBrandInfo } from '../shared/inverter-brands';
import type {
  InverterConfig,
  InverterDayCurve,
  InverterHistory,
  InverterReading,
} from '../shared/ipc-contract';
import { InverterClient } from '../inverter';
import { LocalInverterClient } from './local-client';

/**
 * Onduleur configuré, quelle que soit sa marque : le client SMA WebConnect (avec ses journaux) pour SMA, le client
 * local générique pour les autres. Même interface que le client SMA.
 */
export class InverterHub {
  private readonly sma: InverterClient;
  private readonly local: LocalInverterClient;
  private config: InverterConfig = { enabled: false, host: '', certFingerprint: null };

  constructor(secret: () => string | null) {
    this.sma = new InverterClient(secret);
    this.local = new LocalInverterClient(secret);
  }

  get brand(): InverterBrandInfo {
    return inverterBrand(this.config.brand);
  }

  private get active(): InverterClient | LocalInverterClient {
    return this.brand.protocol === 'sma' ? this.sma : this.local;
  }

  configure(config: InverterConfig): void {
    const previous = this.active;
    this.config = { ...config };
    const next = this.active;
    if (previous !== next) {
      // Changement de marque : l'ancien client ferme sa session.
      previous.configure({ ...config, enabled: false });
    }
    next.configure(config);
  }

  get enabled(): boolean {
    return this.active.enabled;
  }

  get host(): string {
    return this.active.host;
  }

  get certFingerprint(): string | null {
    return this.active.certFingerprint;
  }

  get troubled(): boolean {
    return this.active.troubled;
  }

  /** Configuration complète en cours (pour essayer un autre nom réseau en gardant le reste). */
  get settings(): InverterConfig {
    return this.config;
  }

  read(): Promise<InverterReading> {
    return this.active.read();
  }

  history(now?: Date): Promise<InverterHistory> {
    return this.active.history(now);
  }

  dayCurve(date: string): Promise<InverterDayCurve> {
    return this.active.dayCurve(date);
  }

  async close(): Promise<void> {
    await Promise.all([this.sma.close(), this.local.close()]);
  }
}
