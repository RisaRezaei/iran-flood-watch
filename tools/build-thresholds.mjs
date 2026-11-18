#!/usr/bin/env node
// Rebuild src/sites.json: snap river sites to the GloFAS network and compute 2/5/20/50-year
// return levels for every site. Heavy on the API (long daily histories), so it paces itself;
// expect roughly an hour. Run it again only if you add sites or want a newer climate period.
//
//   node tools/build-thresholds.mjs            # all sites
//   node tools/build-thresholds.mjs karun-ahvaz tehran   # only these ids (merged into the file)

import { readFile, writeFile } from 'node:fs/promises';
import { fetchJson, CONFIG } from '../src/engine.mjs';
import { waterYearMaxima, gumbelLmoments } from '../src/climate.mjs';
import { RIVER_SITES, RAIN_SITES, DAMS } from '../src/stations.mjs';

const RIVER_PERIOD = ['1996-10-01', '2024-09-30']; // GloFAS v4 daily discharge on Open-Meteo starts 1997
const RAIN_PERIOD = ['1991-10-01', '2024-09-30'];
const SNAP_PERIOD = ['2018-10-01', '2019-09-30'];
const SNAP_STEPS = 3, SNAP_STEP = 0.05; // 7 × 7 cells, ±0.15°
const SNAP_SHARE = 0.25; // nearest cell carrying at least this share of the window's largest flow
const GAP = 4000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.error(m);
const cfg = { ...CONFIG, retryWaitMs: 30000, maxRetries: 8 };
const only = new Set(process.argv.slice(2));
const want = (id) => !only.size || only.has(id);
const file = new URL('../src/sites.json', import.meta.url);

let prev = { river: [], rain: [] };
try { prev = JSON.parse(await readFile(file, 'utf8')); } catch { /* first build */ }
const keep = (arr, id) => arr.find((s) => s.id === id);

function topYears(m) {
  return Object.values(m).sort((a, b) => b.v - a.v).slice(0, 3).map((o) => [o.t, +o.v.toFixed(1)]);
}

const river = [];
for (const [id, riverName, place, fa, prov, lat, lon] of RIVER_SITES) {
  if (!want(id)) { const k = keep(prev.river, id); if (k) river.push(k); continue; }
  log(`river ${id}`);
  const lats = [], lons = [];
  for (let i = -SNAP_STEPS; i <= SNAP_STEPS; i++) for (let j = -SNAP_STEPS; j <= SNAP_STEPS; j++) {
    lats.push((lat + i * SNAP_STEP).toFixed(3)); lons.push((lon + j * SNAP_STEP).toFixed(3));
  }
  const snap = await fetchJson(`${CONFIG.floodApi}?latitude=${lats}&longitude=${lons}&daily=river_discharge` +
    `&start_date=${SNAP_PERIOD[0]}&end_date=${SNAP_PERIOD[1]}`, { log, cfg });
  const cells = (Array.isArray(snap) ? snap : [snap]).map((x) => {
    const v = x.daily.river_discharge.filter((y) => y != null);
    return { lat: x.latitude, lon: x.longitude, mean: v.reduce((p, c) => p + c, 0) / Math.max(v.length, 1) };
  });
  const top = Math.max(...cells.map((c) => c.mean));
  // the river nearest the town that carries a real share of the window's largest flow
  // (keeps a town on a tributary, e.g. Pol-e Dokhtar, on its own river)
  const best = cells.filter((c) => c.mean >= SNAP_SHARE * top)
    .map((c) => ({ ...c, d: Math.hypot(c.lat - lat, (c.lon - lon) * Math.cos((lat * Math.PI) / 180)) }))
    .sort((a, b) => a.d - b.d)[0];
  await sleep(GAP);
  const h = await fetchJson(`${CONFIG.floodApi}?latitude=${best.lat}&longitude=${best.lon}&daily=river_discharge` +
    `&start_date=${RIVER_PERIOD[0]}&end_date=${RIVER_PERIOD[1]}`, { log, cfg });
  const m = waterYearMaxima(h.daily.time, h.daily.river_discharge);
  const all = h.daily.river_discharge.filter((v) => v != null);
  river.push({
    id, river: riverName, place, fa, prov, lat, lon, dam: DAMS[id] || null,
    slat: +h.latitude.toFixed(3), slon: +h.longitude.toFixed(3), snapKm: +(best.d * 111).toFixed(1),
    meanQ: +(all.reduce((p, c) => p + c, 0) / all.length).toFixed(1),
    nYears: Object.keys(m).length,
    thr: gumbelLmoments(Object.values(m).map((o) => o.v)),
    top: topYears(m),
  });
  await sleep(GAP);
}

const rain = [];
for (const [id, name, fa, prov, lat, lon] of RAIN_SITES) {
  if (!want(id)) { const k = keep(prev.rain, id); if (k) rain.push(k); continue; }
  log(`rain ${id}`);
  const h = await fetchJson(`https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}` +
    `&start_date=${RAIN_PERIOD[0]}&end_date=${RAIN_PERIOD[1]}&daily=precipitation_sum&models=era5` +
    `&timezone=${encodeURIComponent(CONFIG.timezone)}`, { log, cfg });
  const v = h.daily.precipitation_sum;
  const v3 = v.map((_, d) => (d < 2 || v[d] == null || v[d - 1] == null || v[d - 2] == null ? null : v[d] + v[d - 1] + v[d - 2]));
  const m = waterYearMaxima(h.daily.time, v);
  const m3 = waterYearMaxima(h.daily.time, v3);
  const years = Object.keys(m).length;
  rain.push({
    id, name, fa, prov, lat, lon,
    glat: +h.latitude.toFixed(3), glon: +h.longitude.toFixed(3),
    annual: Math.round(v.filter((x) => x != null).reduce((a, b) => a + b, 0) / years),
    nYears: years,
    thr: gumbelLmoments(Object.values(m).map((o) => o.v)),
    thr3: gumbelLmoments(Object.values(m3).map((o) => o.v)),
    top: topYears(m),
    top3: topYears(m3),
  });
  await sleep(GAP);
}

const out = {
  info: {
    built: new Date().toISOString().slice(0, 10),
    riverPeriod: 'water years 1997–2024', riverStartYear: 1997,
    rainPeriod: 'water years 1992–2024', rainStartYear: 1992,
    rainDays: 'Iran local days (Asia/Tehran)',
    method: 'Gumbel (L-moments) on water-year (Oct–Sep) maxima of daily values (rain: 1-day and 3-day totals)',
  },
  river, rain,
};
await writeFile(file, JSON.stringify(out, null, 1));
log(`wrote ${river.length} river and ${rain.length} rain sites`);
