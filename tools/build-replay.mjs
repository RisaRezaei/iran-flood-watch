#!/usr/bin/env node
// Copyright © 2026 Parisa Abbasalizadehrezaei. All rights reserved. See LICENSE.
// Builds a replay page of a past flood: each day runs the system's thresholds over GloFAS model
// flow and ERA5 rainfall. For recent events it also replays the archived ECMWF forecasts issued
// before the event (single-runs API), to show how many days ahead a warning would have appeared.
//
//   node tools/build-replay.mjs --event 2026-11              fetch data and build docs/replay-2026-11.html
//   node tools/build-replay.mjs --event 2019 --from-json f   build from saved data

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fetchJson, CONFIG } from '../src/engine.mjs';
import { renderReplay } from '../src/render.mjs';

const EVENTS = {
  2019: {
    start: '2019-03-01', end: '2019-04-30', startDay: '2019-03-10', startSite: 'river:gorganrud-aqqala', speed: 450,
    title: 'spring 2019 replay', titleFa: 'بازپخش سیل‌های بهار ۱۳۹۸',
    note: '<b>Replay of real data, day by day.</b> Each day applies the system\'s warning thresholds to the GloFAS model\'s reconstructed river flow and to ERA5 rainfall for that day. It shows whether and when the thresholds fire on the real disasters. It is not a re-run of the forecasts issued in 2019.',
    sources: 'Data: GloFAS v4 (Copernicus Emergency Management Service) and ERA5 (Copernicus Climate Change Service) via <a href="https://open-meteo.com/">Open-Meteo</a> (CC BY 4.0); boundaries © Natural Earth. Event dates: OCHA and Iranian Red Crescent reports.',
    events: [
      { day: '2019-03-19', label: '19–20 Mar · Golestan & Mazandaran floods', row: 0 },
      { day: '2019-03-25', label: '25 Mar · Shiraz flash flood', row: 1 },
      { day: '2019-04-01', label: '1 Apr · Pol-e Dokhtar (Lorestan) under water', row: 0 },
    ],
  },
  '2026-11': {
    start: '2026-10-30', end: '2026-11-12', startDay: '2026-10-31', startSite: 'rain:tehran', speed: 1400,
    runs: { from: '2026-10-30', to: '2026-11-08' },
    title: 'November 2026 replay', titleFa: 'بازپخش سیل آبان ۱۴۰۵',
    note: '<b>Last week\'s floods, day by day.</b> The map and alerts apply the system\'s thresholds to the GloFAS model\'s river flow and to ERA5 rainfall for each day. For rain points, the panel on the right also replays the ECMWF forecasts issued every morning before the event through the same thresholds — how many days ahead a warning would have appeared.',
    sources: 'Data: GloFAS v4 (Copernicus Emergency Management Service), ERA5 (Copernicus Climate Change Service) and archived ECMWF IFS forecasts via <a href="https://open-meteo.com/">Open-Meteo</a> (CC BY 4.0); boundaries © Natural Earth. Event reports: Iranian Red Crescent, Iran International.',
    fcNote: 'Archived forecasts are the single ECMWF IFS 0.25° run (00 UTC); the live system uses all 51 ensemble members, whose past runs are not archived.',
    fcRiverNote: 'Past GloFAS river forecasts are not archived, so river sites show the model\'s flow only.',
    events: [
      { day: '2026-11-05', label: '5–7 Nov · Red Crescent: flooding in 8 provinces, incl. Khorramabad', row: 0 },
      { day: '2026-11-08', label: '8 Nov · 14 provinces hit in 72 h; 4 dead', row: 1 },
      { day: '2026-11-09', label: '9 Nov · red sea warnings, Gilan & Mazandaran', row: 0 },
    ],
  },
};

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const key = opt('--event', '2026-11');
const E = EVENTS[key];
if (!E) throw new Error(`Unknown event ${key}; choose one of ${Object.keys(EVENTS).join(', ')}`);
const sites = JSON.parse(await readFile(new URL('../src/sites.json', import.meta.url), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sig = (v) => (v == null || !isFinite(v) ? null : +(+v).toPrecision(3));
const addDays = (d, n) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

let raw;
if (opt('--from-json')) raw = JSON.parse(await readFile(opt('--from-json'), 'utf8'));
else {
  const cfg = { ...CONFIG, retryWaitMs: 30000, maxRetries: 8 }, log = console.error;
  raw = { river: { time0: E.start, q: {} }, rain: {}, fc: {} };
  for (const s of sites.river) {
    const j = await fetchJson(`${CONFIG.floodApi}?latitude=${s.slat}&longitude=${s.slon}&daily=river_discharge&start_date=${E.start}&end_date=${E.end}`, { cfg, log });
    raw.river.q[s.id] = j.daily.river_discharge.map(sig);
    await sleep(800);
  }
  for (const s of sites.rain) {
    const j = await fetchJson(`https://archive-api.open-meteo.com/v1/archive?latitude=${s.lat}&longitude=${s.lon}&daily=precipitation_sum&models=era5` +
      `&timezone=${encodeURIComponent(CONFIG.timezone)}&start_date=${addDays(E.start, -2)}&end_date=${E.end}`, { cfg, log });
    raw.rain[s.id] = [j.daily.time[0], j.daily.precipitation_sum.map((v) => (v == null ? null : +v.toFixed(1)))];
    await sleep(800);
  }
  if (E.runs) {
    // one archived 00 UTC run per day; hourly rain summed into Tehran days (hour ending t → local date of t + 3 h)
    const lats = sites.rain.map((s) => s.lat).join(','), lons = sites.rain.map((s) => s.lon).join(',');
    for (let run = E.runs.from; run <= E.runs.to; run = addDays(run, 1)) {
      const j = await fetchJson(`https://single-runs-api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}` +
        `&hourly=precipitation&models=ecmwf_ifs025&run=${run}T00:00&forecast_days=10`, { cfg, log });
      const arr = Array.isArray(j) ? j : [j];
      sites.rain.forEach((s, k) => {
        const days = {};
        arr[k].hourly.precipitation.forEach((v, h) => {
          if (v == null) return;
          const t = new Date(`${arr[k].hourly.time[0]}Z`); t.setUTCHours(t.getUTCHours() + h + 3);
          const d = t.toISOString().slice(0, 10); days[d] = (days[d] || 0) + v;
        });
        const keys = Object.keys(days).sort().slice(1, -1); // drop the partial first and last local days
        (raw.fc[s.id] = raw.fc[s.id] || {})[run] = [keys[0], keys.map((d) => +days[d].toFixed(1))];
      });
      await sleep(1500);
    }
  }
}

// trim everything to the event window
const n = Math.round((Date.parse(E.end) - Date.parse(E.start)) / 864e5) + 1;
const time = Array.from({ length: n }, (_, k) => addDays(E.start, k));
const off = Math.round((Date.parse(E.start) - Date.parse(raw.river.time0)) / 864e5);
const pickRiver = ({ id, river, place, fa, prov, slat, slon, thr, dam }) => ({ id, river, place, fa, prov, slat, slon, thr, dam });
const pickRain = ({ id, name, fa, prov, lat, lon, thr, thr3 }) => ({ id, name, fa, prov, lat, lon, thr, thr3 });
const replay = {
  time, startDay: E.startDay, startSite: E.startSite, speed: E.speed, events: E.events,
  title: E.title, titleFa: E.titleFa, note: E.note, sources: E.sources, fcNote: E.fcNote, fcRiverNote: E.fcRiverNote,
  sites: { river: sites.river.map(pickRiver), rain: sites.rain.map(pickRain) },
  river: Object.fromEntries(Object.entries(raw.river.q).map(([k, q]) => [k, q.slice(off, off + n)])),
  rain: Object.fromEntries(Object.entries(raw.rain).map(([k, [time0, p]]) => [k, { time0, p }])),
};
if (raw.fc && Object.keys(raw.fc).length) {
  replay.fc = raw.fc;
  replay.fcRuns = Object.keys(Object.values(raw.fc)[0]).sort();
}
await mkdir('docs/data', { recursive: true });
await writeFile(`docs/replay-${key}.html`, await renderReplay(replay));
if (!opt('--from-json')) await writeFile(`docs/data/replay-${key}-raw.json`, JSON.stringify(raw));
console.error(`wrote docs/replay-${key}.html`);
