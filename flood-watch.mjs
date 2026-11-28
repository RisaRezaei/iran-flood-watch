#!/usr/bin/env node
// Copyright © 2026 Parisa Abbasalizadehrezaei. All rights reserved. See LICENSE.
// Iran Flood Watch — update run.
//   node flood-watch.mjs                 fetch the newest forecasts → docs/index.html + docs/data/* + feeds
//   node flood-watch.mjs --if-new        only fetch what has a new model run; exits quietly when nothing
//                                        is new (meant for a frequent trigger, e.g. every 10 minutes)
//   node flood-watch.mjs --out site      write somewhere else
//   node flood-watch.mjs --cache dir     where each rain model's last run is kept (default .cache)
//   node flood-watch.mjs --from-json f   re-render a saved snapshot without fetching
//   node flood-watch.mjs --archive       also keep a small record of every update in data/archive/
// Alerts: set NTFY_TOPIC (and NOTIFY_LEVEL, default 1 = Moderate) to get a phone notification through
// https://ntfy.sh as soon as any site reaches that level or goes up a level. Feeds: docs/feed.xml (RSS)
// and docs/cap/index.atom (CAP 1.2 messages, English and Persian).

import { readFile, writeFile, mkdir, appendFile, readdir, stat, unlink } from 'node:fs/promises';
import { runAll, modelRuns, bulletin, escalations, nothingNew, LEVEL_NAMES } from './src/engine.mjs';
import { addImpacts } from './src/impact.mjs';
import { capMessages, capXml, capIndexAtom, rss } from './src/feeds.mjs';
import { renderHtml } from './src/render.mjs';

const args = process.argv.slice(2);
const has = (n) => args.includes(n);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
if (has('--help') || has('-h')) {
  const src = await readFile(new URL(import.meta.url), 'utf8');
  console.log(src.split('\n').slice(2, 15).join('\n').replace(/^\/\/ ?/gm, ''));
  process.exit(0);
}

const out = opt('--out', 'docs');
const cacheDir = opt('--cache', '.cache');
const log = (m) => console.error(m);
const sites = JSON.parse(await readFile(new URL('./src/sites.json', import.meta.url), 'utf8'));
let prev = null;
try { prev = JSON.parse(await readFile(`${out}/data/latest.json`, 'utf8')); } catch { /* first run */ }
let cache = { models: {}, land: null };
try { cache = JSON.parse(await readFile(`${cacheDir}/rain.json`, 'utf8')); } catch { /* empty cache: fetch every model */ }

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
  log(`GloFAS v4 ${runs.glofasLatest[4] ? runs.glofasLatest[4].init : 'n/a'}${runs.glofasLatest[5] ? `, v5 ${runs.glofasLatest[5].init}` : ''}; rain: ` +
    Object.entries(runs.rain).map(([k, r]) => `${k} ${r ? r.init.slice(5, 13) : 'n/a'}`).join(', '));
  if (has('--if-new') && nothingNew(prev, runs, sites)) {
    log('No new model run since the last update — nothing to do.');
    await setOutput({ updated: 'false' });
    process.exit(0);
  }
  snap = await runAll(sites, { log, prev, runs, cache, force: !has('--if-new') });
  await mkdir(cacheDir, { recursive: true });
  await writeFile(`${cacheDir}/rain.json`, JSON.stringify(cache));
}

addImpacts(snap);
const cap = capMessages(snap, fromJson ? null : prev);
snap.cap = cap.state;

await mkdir(`${out}/data`, { recursive: true });
await mkdir(`${out}/cap`, { recursive: true });
const text = bulletin(snap, { minLevel: 1 });
await writeFile(`${out}/data/latest.json`, JSON.stringify(snap));
await writeFile(`${out}/data/bulletin.txt`, text + '\n');
await writeFile(`${out}/index.html`, await renderHtml(snap));

// feeds: new CAP messages get a file; listed ones keep theirs; old unlisted files are cleared after 3 days
for (const m of cap.messages) if (!m.keep) await writeFile(`${out}/cap/${m.identifier}.xml`, capXml(m, m.kind, m.site, snap));
await writeFile(`${out}/cap/index.atom`, capIndexAtom(cap.messages, snap));
await writeFile(`${out}/feed.xml`, rss(snap));
const listed = new Set(cap.messages.map((m) => `${m.identifier}.xml`));
for (const f of await readdir(`${out}/cap`)) {
  if (!f.endsWith('.xml') || listed.has(f)) continue;
  // age from the time in the identifier (a git checkout resets file times)
  const t = f.match(/(\d{8})T(\d{6})Z\.xml$/);
  const when = t ? Date.parse(`${t[1].slice(0, 4)}-${t[1].slice(4, 6)}-${t[1].slice(6)}T${t[2].slice(0, 2)}:${t[2].slice(2, 4)}:${t[2].slice(4)}Z`) : (await stat(`${out}/cap/${f}`)).mtimeMs;
  if (Date.now() - when > 3 * 864e5) await unlink(`${out}/cap/${f}`);
}

if (has('--archive')) {
  const stamp = snap.generated.slice(0, 16).replace('T', '_').replace(':', '');
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
await setOutput({ updated: 'true', max_level: max, max_level_name: LEVEL_NAMES[max], new_alerts: up.length, need_rebuild: snap.needRebuild || '' });

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
