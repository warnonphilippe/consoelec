/**
 * Faux `window.consoElec` injecté par Playwright avant le chargement de la page : l'interface se croit dans Electron.
 * Les données viennent de `window.__VIDEO_CONFIG__` (voir `demo-scenario.ts`) ; la journée en cours est simulée ici
 * minute par minute (production d'un jour de beau temps, consommation de la maison), ce qui donne à la fois le journal
 * P1 du jour, la courbe de l'onduleur et les lectures « en direct » émises toutes les quelques secondes.
 */
(() => {
  const config = window.__VIDEO_CONFIG__;
  if (!config) {
    return;
  }
  const settings = config.data.settings;
  const MIN = 60_000;
  const EMIT_EVERY_MS = 4000;

  const pad = (n) => String(n).padStart(2, '0');
  const localIso = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const midnightOf = (ms) => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  /** Bruit déterministe dans [0, 1). */
  const noise = (k) => {
    const x = Math.sin(k * 12.9898 + 78.233) * 43758.5453;
    return x - Math.floor(x);
  };

  // --- Soleil : lever, coucher et puissance de l'installation ---------------------------------------------------

  const kwp = (config.data.house.pv.panelCount * config.data.house.pv.panelWp) / 1000;
  const capW = config.data.house.pv.inverterKva * 1000;

  /** Lever et coucher (heures locales décimales) en Belgique pour une date, heure d'été comprise. */
  function sunHours(ms) {
    const d = new Date(ms);
    const doy = Math.floor((ms - new Date(d.getFullYear(), 0, 0).getTime()) / 86_400_000);
    const length = 12.2 + 4.2 * Math.sin((2 * Math.PI * (doy - 80)) / 365);
    const jan = new Date(d.getFullYear(), 0, 1).getTimezoneOffset();
    const noon = 12.75 + (d.getTimezoneOffset() < jan ? 1 : 0);
    return { rise: noon - length / 2, set: noon + length / 2 };
  }

  /** Puissance AC (W) aujourd'hui à l'instant `ms` : beau temps avec quelques passages nuageux, écrêtée à l'onduleur. */
  function pvW(ms) {
    const h = (ms - midnightOf(ms)) / 3_600_000;
    const { rise, set } = sunHours(ms);
    if (h <= rise || h >= set) {
      return 0;
    }
    const s = Math.sin((Math.PI * (h - rise)) / (set - rise));
    const minute = Math.floor(ms / MIN);
    const cloud = 1 - 0.18 * Math.max(0, Math.sin(minute / 23)) * noise(minute);
    return Math.min(capW, kwp * 870 * s * s * cloud);
  }

  /** Consommation de la maison (W) : fond, matin et soir, lave-vaisselle en fin de matinée. */
  function loadW(ms) {
    const h = (ms - midnightOf(ms)) / 3_600_000;
    const minute = Math.floor(ms / MIN);
    let w = 230 + 120 * noise(minute);
    if (h >= 7 && h < 9) w += 450;
    if (h >= 12 && h < 13.5) w += 350;
    if (h >= 18 && h < 21.5) w += 650;
    if (h >= 11 && h < 12.2) w += 1800 * (noise(minute + 7) < 0.8 ? 1 : 0.1);
    return w;
  }

  const offPeak = (ms) => {
    const d = new Date(ms);
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    return (weekend && settings.offPeakWeekends) || settings.offPeakHours.includes(d.getHours());
  };

  /** Index du compteur et de l'onduleur à l'instant `ms`, intégrés minute par minute depuis minuit. */
  function stateAt(ms) {
    const idx = { ...config.midnight };
    let pvWh = 0;
    const start = midnightOf(ms);
    for (let t = start; t < ms; t += MIN) {
      const dt = Math.min(MIN, ms - t) / 3_600_000;
      const pv = pvW(t);
      const net = loadW(t) - pv;
      const off = offPeak(t);
      if (net >= 0) {
        idx[off ? 'importOff' : 'importPeak'] += (net * dt) / 1000;
      } else {
        idx[off ? 'exportOff' : 'exportPeak'] += (-net * dt) / 1000;
      }
      pvWh += pv * dt;
    }
    return { idx, pvWh };
  }

  const round3 = (v) => Math.round(v * 1000) / 1000;
  const pointAt = (ms) => {
    const { idx } = stateAt(ms);
    return {
      at: localIso(ms),
      importPeak: round3(idx.importPeak),
      importOff: round3(idx.importOff),
      exportPeak: round3(idx.exportPeak),
      exportOff: round3(idx.exportOff),
    };
  };

  /** Journal P1 de la journée jusqu'à maintenant : dernière minute de chaque heure, chaque minute de la dernière heure. */
  function todayLog(now) {
    const start = midnightOf(now);
    const lastMinute = Math.floor(now / MIN) * MIN;
    const hours = [];
    for (let t = start + 59 * MIN; t < lastMinute; t += 60 * MIN) {
      hours.push(pointAt(t));
    }
    hours.push(pointAt(lastMinute));
    const minutes = [];
    for (let t = Math.max(start, lastMinute - 59 * MIN); t <= lastMinute; t += MIN) {
      minutes.push(pointAt(t));
    }
    return { hours, minutes, day: pointAt(lastMinute) };
  }

  // --- Lectures « en direct » ---------------------------------------------------------------------------------

  function p1Reading() {
    const now = Date.now();
    const { idx } = stateAt(now);
    const jitter = (noise(Math.floor(now / 1000)) - 0.5) * 140;
    const quarterStart = now - (now % (15 * MIN));
    let sum = 0;
    let n = 0;
    for (let t = quarterStart; t <= now; t += 20_000) {
      sum += loadW(t) - pvW(t);
      n++;
    }
    return {
      at: now,
      powerW: Math.round(loadW(now) - pvW(now) + jitter),
      quarterHourAvgW: Math.round(sum / n),
      tariff: offPeak(now) ? 2 : 1,
      importPeak: round3(idx.importPeak),
      importOff: round3(idx.importOff),
      exportPeak: round3(idx.exportPeak),
      exportOff: round3(idx.exportOff),
      meterModel: 'ISKRA IE.5',
      error: null,
    };
  }

  function inverterReading() {
    const now = Date.now();
    const { pvWh } = stateAt(now);
    const jitter = (noise(Math.floor(now / 1000) + 3) - 0.5) * 60;
    const power = pvW(now);
    return {
      at: now,
      powerW: power > 0 ? Math.round(Math.min(capW, power + jitter)) : null,
      dayWh: Math.round(pvWh),
      totalWh: Math.round(config.pvMidnightKwh * 1000 + pvWh),
      error: null,
      certFingerprint: settings.inverter.certFingerprint,
    };
  }

  /** Courbe au pas de 5 minutes d'aujourd'hui, jusqu'à maintenant. */
  function todayCurve() {
    const now = Date.now();
    const points = [];
    for (let t = midnightOf(now) + 5 * MIN; t <= now; t += 5 * MIN) {
      const w = pvW(t);
      if (w > 0) points.push({ at: t, powerW: Math.round(w) });
    }
    return points;
  }

  /** Couverture nuageuse d'un jour passé : bruit de valeur lissé, un changement toutes les 40 minutes environ. */
  function clouds(t, date) {
    const k = t / (40 * MIN) + noise(date.length + Number(date.slice(-2))) * 50;
    const i = Math.floor(k);
    const f = k - i;
    const u = f * f * (3 - 2 * f);
    const a = noise(i);
    const b = noise(i + 1);
    return 0.4 + 0.6 * (a + (b - a) * u);
  }

  /** Courbe d'une journée passée : même forme, ramenée à la production de ce jour, avec des nuages. */
  function pastCurve(date) {
    const day = config.data.pvDaily.find((d) => d.date === date);
    const start = new Date(`${date}T00:00`).getTime();
    const { rise, set } = sunHours(start + 12 * 3_600_000);
    const raw = [];
    for (let t = start + 5 * MIN; t < start + 86_400_000; t += 5 * MIN) {
      const h = (t - start) / 3_600_000;
      if (h <= rise || h >= set) continue;
      const s = Math.sin((Math.PI * (h - rise)) / (set - rise));
      raw.push({ at: t, w: s * s * clouds(t, date) * (0.96 + 0.08 * noise(t / (5 * MIN))) });
    }
    const energy = raw.reduce((a, p) => a + (p.w * 5) / 60, 0);
    const scale = day && energy > 0 ? (day.dayKwh * 1000) / energy : 0;
    return raw.map((p) => ({ at: p.at, powerW: Math.round(Math.min(capW, p.w * scale)) }));
  }

  // --- Données enregistrées -----------------------------------------------------------------------------------

  /** Profil au quart d'heure d'aujourd'hui : index totaux (Wh) à chaque quart d'heure écoulé, comme le lecteur P1 les a lus. */
  function todayProfile(now) {
    const start = midnightOf(now);
    const importWh = Array(96).fill(null);
    const exportWh = Array(96).fill(null);
    for (let q = 0; q < 96 && start + q * 15 * MIN <= now; q++) {
      const { idx } = stateAt(start + q * 15 * MIN);
      importWh[q] = Math.round((idx.importPeak + idx.importOff) * 1000);
      exportWh[q] = Math.round((idx.exportPeak + idx.exportOff) * 1000);
    }
    return { date: localIso(now).slice(0, 10), importWh, exportWh, estimated: [] };
  }

  function initialContent() {
    const data = structuredClone(config.data);
    const now = Date.now();
    const log = todayLog(now);
    data.meterLog = {
      minutes: log.minutes,
      hours: log.hours,
      days: [...data.meterLog.days, log.day],
    };
    data.meterProfile = [...data.meterProfile, todayProfile(now)];
    return JSON.stringify(data);
  }

  let saved = null;
  const listeners = { p1: new Set(), inverter: new Set(), ai: new Set() };
  const subscribe = (set, fn) => {
    set.add(fn);
    return () => set.delete(fn);
  };
  const emit = () => {
    const p1 = p1Reading();
    const inv = inverterReading();
    listeners.p1.forEach((fn) => fn(p1));
    listeners.inverter.forEach((fn) => fn(inv));
  };
  setTimeout(emit, 600);
  setInterval(emit, EMIT_EVERY_MS);

  window.consoElec = {
    platform: 'darwin',
    data: {
      load: async () => ({
        content: saved ?? initialContent(),
        path: '/Users/demo/Library/Application Support/ConsoElec/consoelec.json',
        recoveredFromBackup: false,
      }),
      save: async (content) => {
        saved = content;
      },
      exportFile: async () => null,
      importFile: async () => null,
      reveal: async () => {},
    },
    theme: { set: async () => {} },
    image: {
      toJpeg: async () => {
        throw new Error('Indisponible dans la démo');
      },
    },
    secrets: {
      status: async () => ({
        storage: 'keychain',
        secrets: { claudeApiKey: false, inverterPsk: true },
        legacyVault: false,
      }),
      setSecret: async () => ({
        storage: 'keychain',
        secrets: { claudeApiKey: false, inverterPsk: true },
        legacyVault: false,
      }),
      importVault: async () => ({
        storage: 'keychain',
        secrets: { claudeApiKey: false, inverterPsk: true },
        legacyVault: false,
      }),
    },
    inverter: {
      configure: async () => {},
      refresh: async () => inverterReading(),
      onReading: (fn) => subscribe(listeners.inverter, fn),
      discover: async () => [{ host: settings.inverter.host }],
      history: async () => ({
        days: config.data.pvDaily.map(({ date, dayKwh, totalKwh }) => ({ date, dayKwh, totalKwh })),
        today: todayCurve(),
        error: null,
      }),
      dayCurve: async (date) => ({ date, points: pastCurve(date), error: null }),
    },
    p1: {
      configure: async () => {},
      refresh: async () => p1Reading(),
      onReading: (fn) => subscribe(listeners.p1, fn),
      discover: async () => [settings.p1.host],
    },
    ai: {
      status: async () => ({ hasKey: false }),
      test: async () => ({ ok: false, message: 'Pas de clé dans la démo' }),
      chat: async () => {},
      abort: async () => {},
      onEvent: (fn) => subscribe(listeners.ai, fn),
      readMeter: async () => {
        throw new Error('Indisponible dans la démo');
      },
    },
  };
})();
