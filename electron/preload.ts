/**
 * Preload sandboxé : seul le module `electron` est disponible à l'exécution.
 * Les autres imports doivent rester des `import type` (effacés à la compilation),
 * d'où les noms de canaux recopiés ici plutôt qu'importés.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type {
  AiStreamEvent,
  ConsoElecApi,
  InverterReading,
  P1Reading,
} from './shared/ipc-contract';

const api: ConsoElecApi = {
  platform: process.platform,
  data: {
    load: () => ipcRenderer.invoke('data:load'),
    save: (content) => ipcRenderer.invoke('data:save', content),
    exportFile: (content, suggestedName, kind) =>
      ipcRenderer.invoke('data:export', content, suggestedName, kind),
    importFile: (kind) => ipcRenderer.invoke('data:import', kind),
    reveal: () => ipcRenderer.invoke('data:reveal'),
  },
  theme: {
    set: (mode) => ipcRenderer.invoke('theme:set', mode),
  },
  image: {
    toJpeg: (data) => ipcRenderer.invoke('image:toJpeg', data),
  },
  secrets: {
    status: () => ipcRenderer.invoke('secrets:status'),
    setSecret: (name, value) => ipcRenderer.invoke('secrets:set', name, value),
    importVault: (passphrase) => ipcRenderer.invoke('secrets:importVault', passphrase),
  },
  inverter: {
    configure: (config) => ipcRenderer.invoke('inverter:configure', config),
    refresh: () => ipcRenderer.invoke('inverter:refresh'),
    discover: (brand) => ipcRenderer.invoke('inverter:discover', brand),
    history: () => ipcRenderer.invoke('inverter:history'),
    dayCurve: (date) => ipcRenderer.invoke('inverter:day-curve', date),
    onReading: (listener) => {
      const handler = (_event: unknown, payload: InverterReading): void => listener(payload);
      ipcRenderer.on('inverter:reading', handler);
      return () => ipcRenderer.removeListener('inverter:reading', handler);
    },
  },
  p1: {
    configure: (config) => ipcRenderer.invoke('p1:configure', config),
    refresh: () => ipcRenderer.invoke('p1:refresh'),
    discover: () => ipcRenderer.invoke('p1:discover'),
    onReading: (listener) => {
      const handler = (_event: unknown, payload: P1Reading): void => listener(payload);
      ipcRenderer.on('p1:reading', handler);
      return () => ipcRenderer.removeListener('p1:reading', handler);
    },
  },
  ai: {
    status: () => ipcRenderer.invoke('ai:status'),
    test: (model) => ipcRenderer.invoke('ai:test', model),
    chat: (request) => ipcRenderer.invoke('ai:chat', request),
    abort: (requestId) => ipcRenderer.invoke('ai:abort', requestId),
    readMeter: (model, photos) => ipcRenderer.invoke('ai:readMeter', model, photos),
    onEvent: (listener) => {
      const handler = (_event: unknown, payload: AiStreamEvent): void => listener(payload);
      ipcRenderer.on('ai:event', handler);
      return () => ipcRenderer.removeListener('ai:event', handler);
    },
  },
};

contextBridge.exposeInMainWorld('consoElec', api);
