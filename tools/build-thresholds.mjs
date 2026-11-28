#!/usr/bin/env node
// Copyright © 2026 Parisa Abbasalizadehrezaei. All rights reserved. See LICENSE.
// Builds src/sites.json: snaps river sites to the GloFAS network, and computes 2/5/20/50-year
// return levels for every site (rain points: rain alone and rain on wet ground / snowmelt).
// Heavy on the API (long daily histories). It saves after every site and can be re-run: sites
// that are already complete are skipped unless --all is given, and it stops cleanly when the
// daily Open-Meteo limit is reached, so a later run carries on where it stopped.
//
//   node tools/build-thresholds.mjs --rain                  rain points missing the wet-ground levels
//   node tools/build-thresholds.mjs --rain --all            every rain point
//   node tools/build-thresholds.mjs --river                 river sites on GloFAS v4
//   node tools/build-thresholds.mjs --glofas 5              river sites on GloFAS v5 (stored as site.v5)
//   node tools/build-thresholds.mjs --rain tehran shiraz    only these ids
//   node tools/build-thresholds.mjs --rain --all --shard 1/3   every third site (parallel runners)
// Exit code 3 means "stopped at the API limit, run again later". The ids it rebuilt are listed in
// sites.info.touched, so tools/merge-sites.mjs can fold parallel builds into one file.

import { readFile, writeFile } from 'node:fs/promises';
import { fetchJson, CONFIG } from '../src/engine.mjs';
import { waterYearMaxima, gumbelLmoments } from '../src/climate.mjs';
import { rainThresholds, RAIN_PERIOD, RAIN_VARS } from '../src/thresholds.mjs';
import { RIVER_SITES, RAIN_SITES, DAMS } from '../src/stations.mjs';

const args = process.argv.slice(2);
const has = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const ids = new Set(args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1] === '--glofas')));
const shardArg = opt('--shard');
const [shardK, shardN] = shardArg ? shardArg.split('/').map(Number) : [0, 1];
const order = new Map([...RAIN_SITES.map((r, i) => [r[0], i]), ...RIVER_SITES.map((r, i) => [r[0], i])]);
const want = (id) => (!ids.size || ids.has(id)) && (order.get(id) ?? 0) % shardN === shardK;
const glofasV = +(opt('--glofas') || 0);

const RIVER_PERIOD = { 4: ['1996-10-01', '2024-09-30'], 5: ['1980-10-01', '2025-09-30'] };
const SNAP_PERIOD = ['2018-10-01', '2019-09-30'];
const SNAP_STEPS = 3, SNAP_STEP = 0.05; // 7 × 7 cells, ±0.15°
const SNAP_SHARE = 0.25; // nearest cell carrying at least this share of the window's largest flow
const GAP = +(process.env.BUILD_GAP_MS || 65000); // a 33-year daily record weighs several hundred calls

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.error(m);
const cfg = { ...CONFIG, retryWaitMs: 65000, maxRetries: 6 };
const file = new URL('../src/sites.json', import.meta.url);
const sites = JSON.parse(await readFile(file, 'utf8'));
const save = () => writeFile(file, JSON.stringify(sites, null, 1));
let changed = false;
sites.info.touched = [];
const touch = (kind, id) => { changed = true; sites.info.touched.push({ kind, id }); };
const tz = encodeURIComponent(CONFIG.timezone);

class LimitReached extends Error {}
async function get(url) {
  try { return await fetchJson(url, { log, cfg }); } catch (err) {
    if (/daily|hourly/i.test(err.message) && /limit/i.test(err.message)) throw new LimitReached(err.message);
    throw err;
  }
}

// Which flood model ids this GloFAS version answers to on Open-Meteo
async function glofasModels(v) {
  const probe = async (m) => { try { await fetchJson(`${CONFIG.floodApi}?latitude=31.3&longitude=48.6&daily=river_discharge&models=${m}&start_date=2020-01-01&end_date=2020-01-03`, { log, cfg: { ...cfg, maxRetries: 0 } }); return true; } catch { return false; } };
  const history = (await probe(`consolidated_v${v}`)) ? `consolidated_v${v}` : (await probe(`seamless_v${v}`)) ? `seamless_v${v}` : null;
  const forecast = (await probe(`seamless_v${v}`)) ? `seamless_v${v}` : (await probe(`forecast_v${v}`)) ? `forecast_v${v}` : null;
  return { history, forecast };
}

async function buildRiver(v) {
  const models = await glofasModels(v);
  if (!models.history || !models.forecast) throw new Error(`GloFAS v${v} is not on Open-Meteo yet (history: ${models.history}, forecast: ${models.forecast})`);
  log(`GloFAS v${v}: history from ${models.history}, forecasts from ${models.forecast}`);
  const [from, to] = RIVER_PERIOD[v];
  for (const [id, riverName, place, fa, prov, lat, lon] of RIVER_SITES) {
    if (!want(id)) continue;
    const have = sites.river.find((s) => s.id === id);
    if (!has('--all') && have && (v === 4 ? have.thr : have[`v${v}`])) continue;
    log(`river v${v} ${id}`);
    const lats = [], lons = [];
    for (let i = -SNAP_STEPS; i <= SNAP_STEPS; i++) for (let j = -SNAP_STEPS; j <= SNAP_STEPS; j++) {
      lats.push((lat + i * SNAP_STEP).toFixed(3)); lons.push((lon + j * SNAP_STEP).toFixed(3));
    }
    const snap = await get(`${CONFIG.floodApi}?latitude=${lats}&longitude=${lons}&daily=river_discharge&models=${models.history}` +
      `&start_date=${SNAP_PERIOD[0]}&end_date=${SNAP_PERIOD[1]}`);
    const cells = (Array.isArray(snap) ? snap : [snap]).map((x) => {
      const q = x.daily.river_discharge.filter((y) => y != null);
      return { lat: x.latitude, lon: x.longitude, mean: q.reduce((p, c) => p + c, 0) / Math.max(q.length, 1) };
    });
    const top = Math.max(...cells.map((c) => c.mean));
    // the river nearest the town that carries a real share of the window's largest flow
    // (keeps a town on a tributary, e.g. Pol-e Dokhtar, on its own river)
    const best = cells.filter((c) => c.mean >= SNAP_SHARE * top)
      .map((c) => ({ ...c, d: Math.hypot(c.lat - lat, (c.lon - lon) * Math.cos((lat * Math.PI) / 180)) }))
      .sort((a, b) => a.d - b.d)[0];
    await sleep(GAP);
    const h = await get(`${CONFIG.floodApi}?latitude=${best.lat}&longitude=${best.lon}&daily=river_discharge&models=${models.history}` +
      `&start_date=${from}&end_date=${to}`);
    const m = waterYearMaxima(h.daily.time, h.daily.river_discharge);
    const all = h.daily.river_discharge.filter((q) => q != null);
    const part = {
      slat: +h.latitude.toFixed(3), slon: +h.longitude.toFixed(3), snapKm: +(best.d * 111).toFixed(1),
      meanQ: +(all.reduce((p, c) => p + c, 0) / all.length).toFixed(1),
      nYears: Object.keys(m).length,
      thr: gumbelLmoments(Object.values(m).map((o) => o.v)),
      top: Object.values(m).sort((a, b) => b.v - a.v).slice(0, 3).map((o) => [o.t, +o.v.toFixed(1)]),
    };
    const base = { id, river: riverName, place, fa, prov, lat, lon, dam: DAMS[id] || null };
    const i = sites.river.findIndex((s) => s.id === id);
    if (v === 4) sites.river[i >= 0 ? i : sites.river.length] = { ...(i >= 0 ? sites.river[i] : {}), ...base, ...part };
    else if (i >= 0) sites.river[i] = { ...sites.river[i], [`v${v}`]: part };
    sites.info.glofasModels = { ...(sites.info.glofasModels || {}), [v]: models.forecast };
    sites.info[`riverPeriodV${v}`] = `water years ${+from.slice(0, 4) + 1}–${to.slice(0, 4)}`;
    touch('river', id);
    await save();
    await sleep(GAP);
  }
}

async function buildRain() {
  for (const [id, name, fa, prov, lat, lon] of RAIN_SITES) {
    if (!want(id)) continue;
    const have = sites.rain.find((s) => s.id === id);
    if (!has('--all') && have && have.thrE) continue;
    log(`rain ${id}`);
    const h = await get(`https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}` +
      `&start_date=${RAIN_PERIOD[0]}&end_date=${RAIN_PERIOD[1]}&daily=${RAIN_VARS}&models=era5&timezone=${tz}`);
    const t = rainThresholds(h.daily);
    const site = { ...(have || {}), id, name, fa, prov, lat, lon, glat: +h.latitude.toFixed(3), glon: +h.longitude.toFixed(3), ...t };
    const i = sites.rain.findIndex((s) => s.id === id);
    sites.rain[i >= 0 ? i : sites.rain.length] = site;
    touch('rain', id);
    log(`  2-yr day ${t.thr.rp2} mm, wet-ground 2-yr ${t.thrE.rp2} mm; alert days/yr ${t.alertDaysPerYear.rainOnly} → ${t.alertDaysPerYear.withGround}`);
    await save();
    await sleep(GAP);
  }
  sites.info.rainPeriod = `water years ${+RAIN_PERIOD[0].slice(0, 4) + 1}–${RAIN_PERIOD[1].slice(0, 4)}`;
  sites.info.groundMethod = 'E = soil-wetness share × (liquid rain + degree-day snowmelt); Gumbel return levels of 1-day and 3-day E from ERA5';
}

try {
  if (has('--rain')) await buildRain();
  if (has('--river')) await buildRiver(4);
  if (glofasV) await buildRiver(glofasV);
  // a new date tells the update run to refetch everything with the new thresholds
  if (changed) { sites.info.built = new Date().toISOString().slice(0, 10); await save(); }
  log(changed ? 'done' : 'nothing to rebuild');
} catch (err) {
  if (changed) sites.info.built = new Date().toISOString().slice(0, 10);
  await save();
  if (err instanceof LimitReached) { log(`Stopped at the Open-Meteo limit (${err.message}); progress saved — run again later.`); process.exit(3); }
  throw err;
}
