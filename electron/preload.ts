/**
 * Preload sandboxé : seul le module `electron` est disponible à l'exécution.
 * Les autres imports doivent rester des `import type` (effacés à la compilation),
 * d'où les noms de canaux recopiés ici plutôt qu'importés.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { AiStreamEvent, ConsoElecApi } from './shared/ipc-contract';

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
  ai: {
    status: () => ipcRenderer.invoke('ai:status'),
    setKey: (key) => ipcRenderer.invoke('ai:setKey', key),
    clearKey: () => ipcRenderer.invoke('ai:clearKey'),
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
