// Copyright © 2026 Parisa Abbasalizadehrezaei. All rights reserved. See LICENSE.
// Iran Flood Watch — warning engine
// Runs unchanged in Node (>= 18) and in the browser: it only needs a global fetch().
//
// River floods: GloFAS ensemble discharge forecasts (51 members, 30 days) from the Open-Meteo
// Flood API, compared with 2-, 5- and 20-year return levels of the same model's own climate
// (model-consistent thresholds, as GloFAS itself does). The newest GloFAS version is used as
// soon as its forecasts are live and thresholds have been built for it (v5 from December 2026).
//
// Flash floods: a multi-model "grand ensemble" of seven global ensembles (276 members:
// ECMWF IFS and AIFS, Google WeatherNext 2, NOAA GEFS, DWD ICON, ECCC GEPS, Met Office
// MOGREPS-G), each model weighted equally. Rain is summed over Iran local days and 3-day
// windows and compared with ERA5 return levels computed the same way. A second check adds
// soil wetness and snowmelt (see climate.mjs): rain on soaked ground or melting snow can raise
// the warning, never lower it.

import { landState, effective } from './climate.mjs';

export const CONFIG = {
  floodApi: 'https://flood-api.open-meteo.com/v1/flood',
  ensembleApi: 'https://ensemble-api.open-meteo.com/v1/ensemble',
  floodMetaBase: 'https://flood-api.open-meteo.com/data/',
  ensembleMetaBase: 'https://ensemble-api.open-meteo.com/data/',
  glofasVersions: [5, 4], // newest first
  rainModels: [
    { key: 'ifs', id: 'ecmwf_ifs025_ensemble', meta: 'ecmwf_ifs025_ensemble', name: 'ECMWF IFS ENS', org: 'ECMWF', ai: false, staleHours: 30 },
    { key: 'aifs', id: 'ecmwf_aifs025_ensemble', meta: 'ecmwf_aifs025_ensemble', name: 'ECMWF AIFS ENS', org: 'ECMWF', ai: true, staleHours: 30 },
    { key: 'wn2', id: 'google_weathernext2_ensemble', meta: 'google_weathernext2_ensemble', name: 'Google WeatherNext 2', org: 'Google DeepMind', ai: true, staleHours: 42 },
    { key: 'gefs', id: 'ncep_gefs025', meta: 'ncep_gefs025', name: 'NOAA GEFS', org: 'NOAA', ai: false, staleHours: 30 },
    { key: 'icon', id: 'dwd_icon_global_eps', meta: 'dwd_icon_global_eps_native', name: 'DWD ICON-EPS', org: 'DWD', ai: false, staleHours: 42 },
    { key: 'gem', id: 'cmc_gem_geps', meta: 'cmc_gem_geps', name: 'ECCC GEPS', org: 'Environment Canada', ai: false, staleHours: 42 },
    { key: 'ukmo', id: 'ukmo_global_ensemble_20km', meta: 'ukmo_global_ensemble_20km', name: 'Met Office MOGREPS-G', org: 'UK Met Office', ai: false, staleHours: 30 },
  ],
  landModel: 'ecmwf_ifs025_ensemble_mean', // soil moisture, snowfall, temperature, snowpack
  timezone: 'Asia/Tehran',
  riverPastDays: 14,
  riverForecastDays: 30,
  riverAlertHorizon: 30, // days that can raise a river alert
  rainPastDays: 2,       // the two days before today complete the first 3-day windows
  rainForecastDays: 16,
  rainAlertHorizon: 10,  // rainfall skill drops fast after ~10 days
  // A day reaches a level when the (model-weighted) share of ensemble members above the
  // threshold is at least minProb. Checked from the most severe level down.
  levels: [
    { level: 3, key: 'severe', label: 'Severe', rp: 'rp20', minProb: 0.30 },
    { level: 2, key: 'high', label: 'High', rp: 'rp5', minProb: 0.30 },
    { level: 1, key: 'moderate', label: 'Moderate', rp: 'rp2', minProb: 0.50 },
  ],
  staleHours: { glofas: 48 }, // rain models carry their own limit
  riverBatch: 10,       // sites per request
  rainBatch: 9,
  requestGapMs: 4000,   // pause between requests (Open-Meteo fair-use limits)
  retryWaitMs: 20000,   // first back-off when the per-minute limit is hit
  maxRetries: 5,
};

export const LEVEL_NAMES = ['Normal', 'Moderate', 'High', 'Severe'];
export const RAIN_CHECKS = [
  { key: 'fc', label: '1-day rain' },
  { key: 'fc3', label: '3-day rain' },
  { key: 'fcw', label: '1-day rain on wet ground or snowmelt' },
  { key: 'fcw3', label: '3-day rain on wet ground or snowmelt' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (v, d = 2) => (v == null || !isFinite(v) ? null : +(+v).toFixed(d));
// 3 significant digits keeps the snapshot small without losing anything a reader can see
const sig = (v) => (v == null || !isFinite(v) ? null : +(+v).toPrecision(3));
const r1 = (s) => s.map((v) => (v == null ? null : +(+v).toFixed(1)));
const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const asList = (j) => (Array.isArray(j) ? j : [j]);
export const tehranDate = (d, tz = CONFIG.timezone) => new Date(d).toLocaleDateString('en-CA', { timeZone: tz });

export async function fetchJson(url, { log = () => {}, cfg = CONFIG } = {}) {
  let wait = cfg.retryWaitMs;
  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    let body = null;
    try {
      const res = await fetch(url);
      body = await res.json();
      if (res.ok && !(body && body.error)) return body;
      if (res.status === 404) throw new Error('not found');
    } catch (err) {
      if (err.message === 'not found') throw new Error(`Not found — ${url}`);
      body = { reason: String(err) };
    }
    const reason = (body && body.reason) || 'unknown error';
    if (attempt === cfg.maxRetries) throw new Error(`Request failed: ${reason} — ${url}`);
    log(`  retry in ${Math.round(wait / 1000)} s (${reason})`);
    await sleep(wait);
    wait = Math.min(wait * 2, 120000);
  }
}

// Start and availability time of the newest run of every model
export async function modelRuns({ log = () => {}, cfg = CONFIG } = {}) {
  const iso = (s) => (s ? new Date(s * 1000).toISOString() : null);
  const one = async (url, retries) => {
    try {
      const m = await fetchJson(url, { log, cfg: { ...cfg, maxRetries: retries, retryWaitMs: 3000 } });
      return { init: iso(m.last_run_initialisation_time), available: iso(m.last_run_availability_time) };
    } catch { return null; }
  };
  const glofasLatest = {};
  for (const v of cfg.glofasVersions) glofasLatest[v] = await one(`${cfg.floodMetaBase}glofas_forecast_v${v}/static/meta.json`, v === 4 ? 3 : 0);
  const rain = {};
  for (const m of cfg.rainModels) rain[m.key] = await one(`${cfg.ensembleMetaBase}${m.meta}/static/meta.json`, 3);
  return { glofasLatest, rain };
}

// Newest GloFAS version that is live, fresh and has thresholds; asks for a rebuild when a newer
// version is live but its thresholds are missing
export function pickGlofas(latest, sites, { cfg = CONFIG, now = new Date() } = {}) {
  let needRebuild = null;
  for (const v of cfg.glofasVersions) {
    const r = latest && latest[v];
    if (!r || !r.init) continue;
    if ((now - Date.parse(r.init)) / 3.6e6 > cfg.staleHours.glofas) continue;
    const ready = v === 4 || (sites.river.length && sites.river.every((s) => s[`v${v}`] && s[`v${v}`].thr));
    if (ready) return { use: { version: v, ...r }, needRebuild };
    needRebuild = needRebuild || `glofas-v${v}`;
  }
  return { use: { version: 4, ...((latest && latest[4]) || { init: null, available: null }) }, needRebuild };
}

export const riverSite = (st, v) => (v === 4 || !st[`v${v}`] ? st : { ...st, ...st[`v${v}`] });

// Linear-interpolated quantile of a sorted array
export function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// Quantile of weighted values [[v, w], ...] (step function on the cumulative weight)
export function weightedQuantile(pairs, q) {
  const s = pairs.filter(([v, w]) => v != null && isFinite(v) && w > 0).sort((a, b) => a[0] - b[0]);
  if (!s.length) return null;
  const total = s.reduce((t, [, w]) => t + w, 0);
  let cum = 0;
  for (const [v, w] of s) { cum += w; if (cum >= q * total - 1e-12) return v; }
  return s[s.length - 1][0];
}

// One time series per ensemble member (control first): [[day0, day1, ...], ...]
export function memberSeries(daily, variable) {
  const keys = Object.keys(daily).filter((k) => k === variable || k.startsWith(`${variable}_member`));
  return keys.map((k) => daily[k]);
}

// Every ensemble member of one variable for each day: [[m0, m1, ...], ...]
export function membersByDay(daily, variable) {
  const series = memberSeries(daily, variable);
  return daily.time.map((_, i) => series.map((s) => s[i]).filter((v) => v != null && isFinite(v)));
}

// n-day running sums of each member, aligned so element d covers days d-n+1 … d
export function rollingSums(series, n) {
  return series.map((s) => s.map((_, d) => {
    if (d < n - 1) return null;
    let t = 0;
    for (let k = d - n + 1; k <= d; k++) { if (s[k] == null) return null; t += s[k]; }
    return t;
  }));
}

export function dayLevel(probs, cfg = CONFIG) {
  for (const L of cfg.levels) if ((probs[L.rp] ?? 0) >= L.minProb) return L.level;
  return 0;
}

// Percentiles, exceedance probabilities and the level of each day
export function ensembleStats(dayMembers, thr, cfg = CONFIG) {
  const fc = { p10: [], p25: [], p50: [], p75: [], p90: [], pr2: [], pr5: [], pr20: [], lvl: [], n: [] };
  dayMembers.forEach((m) => {
    const s = m.filter((v) => v != null && isFinite(v)).sort((a, b) => a - b);
    const n = s.length || 1;
    const pr = {
      rp2: s.filter((v) => v > thr.rp2).length / n,
      rp5: s.filter((v) => v > thr.rp5).length / n,
      rp20: s.filter((v) => v > thr.rp20).length / n,
    };
    fc.p10.push(sig(quantile(s, 0.1)));
    fc.p25.push(sig(quantile(s, 0.25)));
    fc.p50.push(sig(quantile(s, 0.5)));
    fc.p75.push(sig(quantile(s, 0.75)));
    fc.p90.push(sig(quantile(s, 0.9)));
    fc.pr2.push(round(pr.rp2));
    fc.pr5.push(round(pr.rp5));
    fc.pr20.push(round(pr.rp20));
    fc.lvl.push(s.length ? dayLevel(pr, cfg) : 0);
    fc.n.push(s.length);
  });
  return fc;
}

// Overall level, onset, peak and ranking score from one or more per-day series
// (the first one carries the peak; all of them can raise the level)
export function assess(parts, horizon) {
  const main = parts[0];
  const h = Math.min(horizon, main.lvl.length);
  let level = 0, levelDay = null, firstAlertDay = null, peakDay = 0, trigger = null;
  for (let d = 0; d < h; d++) {
    parts.forEach((p, k) => {
      if (!p) return;
      const l = p.lvl[d] ?? 0;
      if (l > level) { level = l; levelDay = d; trigger = k; }
      if (l > 0 && firstAlertDay == null) firstAlertDay = d;
    });
    if ((main.p50[d] ?? -1) > (main.p50[peakDay] ?? -1)) peakDay = d;
  }
  const maxProb = (k) => Math.max(0, ...parts.filter(Boolean).flatMap((p) => p[k].slice(0, h).map((v) => v ?? 0)));
  const mp = { rp2: maxProb('pr2'), rp5: maxProb('pr5'), rp20: maxProb('pr20') };
  const score = level * 10 + mp.rp20 * 3 + mp.rp5 * 2 + mp.rp2;
  return { level, levelDay, firstAlertDay, peakDay, trigger, score: round(score, 3), maxProb: mp };
}

// Drop trailing days that no ensemble member reaches (the newest run can end mid-day),
// so a missing day is never shown as a dry or calm one
export function trimEmptyTail(...fcs) {
  const n = fcs[0].n;
  let last = n.length - 1;
  while (last >= 0 && !n[last]) last--;
  for (const fc of fcs) if (fc) for (const k of Object.keys(fc)) fc[k] = fc[k].slice(0, last + 1);
  return fcs;
}

export function summarizeEnsemble(dayMembers, thr, horizon, cfg = CONFIG) {
  const [fc] = trimEmptyTail(ensembleStats(dayMembers, thr, cfg));
  return { fc, ...assess([fc], horizon) };
}

// ------------------------------------------------------------------------------------- rivers

function riverResult(st, j, cfg) {
  const moved = Math.hypot(j.latitude - st.slat, j.longitude - st.slon);
  const members = membersByDay(j.daily, 'river_discharge');
  const split = cfg.riverPastDays;
  const control = j.daily.river_discharge;
  const sum = summarizeEnsemble(members.slice(split), st.thr, cfg.riverAlertHorizon, cfg);
  const qNow = control[split - 1];
  return {
    ...st,
    cellShifted: moved > 0.01,
    past: { start: j.daily.time[0], q: control.slice(0, split).map(sig) },
    fcStart: j.daily.time[split],
    ...sum,
    qNow: sig(qNow),
    nowRatio: round(qNow / st.thr.rp2, 3),
  };
}

export async function runRiver(stations, { version = 4, model = null, log = () => {}, cfg = CONFIG } = {}) {
  const out = [];
  const sts = stations.map((s) => riverSite(s, version));
  const m = model || `seamless_v${version}`;
  for (const batch of chunks(sts, cfg.riverBatch)) {
    const url = `${cfg.floodApi}?latitude=${batch.map((s) => s.slat)}&longitude=${batch.map((s) => s.slon)}` +
      `&daily=river_discharge&ensemble=true&models=${m}&past_days=${cfg.riverPastDays}&forecast_days=${cfg.riverForecastDays}`;
    log(`river  ${batch.map((s) => s.id).join(', ')}`);
    try {
      const list = asList(await fetchJson(url, { log, cfg }));
      batch.forEach((st, k) => {
        try { out.push(riverResult(st, list[k], cfg)); } catch (err) { out.push({ ...st, error: err.message, level: null }); }
      });
    } catch (err) {
      log(`  FAILED: ${err.message}`);
      batch.forEach((st) => out.push({ ...st, error: err.message, level: null }));
    }
    await sleep(cfg.requestGapMs);
  }
  return out;
}

// --------------------------------------------------------------------------------------- rain

// Daily rain of every member of one model at every rain point
export async function fetchRainModel(model, points, { log = () => {}, cfg = CONFIG } = {}) {
  const sites = {};
  for (const batch of chunks(points, cfg.rainBatch)) {
    const url = `${cfg.ensembleApi}?latitude=${batch.map((p) => p.lat)}&longitude=${batch.map((p) => p.lon)}` +
      `&daily=precipitation_sum,snowfall_water_equivalent_sum&models=${model.id}&forecast_days=${cfg.rainForecastDays}` +
      `&past_days=${cfg.rainPastDays}&timezone=${encodeURIComponent(cfg.timezone)}`;
    log(`rain   ${model.key}: ${batch.map((p) => p.id).join(', ')}`);
    const list = asList(await fetchJson(url, { log, cfg }));
    batch.forEach((p, k) => {
      const d = list[k].daily;
      // p: precipitation, s: snowfall water equivalent (liquid rain = p − s; some models split
      // rain from showers, so this is the one definition that works for all seven)
      sites[p.id] = { time: d.time, p: memberSeries(d, 'precipitation_sum').map(r1), s: memberSeries(d, 'snowfall_water_equivalent_sum').map(r1) };
    });
    await sleep(cfg.requestGapMs);
  }
  return sites;
}

// Soil moisture, snowfall, temperature and snowpack (ECMWF ensemble mean) at every rain point
export async function fetchLand(points, { log = () => {}, cfg = CONFIG } = {}) {
  const sites = {};
  for (const batch of chunks(points, cfg.rainBatch)) {
    const url = `${cfg.ensembleApi}?latitude=${batch.map((p) => p.lat)}&longitude=${batch.map((p) => p.lon)}` +
      `&daily=temperature_2m_mean,snowfall_water_equivalent_sum,soil_moisture_0_to_7cm_mean,soil_moisture_7_to_28cm_mean` +
      `&hourly=snow_depth_water_equivalent&models=${cfg.landModel}&forecast_days=${cfg.rainForecastDays}` +
      `&past_days=${cfg.rainPastDays}&timezone=${encodeURIComponent(cfg.timezone)}`;
    log(`land   ${batch.map((p) => p.id).join(', ')}`);
    const list = asList(await fetchJson(url, { log, cfg }));
    batch.forEach((p, k) => {
      const d = list[k].daily, h = list[k].hourly || {};
      sites[p.id] = {
        time: d.time,
        temp: r1(d.temperature_2m_mean), snowfall: r1(d.snowfall_water_equivalent_sum),
        sm1: d.soil_moisture_0_to_7cm_mean.map(sig), sm2: d.soil_moisture_7_to_28cm_mean.map(sig),
        swe0: (h.snow_depth_water_equivalent || [0])[0] ?? 0,
      };
    });
    await sleep(cfg.requestGapMs);
  }
  return sites;
}

const PROB_KEYS = [['rp2', 'pr2'], ['rp5', 'pr5'], ['rp20', 'pr20']];

// Combine every model's members into one forecast for a rain point
export function combineRain(p, models, landSite, { cfg = CONFIG, today } = {}) {
  // ground state by date (only when the site has a soil range and wet-ground thresholds)
  const landByDate = new Map();
  let land = null;
  if (landSite && p.soilRange && p.thrE) {
    const L = landState({ ...landSite, pack0: landSite.swe0 }, p.soilRange);
    landSite.time.forEach((t, i) => landByDate.set(t, { w: L.w[i], share: L.share[i], melt: L.melt[i] }));
    land = L;
  }
  const dates = [...new Set(models.flatMap((m) => m.data.time.filter((t) => t >= today)))].sort().slice(0, cfg.rainForecastDays);
  const checks = [
    { key: 'fc', thr: p.thr, pick: (v) => v.p1 },
    { key: 'fc3', thr: p.thr3, pick: (v) => v.p3 },
    { key: 'fcw', thr: p.thrE, pick: (v) => v.e1 },
    { key: 'fcw3', thr: p.thrE3, pick: (v) => v.e3 },
  ].filter((c) => c.thr);

  // per model: member values for each target date
  const perModel = models.map((m) => {
    const idx = new Map(m.data.time.map((t, i) => [t, i]));
    const E = m.data.p.map((ps, k) => ps.map((pv, i) => {
      const g = landByDate.get(m.data.time[i]);
      if (!g || pv == null) return null;
      const snow = (m.data.s && m.data.s[k] && m.data.s[k][i]) || 0;
      return effective(Math.max(0, pv - snow), g.melt, g.share);
    }));
    const P3 = rollingSums(m.data.p, 3), E3 = rollingSums(E, 3);
    const byDate = dates.map((t) => {
      const i = idx.get(t);
      if (i == null) return null;
      const vals = m.data.p.map((s, k) => ({ p1: s[i], p3: P3[k][i], e1: E[k][i], e3: E3[k][i] }));
      return vals;
    });
    return { key: m.key, init: m.init, byDate };
  });

  const out = {};
  for (const c of checks) {
    const fc = { p10: [], p25: [], p50: [], p75: [], p90: [], pr2: [], pr5: [], pr20: [], lvl: [], n: [], m: [] };
    dates.forEach((_, d) => {
      const pairs = [];
      const acc = { rp2: 0, rp5: 0, rp20: 0 };
      let wsum = 0, nm = 0, members = 0;
      for (const pm of perModel) {
        const vals = pm.byDate[d] && pm.byDate[d].map(c.pick).filter((v) => v != null && isFinite(v));
        if (!vals || !vals.length) continue;
        nm++; members += vals.length; wsum += 1;
        for (const [rp] of PROB_KEYS) acc[rp] += vals.filter((v) => v > c.thr[rp]).length / vals.length;
        vals.forEach((v) => pairs.push([v, 1 / vals.length]));
      }
      const pr = Object.fromEntries(PROB_KEYS.map(([rp]) => [rp, wsum ? acc[rp] / wsum : 0]));
      fc.p10.push(sig(weightedQuantile(pairs, 0.1)));
      fc.p25.push(sig(weightedQuantile(pairs, 0.25)));
      fc.p50.push(sig(weightedQuantile(pairs, 0.5)));
      fc.p75.push(sig(weightedQuantile(pairs, 0.75)));
      fc.p90.push(sig(weightedQuantile(pairs, 0.9)));
      for (const [rp, k] of PROB_KEYS) fc[k].push(round(pr[rp]));
      fc.lvl.push(members ? dayLevel(pr, cfg) : 0);
      fc.n.push(members);
      fc.m.push(nm);
    });
    out[c.key] = fc;
  }
  // keep the four parts the same length: cut days that no rain member reaches
  const parts = RAIN_CHECKS.map((c) => out[c.key] || null);
  trimEmptyTail(...parts);
  const a = assess(parts, cfg.rainAlertHorizon);
  const rainOnly = assess([out.fc, out.fc3], cfg.rainAlertHorizon);
  const nDays = out.fc.lvl.length;

  // each model's own level per day (the same rules on its own members), for the agreement view
  const modelView = perModel.map((pm) => {
    const lvl = [], maxP = { rp2: 0, rp5: 0, rp20: 0 };
    for (let d = 0; d < nDays; d++) {
      let l = null;
      for (const c of checks) {
        const vals = pm.byDate[d] && pm.byDate[d].map(c.pick).filter((v) => v != null && isFinite(v));
        if (!vals || !vals.length) continue;
        const pr = Object.fromEntries(PROB_KEYS.map(([rp]) => [rp, vals.filter((v) => v > c.thr[rp]).length / vals.length]));
        l = Math.max(l ?? 0, dayLevel(pr, cfg));
        if (d < cfg.rainAlertHorizon) for (const [rp] of PROB_KEYS) maxP[rp] = Math.max(maxP[rp], pr[rp]);
      }
      lvl.push(l);
    }
    return { key: pm.key, init: pm.init, lvl, maxP: Object.fromEntries(Object.entries(maxP).map(([k, v]) => [k, round(v)])) };
  });
  const agree = a.levelDay == null ? null : {
    alerting: modelView.filter((m) => (m.lvl[a.levelDay] ?? 0) >= 1).length,
    total: modelView.filter((m) => m.lvl[a.levelDay] != null).length,
  };

  let ground = null;
  if (land) {
    const at = (t) => landByDate.get(t) || {};
    const fdates = dates.slice(0, nDays);
    ground = {
      w: fdates.map((t) => round(at(t).w)),
      melt: fdates.map((t) => round(at(t).melt, 1)),
      wNow: round(at(today).w ?? land.w[cfg.rainPastDays]),
    };
  }
  return {
    ...p,
    fcStart: dates[0],
    fc: out.fc, fc3: out.fc3 || null, fcw: out.fcw || null, fcw3: out.fcw3 || null,
    ...a,
    trigger: a.trigger == null ? null : RAIN_CHECKS[a.trigger].label,
    levelRainOnly: rainOnly.level,
    boosted: a.level > rainOnly.level,
    models: modelView,
    agree,
    ground,
  };
}

export function usableModels(cache, runs, { cfg = CONFIG, now = new Date() } = {}) {
  return cfg.rainModels.filter((m) => {
    const c = cache.models && cache.models[m.key];
    if (!c || !c.init) return false;
    return (now - Date.parse(c.init)) / 3.6e6 <= m.staleHours;
  });
}

export async function runRain(points, runs, { cache = { models: {}, land: null }, force = false, log = () => {}, cfg = CONFIG, now = new Date() } = {}) {
  cache.models = cache.models || {};
  const covered = (c) => c && c.sites && points.every((p) => c.sites[p.id]);
  for (const m of cfg.rainModels) {
    const r = runs.rain && runs.rain[m.key];
    if (!r || !r.init) { log(`rain   ${m.key}: no run information — skipped`); continue; }
    const c = cache.models[m.key];
    if (!force && c && c.init === r.init && covered(c)) continue;
    try {
      cache.models[m.key] = { init: r.init, fetched: now.toISOString(), sites: await fetchRainModel(m, points, { log, cfg }) };
    } catch (err) {
      log(`  FAILED ${m.key}: ${err.message}${c ? ' — keeping its previous run' : ''}`);
    }
  }
  const ifsInit = runs.rain && runs.rain.ifs && runs.rain.ifs.init;
  if (force || !cache.land || cache.land.init !== ifsInit || !covered(cache.land)) {
    try { cache.land = { init: ifsInit, fetched: now.toISOString(), sites: await fetchLand(points, { log, cfg }) }; } catch (err) { log(`  FAILED land state: ${err.message}`); }
  }
  const use = usableModels(cache, runs, { cfg, now });
  const today = tehranDate(now, cfg.timezone);
  const rain = points.map((p) => {
    const models = use.map((m) => ({ key: m.key, init: cache.models[m.key].init, data: cache.models[m.key].sites[p.id] })).filter((m) => m.data);
    if (!models.length) return { ...p, error: 'no rain model data', level: null };
    try {
      return combineRain(p, models, cache.land && cache.land.sites && cache.land.sites[p.id], { cfg, today });
    } catch (err) {
      return { ...p, error: err.message, level: null };
    }
  });
  return { rain, used: use.map((m) => ({ key: m.key, init: cache.models[m.key].init })) };
}

export function summarize(river, rain) {
  const count = (arr) => [0, 1, 2, 3].map((l) => arr.filter((s) => s.level === l).length);
  const top = [...river.map((s) => ({ kind: 'river', s })), ...rain.map((s) => ({ kind: 'rain', s }))]
    .filter((x) => x.s.level > 0)
    .sort((a, b) => b.s.score - a.s.score)
    .map((x) => ({ kind: x.kind, id: x.s.id, level: x.s.level }));
  return {
    river: count(river),
    rain: count(rain),
    failed: [...river, ...rain].filter((s) => s.error).map((s) => s.id),
    maxLevel: Math.max(0, ...river.map((s) => s.level ?? 0), ...rain.map((s) => s.level ?? 0)),
    top,
  };
}

// True when nothing the forecast depends on has changed since `prev`
export function nothingNew(prev, runs, sites, { cfg = CONFIG, now = new Date() } = {}) {
  if (!prev || !prev.runs || !prev.runs.rain || !prev.runs.glofas) return false;
  if (!prev.thresholdsInfo || prev.thresholdsInfo.built !== sites.info.built) return false;
  const { use } = pickGlofas(runs.glofasLatest, sites, { cfg, now });
  if (prev.runs.glofas.version !== use.version || prev.runs.glofas.init !== use.init) return false;
  for (const m of cfg.rainModels) if ((prev.runs.rain[m.key] || {}).init !== (runs.rain[m.key] || {}).init) return false;
  // a new local day shifts the forecast days, so recompute once after midnight Tehran time
  return tehranDate(prev.generated, cfg.timezone) === tehranDate(now, cfg.timezone);
}

// Fetch whatever has a newer model run (or everything when forced) and build the snapshot
export async function runAll(sites, { log = () => {}, cfg = CONFIG, now = new Date(), prev = null, force = true, runs = null, cache = null } = {}) {
  runs = runs || await modelRuns({ log, cfg });
  const { use: gl, needRebuild } = pickGlofas(runs.glofasLatest, sites, { cfg, now });
  const sameRiver = !force && prev && prev.runs && prev.runs.glofas && prev.runs.glofas.init === gl.init &&
    prev.runs.glofas.version === gl.version && prev.thresholdsInfo && prev.thresholdsInfo.built === sites.info.built && prev.river;
  if (sameRiver) log('river: no new GloFAS run — keeping previous forecast');
  const glModel = sites.info && sites.info.glofasModels && sites.info.glofasModels[gl.version];
  const river = sameRiver ? prev.river : await runRiver(sites.river, { version: gl.version, model: glModel, log, cfg });
  cache = cache || { models: {}, land: null };
  const { rain, used } = await runRain(sites.rain, runs, { cache, force, log, cfg, now });
  return {
    generated: now.toISOString(),
    runs: { glofas: gl, glofasLatest: runs.glofasLatest, rain: runs.rain, used },
    config: {
      levels: cfg.levels,
      riverAlertHorizon: cfg.riverAlertHorizon,
      rainAlertHorizon: cfg.rainAlertHorizon,
      rainModels: cfg.rainModels.map(({ key, name, org, ai, staleHours }) => ({ key, name, org, ai, staleHours })),
      timezone: cfg.timezone,
      staleHours: cfg.staleHours,
    },
    thresholdsInfo: sites.info,
    needRebuild,
    summary: summarize(river, rain),
    river,
    rain,
  };
}

// Sites whose level went up since the previous snapshot
export function escalations(snap, prev) {
  const before = new Map();
  if (prev) for (const [kind, arr] of [['river', prev.river], ['rain', prev.rain]]) for (const s of arr || []) before.set(`${kind}:${s.id}`, s.level ?? 0);
  const out = [];
  for (const [kind, arr] of [['river', snap.river], ['rain', snap.rain]]) for (const s of arr) {
    const was = before.get(`${kind}:${s.id}`) ?? 0;
    if ((s.level ?? 0) > was) out.push({ kind, id: s.id, from: was, to: s.level });
  }
  return out;
}

export const addDays = (start, i) => {
  const d = new Date(`${start}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
};

const runLabel = (r) => (r && r.init ? `${r.init.slice(0, 13).replace('T', ' ')} UTC` : 'n/a');

// Plain-text bulletin (console, notifications, GitHub issue body)
export function bulletin(snap, { minLevel = 1 } = {}) {
  const tehran = (iso) => iso ? new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Tehran', dateStyle: 'medium', timeStyle: 'short' }) : '–';
  const lines = [`Iran Flood Watch — updated ${tehran(snap.generated)} (Tehran time)`];
  if (snap.runs) {
    lines.push(`River model: GloFAS v${snap.runs.glofas.version || 4}, run ${runLabel(snap.runs.glofas)}`);
    if (snap.runs.used) {
      const names = Object.fromEntries((snap.config.rainModels || []).map((m) => [m.key, m.name]));
      lines.push(`Rain models (${snap.runs.used.length}): ` + snap.runs.used.map((u) => `${names[u.key] || u.key} ${runLabel(u)}`).join('; '));
    }
  }
  const s = snap.summary;
  lines.push(`Rivers: ${s.river[3]} severe, ${s.river[2]} high, ${s.river[1]} moderate, ${s.river[0]} normal`);
  lines.push(`Rainfall: ${s.rain[3]} severe, ${s.rain[2]} high, ${s.rain[1]} moderate, ${s.rain[0]} normal`);
  const all = [...snap.river.map((x) => ['River', x]), ...snap.rain.map((x) => ['Rain', x])]
    .filter(([, x]) => (x.level ?? 0) >= minLevel)
    .sort((a, b) => b[1].score - a[1].score);
  if (!all.length) lines.push('No site at or above the selected level.');
  for (const [kind, x] of all) {
    const name = kind === 'River' ? `${x.river} at ${x.place}` : x.name;
    const peak = kind === 'River'
      ? `peak median ${round(x.fc.p50[x.peakDay] / x.thr.rp2, 2)}× the 2-year flood`
      : `wettest day median ${x.fc.p50[x.peakDay]} mm`;
    const extra = [];
    if (x.agree) extra.push(`${x.agree.alerting} of ${x.agree.total} models agree`);
    if (x.boosted) extra.push('raised by wet ground or snowmelt');
    if (x.pop && x.pop.n) extra.push(`about ${fmtPeople(x.pop.n)} people within ${x.pop.r} km`);
    lines.push(`- [${LEVEL_NAMES[x.level].toUpperCase()}] ${kind}: ${name} (${x.prov}) — from ${addDays(x.fcStart, x.firstAlertDay)}, ` +
      `strongest on ${addDays(x.fcStart, x.levelDay)}${x.trigger ? ` (${x.trigger})` : ''}; ${peak} on ${addDays(x.fcStart, x.peakDay)}; ` +
      `P(>2y) ${Math.round(x.maxProb.rp2 * 100)}%, P(>5y) ${Math.round(x.maxProb.rp5 * 100)}%, P(>20y) ${Math.round(x.maxProb.rp20 * 100)}%` +
      (extra.length ? `; ${extra.join('; ')}` : ''));
  }
  if (s.failed.length) lines.push(`Data missing for: ${s.failed.join(', ')}`);
  lines.push('Not an official warning. Follow the Iran Meteorological Organization and local authorities.');
  return lines.join('\n');
}

export function fmtPeople(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)} million`;
  if (n >= 1e4) return `${Math.round(n / 1e3)},000`;
  if (n >= 1e3) return `${(Math.round(n / 100) * 100).toLocaleString('en-US')}`;
  return String(Math.round(n / 10) * 10);
}
