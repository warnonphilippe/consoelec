import type { P1ReaderKind } from '../../electron/shared/p1-readers';
import { MeterModel } from './p1-meter';
import {
  startDsmrTcp,
  startHomeWizardV1,
  startHomeWizardV2,
  startYouLess,
  type HomeWizardV2Emulator,
} from './p1-servers';
import type { Running } from './servers';
import { selfSignedCert } from './tls';

/** Lecteurs P1 émulés, avec les réglages à saisir dans ConsoElec pour les lire. */

export type P1EmulatorId =
  'p1-homewizard' | 'p1-homewizard-v2' | 'p1-chargee' | 'p1-youless' | 'p1-dsmr';

export interface StartedP1Emulator {
  readonly id: P1EmulatorId;
  readonly label: string;
  readonly kind: P1ReaderKind;
  readonly host: string;
  readonly port: number;
  readonly meter: MeterModel;
  /** HomeWizard v2 : appui simulé sur le bouton, jeton délivré. */
  readonly v2?: HomeWizardV2Emulator;
  readonly fingerprint: string | null;
  close(): Promise<void>;
}

interface Variant {
  readonly label: string;
  readonly kind: P1ReaderKind;
  readonly start: (
    meter: MeterModel,
    port: number,
    host: string,
    options: { autoPressAfter?: number },
  ) => Promise<{ running: Running; v2?: HomeWizardV2Emulator; fingerprint?: string }>;
}

export const P1_EMULATORS: Record<P1EmulatorId, Variant> = {
  'p1-homewizard': {
    label: 'HomeWizard Wi-Fi P1, API v1',
    kind: 'homewizard',
    start: async (meter, port, host) => ({
      running: await startHomeWizardV1(meter, {}, port, host),
    }),
  },
  'p1-homewizard-v2': {
    label: 'HomeWizard Wi-Fi P1, API v2 (bouton pressé automatiquement à la 3e demande)',
    kind: 'homewizard-v2',
    start: async (meter, port, host, options) => {
      const tls = selfSignedCert('p1meter-5c2faf');
      const v2 = await startHomeWizardV2(
        meter,
        tls,
        { autoPressAfter: options.autoPressAfter },
        port,
        host,
      );
      return { running: v2, v2, fingerprint: tls.fingerprint };
    },
  },
  'p1-chargee': {
    label: 'Chargee Sparky',
    kind: 'chargee',
    start: async (meter, port, host) => ({
      running: await startHomeWizardV1(meter, { product: 'chargee' }, port, host),
    }),
  },
  'p1-youless': {
    label: 'YouLess LS120',
    kind: 'youless',
    start: async (meter, port, host) => ({ running: await startYouLess(meter, port, host) }),
  },
  'p1-dsmr': {
    label: 'Télégramme P1 brut sur TCP (compteur Fluvius e-MUCS)',
    kind: 'dsmr-tcp',
    start: async (meter, port, host) => ({ running: await startDsmrTcp(meter, {}, port, host) }),
  },
};

export const P1_EMULATOR_IDS = Object.keys(P1_EMULATORS) as P1EmulatorId[];

export async function startP1Emulator(
  id: P1EmulatorId,
  options: { port?: number; host?: string; meter?: MeterModel; autoPressAfter?: number } = {},
): Promise<StartedP1Emulator> {
  const variant = P1_EMULATORS[id];
  const meter = options.meter ?? new MeterModel();
  const host = options.host ?? '127.0.0.1';
  const { running, v2, fingerprint } = await variant.start(meter, options.port ?? 0, host, {
    autoPressAfter: options.autoPressAfter,
  });
  return {
    id,
    label: variant.label,
    kind: variant.kind,
    host: host === '0.0.0.0' ? '127.0.0.1' : host,
    port: running.port,
    meter,
    v2,
    fingerprint: fingerprint ?? null,
    close: () => running.close(),
  };
}
