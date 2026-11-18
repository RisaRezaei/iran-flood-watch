#!/usr/bin/env node
// Copyright © 2026 Parisa Abbasalizadehrezaei. All rights reserved. See LICENSE.
// Iran Flood Watch — update run.
//   node flood-watch.mjs                 fetch the newest forecasts → docs/index.html + docs/data/*
//   node flood-watch.mjs --if-new        only fetch the part (river / rain) whose model has a new run;
//                                        exits quietly when nothing is new (use this on a frequent schedule)
//   node flood-watch.mjs --out site      write somewhere else
//   node flood-watch.mjs --from-json f   re-render a saved snapshot without fetching
//   node flood-watch.mjs --archive       also keep a small record of every update in data/archive/
// Alerts: set NTFY_TOPIC (and NOTIFY_LEVEL, default 1 = Moderate) to get a phone notification through
// https://ntfy.sh as soon as any site reaches that level or goes up a level.

import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { runAll, modelRuns, bulletin, escalations, LEVEL_NAMES } from './src/engine.mjs';
import { renderHtml } from './src/render.mjs';

const args = process.argv.slice(2);
const has = (n) => args.includes(n);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
if (has('--help') || has('-h')) {
  const src = await readFile(new URL(import.meta.url), 'utf8');
  console.log(src.split('\n').slice(1, 12).join('\n').replace(/^\/\/ ?/gm, ''));
  process.exit(0);
}

const out = opt('--out', 'docs');
const log = (m) => console.error(m);
const sites = JSON.parse(await readFile(new URL('./src/sites.json', import.meta.url), 'utf8'));
let prev = null;
try { prev = JSON.parse(await readFile(`${out}/data/latest.json`, 'utf8')); } catch { /* first run */ }

const setOutput = async (pairs) => {
  if (!process.env.GITHUB_OUTPUT) return;
  await appendFile(process.env.GITHUB_OUTPUT, Object.entries(pairs).map(([k, v]) => `${k}=${v}\n`).join(''));
};

let snap;
const fromJson = opt('--from-json', null);
if (fromJson) {
  snap = JSON.parse(await readFile(fromJson, 'utf8'));
} else {
  const runs = await modelRuns({ log });
  log(`GloFAS run ${runs.glofas.init}, ECMWF ensemble run ${runs.ecmwf.init}`);
  const unchanged = prev && prev.runs && prev.thresholdsInfo && prev.thresholdsInfo.built === sites.info.built &&
    prev.runs.glofas.init === runs.glofas.init && prev.runs.ecmwf.init === runs.ecmwf.init;
  if (has('--if-new') && unchanged) {
    log('No new model run since the last update — nothing to do.');
    await setOutput({ updated: 'false' });
    process.exit(0);
  }
  snap = await runAll(sites, { log, prev, runs, force: !has('--if-new') });
}

await mkdir(`${out}/data`, { recursive: true });
const text = bulletin(snap, { minLevel: 1 });
await writeFile(`${out}/data/latest.json`, JSON.stringify(snap));
await writeFile(`${out}/data/bulletin.txt`, text + '\n');
await writeFile(`${out}/index.html`, await renderHtml(snap));

if (has('--archive')) {
  const stamp = snap.generated.slice(0, 13).replace('T', '_') + 'h';
  const levels = (arr) => Object.fromEntries(arr.map((s) => [s.id, s.error ? null : [s.level, s.maxProb.rp2, s.maxProb.rp5, s.maxProb.rp20, s.firstAlertDay]]));
  await mkdir(`${out}/data/archive`, { recursive: true });
  await writeFile(`${out}/data/archive/${stamp}.json`, JSON.stringify({
    generated: snap.generated, runs: snap.runs, summary: snap.summary, river: levels(snap.river), rain: levels(snap.rain),
  }));
}

console.log(text);

// Alert on anything that reached the alert level for the first time or went up a level
const notifyLevel = +(process.env.NOTIFY_LEVEL || 1);
const up = fromJson ? [] : escalations(snap, prev).filter((e) => e.to >= notifyLevel);
const max = snap.summary.maxLevel;
const name = (e) => {
  const s = snap[e.kind].find((x) => x.id === e.id);
  return e.kind === 'river' ? `${s.river} at ${s.place}` : `${s.name} (rain)`;
};
const title = up.length
  ? `${LEVEL_NAMES[Math.max(...up.map((e) => e.to))]} flood signal: ${up.slice(0, 3).map(name).join(', ')}${up.length > 3 ? ` +${up.length - 3}` : ''}`
  : '';
await writeFile(`${out}/data/alert-title.txt`, title + '\n');
await setOutput({ updated: 'true', max_level: max, max_level_name: LEVEL_NAMES[max], new_alerts: up.length });

const topic = process.env.NTFY_TOPIC;
if (topic && up.length) {
  const res = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
    method: 'POST',
    body: text,
    headers: { Title: `Iran Flood Watch: ${title}`, Priority: max >= 3 ? 'urgent' : max >= 2 ? 'high' : 'default', Tags: 'warning,droplet' },
  });
  log(`ntfy notification: HTTP ${res.status}`);
}

const total = snap.river.length + snap.rain.length;
if (snap.summary.failed.length === total) {
  log('Every request failed — nothing to publish.');
  process.exit(1);
}
