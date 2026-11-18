// Copyright © 2026 Parisa Abbasalizadehrezaei. All rights reserved. See LICENSE.
// Iran Flood Watch — warning engine
// Runs unchanged in Node (>= 18) and in the browser: it only needs a global fetch().
//
// River floods: GloFAS v4 ensemble discharge forecasts (51 members, 30 days) from the
// Open-Meteo Flood API, compared with 2-, 5- and 20-year return levels of the same
// model's own climatology (model-consistent thresholds, as GloFAS itself does).
// Flash floods: ECMWF IFS ensemble rainfall (51 members, 15 days), summed over Iran local
// days (Asia/Tehran) and over 3-day windows, compared with return levels of ERA5 rainfall
// computed the same way.

export const CONFIG = {
  floodApi: 'https://flood-api.open-meteo.com/v1/flood',
  ensembleApi: 'https://ensemble-api.open-meteo.com/v1/ensemble',
  floodMeta: 'https://flood-api.open-meteo.com/data/glofas_forecast_v4/static/meta.json',
  rainMeta: 'https://ensemble-api.open-meteo.com/data/ecmwf_ifs025_ensemble/static/meta.json',
  rainModel: 'ecmwf_ifs025',
  timezone: 'Asia/Tehran',
  riverPastDays: 14,
  riverForecastDays: 30,
  riverAlertHorizon: 30, // days that can raise a river alert
  rainForecastDays: 15,
  rainAlertHorizon: 10,  // rainfall skill drops fast after ~10 days
  // A day reaches a level when the share of ensemble members above the threshold
  // is at least minProb. Checked from the most severe level down.
  levels: [
    { level: 3, key: 'severe', label: 'Severe', rp: 'rp20', minProb: 0.30 },
    { level: 2, key: 'high', label: 'High', rp: 'rp5', minProb: 0.30 },
    { level: 1, key: 'moderate', label: 'Moderate', rp: 'rp2', minProb: 0.50 },
  ],
  // A model run older than this (hours since its start time) is flagged as stale
  staleHours: { glofas: 48, ecmwf: 30 },
  requestGapMs: 1500,  // pause between requests (Open-Meteo fair-use limits)
  retryWaitMs: 20000,  // first back-off when the per-minute limit is hit
  maxRetries: 5,
};

export const LEVEL_NAMES = ['Normal', 'Moderate', 'High', 'Severe'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (v, d = 2) => (v == null || !isFinite(v) ? null : +(+v).toFixed(d));
// 3 significant digits keeps the snapshot small without losing anything a reader can see
const sig = (v) => (v == null || !isFinite(v) ? null : +(+v).toPrecision(3));

export async function fetchJson(url, { log = () => {}, cfg = CONFIG } = {}) {
  let wait = cfg.retryWaitMs;
  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    let body = null;
    try {
      const res = await fetch(url);
      body = await res.json();
      if (res.ok && !(body && body.error)) return body;
    } catch (err) {
      body = { reason: String(err) };
    }
    const reason = (body && body.reason) || 'unknown error';
    if (attempt === cfg.maxRetries) throw new Error(`Request failed: ${reason} — ${url}`);
    log(`  retry in ${Math.round(wait / 1000)} s (${reason})`);
    await sleep(wait);
    wait = Math.min(wait * 2, 120000);
  }
}

// Start and availability time of the newest model runs
export async function modelRuns({ log = () => {}, cfg = CONFIG } = {}) {
  const iso = (s) => (s ? new Date(s * 1000).toISOString() : null);
  const one = async (url) => {
    const m = await fetchJson(url, { log, cfg });
    return { init: iso(m.last_run_initialisation_time), available: iso(m.last_run_availability_time) };
  };
  return { glofas: await one(cfg.floodMeta), ecmwf: await one(cfg.rainMeta) };
}

// Linear-interpolated quantile of a sorted array
export function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
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
      const l = p.lvl[d] ?? 0;
      if (l > level) { level = l; levelDay = d; trigger = k; }
      if (l > 0 && firstAlertDay == null) firstAlertDay = d;
    });
    if ((main.p50[d] ?? -1) > (main.p50[peakDay] ?? -1)) peakDay = d;
  }
  const maxProb = (k) => Math.max(0, ...parts.flatMap((p) => p[k].slice(0, h).map((v) => v ?? 0)));
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
  for (const fc of fcs) for (const k of Object.keys(fc)) fc[k] = fc[k].slice(0, last + 1);
  return fcs;
}

export function summarizeEnsemble(dayMembers, thr, horizon, cfg = CONFIG) {
  const [fc] = trimEmptyTail(ensembleStats(dayMembers, thr, cfg));
  return { fc, ...assess([fc], horizon) };
}

export async function runRiver(stations, { log = () => {}, cfg = CONFIG } = {}) {
  const out = [];
  for (const st of stations) {
    const url = `${cfg.floodApi}?latitude=${st.slat}&longitude=${st.slon}&daily=river_discharge` +
      `&ensemble=true&past_days=${cfg.riverPastDays}&forecast_days=${cfg.riverForecastDays}`;
    log(`river  ${st.id}`);
    try {
      const j = await fetchJson(url, { log, cfg });
      const moved = Math.hypot(j.latitude - st.slat, j.longitude - st.slon);
      const members = membersByDay(j.daily, 'river_discharge');
      const split = cfg.riverPastDays;
      const control = j.daily.river_discharge;
      const sum = summarizeEnsemble(members.slice(split), st.thr, cfg.riverAlertHorizon, cfg);
      const qNow = control[split - 1];
      out.push({
        ...st,
        cellShifted: moved > 0.01,
        past: { start: j.daily.time[0], q: control.slice(0, split).map(sig) },
        fcStart: j.daily.time[split],
        ...sum,
        qNow: sig(qNow),
        nowRatio: round(qNow / st.thr.rp2, 3),
      });
    } catch (err) {
      log(`  FAILED ${st.id}: ${err.message}`);
      out.push({ ...st, error: err.message, level: null });
    }
    await sleep(cfg.requestGapMs);
  }
  return out;
}

export async function runRain(points, { log = () => {}, cfg = CONFIG } = {}) {
  const out = [];
  const PAST = 2; // the two days before today complete the first 3-day windows
  for (const p of points) {
    const url = `${cfg.ensembleApi}?latitude=${p.lat}&longitude=${p.lon}&daily=precipitation_sum` +
      `&models=${cfg.rainModel}&forecast_days=${cfg.rainForecastDays}&past_days=${PAST}` +
      `&timezone=${encodeURIComponent(cfg.timezone)}`;
    log(`rain   ${p.id}`);
    try {
      const j = await fetchJson(url, { log, cfg });
      const series = memberSeries(j.daily, 'precipitation_sum');
      const byDay = (ser) => j.daily.time.map((_, i) => ser.map((s) => s[i])).slice(PAST);
      const [fc, fc3] = trimEmptyTail(ensembleStats(byDay(series), p.thr, cfg), ensembleStats(byDay(rollingSums(series, 3)), p.thr3, cfg));
      const a = assess([fc, fc3], cfg.rainAlertHorizon);
      out.push({
        ...p, fcStart: j.daily.time[PAST], fc, fc3,
        ...a, trigger: a.trigger == null ? null : ['1-day', '3-day'][a.trigger],
      });
    } catch (err) {
      log(`  FAILED ${p.id}: ${err.message}`);
      out.push({ ...p, error: err.message, level: null });
    }
    await sleep(cfg.requestGapMs);
  }
  return out;
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

// Fetch whatever has a newer model run than `prev` (or everything when forced)
export async function runAll(sites, { log = () => {}, cfg = CONFIG, now = new Date(), prev = null, force = true, runs = null } = {}) {
  runs = runs || await modelRuns({ log, cfg });
  const same = (k) => prev && prev.runs && prev.runs[k] && prev.runs[k].init === runs[k].init &&
    prev.thresholdsInfo && prev.thresholdsInfo.built === sites.info.built;
  const reuseRiver = !force && same('glofas');
  const reuseRain = !force && same('ecmwf');
  if (reuseRiver) log('river: no new GloFAS run — keeping previous forecast');
  if (reuseRain) log('rain: no new ECMWF run — keeping previous forecast');
  const river = reuseRiver ? prev.river : await runRiver(sites.river, { log, cfg });
  const rain = reuseRain ? prev.rain : await runRain(sites.rain, { log, cfg });
  return {
    generated: now.toISOString(),
    runs,
    config: {
      levels: cfg.levels,
      riverAlertHorizon: cfg.riverAlertHorizon,
      rainAlertHorizon: cfg.rainAlertHorizon,
      rainModel: cfg.rainModel,
      timezone: cfg.timezone,
      staleHours: cfg.staleHours,
    },
    thresholdsInfo: sites.info,
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

const addDays = (start, i) => {
  const d = new Date(`${start}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
};

// Plain-text bulletin (console, notifications, GitHub issue body)
export function bulletin(snap, { minLevel = 1 } = {}) {
  const tehran = (iso) => iso ? new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Tehran', dateStyle: 'medium', timeStyle: 'short' }) : '–';
  const lines = [`Iran Flood Watch — updated ${tehran(snap.generated)} (Tehran time)`];
  if (snap.runs) lines.push(`Model runs: GloFAS ${snap.runs.glofas.init.slice(0, 13).replace('T', ' ')} UTC, ECMWF ensemble ${snap.runs.ecmwf.init.slice(0, 13).replace('T', ' ')} UTC`);
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
    lines.push(`- [${LEVEL_NAMES[x.level].toUpperCase()}] ${kind}: ${name} (${x.prov}) — from ${addDays(x.fcStart, x.firstAlertDay)}, ` +
      `strongest on ${addDays(x.fcStart, x.levelDay)}${x.trigger ? ` (${x.trigger} rain)` : ''}; ${peak} on ${addDays(x.fcStart, x.peakDay)}; ` +
      `P(>2y) ${Math.round(x.maxProb.rp2 * 100)}%, P(>5y) ${Math.round(x.maxProb.rp5 * 100)}%, P(>20y) ${Math.round(x.maxProb.rp20 * 100)}%`);
  }
  if (s.failed.length) lines.push(`Data missing for: ${s.failed.join(', ')}`);
  lines.push('Not an official warning. Follow the Iran Meteorological Organization and local authorities.');
  return lines.join('\n');
}
