#!/usr/bin/env node
// Copyright © 2026 Parisa Abbasalizadehrezaei. All rights reserved. See LICENSE.
// Folds one or more builds of sites.json into the current file: only the sites each build lists in
// info.touched are taken (whole site, or just the listed fields), so parallel builds and the
// update run never overwrite each other's work.
//   node tools/merge-sites.mjs build-a/sites.json build-b/sites.json   → src/sites.json

import { readFile, writeFile } from 'node:fs/promises';

const target = new URL('../src/sites.json', import.meta.url);
const base = JSON.parse(await readFile(target, 'utf8'));
const INFO_KEYS = ['glofasModels', 'rainPeriod', 'groundMethod', 'popSource', 'riverPeriodV5'];
let n = 0;
for (const f of process.argv.slice(2)) {
  const b = JSON.parse(await readFile(f, 'utf8'));
  for (const t of (b.info && b.info.touched) || []) {
    const src = b[t.kind].find((s) => s.id === t.id);
    if (!src) continue;
    const i = base[t.kind].findIndex((s) => s.id === t.id);
    const merged = t.fields ? { ...(i >= 0 ? base[t.kind][i] : src), ...Object.fromEntries(t.fields.map((k) => [k, src[k]])) } : src;
    if (i >= 0) base[t.kind][i] = merged; else base[t.kind].push(merged);
    n++;
  }
  for (const k of INFO_KEYS) if (b.info && b.info[k] != null) base.info[k] = k === 'glofasModels' ? { ...(base.info[k] || {}), ...b.info[k] } : b.info[k];
}
delete base.info.touched;
if (n) base.info.built = new Date().toISOString().slice(0, 10);
await writeFile(target, JSON.stringify(base, null, 1));
console.error(`merged ${n} site updates`);
