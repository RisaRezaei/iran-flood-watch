// Copyright © 2026 Parisa Abbasalizadehrezaei. All rights reserved. See LICENSE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  quantile, membersByDay, memberSeries, rollingSums, dayLevel, ensembleStats, assess, summarizeEnsemble,
  bulletin, summarize, escalations, runAll, CONFIG,
} from '../src/engine.mjs';
import { gumbelLmoments, waterYearMaxima } from '../src/climate.mjs';
import { renderHtml } from '../src/render.mjs';

const thr = { rp2: 100, rp5: 200, rp20: 400 };
const ens = (fn) => Array.from({ length: 51 }, (_, k) => fn(k)); // 51 members like GloFAS / ECMWF ENS

test('quantile interpolates', () => {
  assert.equal(quantile([0, 10], 0.5), 5);
  assert.equal(quantile([1, 2, 3, 4, 5], 0.9), 4.6);
  assert.equal(quantile([], 0.5), null);
});

test('membersByDay keeps control + members and drops nulls', () => {
  const daily = { time: ['a', 'b'], river_discharge: [1, 2], river_discharge_member01: [3, null], river_discharge_median: [9, 9] };
  assert.deepEqual(membersByDay(daily, 'river_discharge'), [[1, 3], [2]]);
  assert.deepEqual(memberSeries(daily, 'river_discharge'), [[1, 2], [3, null]]);
});

test('rolling sums stay aligned per member and refuse gaps', () => {
  assert.deepEqual(rollingSums([[1, 2, 3, 4], [1, null, 1, 1]], 3), [[null, null, 6, 9], [null, null, null, null]]);
});

test('levels follow the configured probabilities', () => {
  assert.equal(dayLevel({ rp2: 0.49, rp5: 0.29, rp20: 0 }), 0);
  assert.equal(dayLevel({ rp2: 0.5, rp5: 0, rp20: 0 }), 1);
  assert.equal(dayLevel({ rp2: 0.2, rp5: 0.3, rp20: 0 }), 2);
  assert.equal(dayLevel({ rp2: 1, rp5: 1, rp20: 0.3 }), 3);
});

test('summarizeEnsemble finds onset, peak and level inside the horizon', () => {
  const days = [
    ens(() => 50),                    // day 0: calm
    ens((k) => (k < 30 ? 150 : 80)),  // day 1: 30/51 = 59% above 2-yr → Moderate
    ens((k) => (k < 20 ? 450 : 150)), // day 2: 39% above 20-yr → Severe
    ens(() => 60),
  ];
  const s = summarizeEnsemble(days, thr, 30);
  assert.equal(s.level, 3);
  assert.equal(s.firstAlertDay, 1);
  assert.equal(s.levelDay, 2);
  assert.equal(s.peakDay, 1); // equal medians on days 1 and 2 → first maximum wins
  assert.deepEqual(s.fc.lvl, [0, 1, 3, 0]);
  assert.equal(s.fc.pr20[2], +(20 / 51).toFixed(2));
  const short = summarizeEnsemble(days, thr, 2); // horizon cuts day 2 off
  assert.equal(short.level, 1);
  assert.ok(s.score > short.score);
});

test('a 3-day rain signal can raise the level when no single day does', () => {
  const thr1 = { rp2: 40, rp5: 60, rp20: 90 }, thr3 = { rp2: 70, rp5: 100, rp20: 140 };
  // five wet days of 35 mm: never a 2-year day, but 105 mm in 3 days beats the 3-day 5-year level
  const series = ens(() => [0, 0, 35, 35, 35, 35, 35, 0]);
  const byDay = (ser) => ser[0].map((_, i) => ser.map((s) => s[i])).slice(2);
  const fc = ensembleStats(byDay(series), thr1);
  const fc3 = ensembleStats(byDay(rollingSums(series, 3)), thr3);
  const a = assess([fc, fc3], 10);
  assert.equal(Math.max(...fc.lvl), 0);
  assert.equal(a.level, 2);
  assert.equal(a.trigger, 1);
  assert.equal(a.firstAlertDay, 2); // 70 mm by day 1 is not above 70; day 2 reaches 105 mm
});

test('days no member reaches are dropped, not shown as calm', () => {
  const s = summarizeEnsemble([ens(() => 5), ens(() => 6), []], thr, 30);
  assert.equal(s.fc.p50.length, 2);
  assert.deepEqual(s.fc.n, [51, 51]);
});

test('escalations list only sites whose level went up', () => {
  const prev = { river: [{ id: 'a', level: 1 }, { id: 'b', level: 2 }], rain: [] };
  const now = { river: [{ id: 'a', level: 2 }, { id: 'b', level: 1 }, { id: 'c', level: 1 }], rain: [{ id: 'r', level: 0 }] };
  assert.deepEqual(escalations(now, prev), [{ kind: 'river', id: 'a', from: 1, to: 2 }, { kind: 'river', id: 'c', from: 0, to: 1 }]);
});

test('runAll reuses a part whose model run has not changed', async () => {
  const runs = { glofas: { init: '2026-11-17T00:00:00.000Z' }, ecmwf: { init: '2026-11-17T06:00:00.000Z' } };
  const prev = { runs, thresholdsInfo: { built: 'x' }, river: [{ id: 'old-river', level: 0 }], rain: [{ id: 'old-rain', level: 0 }] };
  const snap = await runAll({ info: { built: 'x' }, river: [], rain: [] }, { runs, prev, force: false });
  assert.equal(snap.river[0].id, 'old-river');
  assert.equal(snap.rain[0].id, 'old-rain');
});

test('Gumbel return levels increase and match a known case', () => {
  const r = gumbelLmoments([10, 12, 15, 11, 30, 18, 14, 13, 16, 20, 25, 12]);
  assert.ok(r.rp2 < r.rp5 && r.rp5 < r.rp20 && r.rp20 < r.rp50);
  assert.ok(Math.abs(r.rp2 - (r.xi + 0.36651 * r.alpha)) < 0.06); // rp2 of a Gumbel is xi + 0.3665·alpha
  assert.throws(() => gumbelLmoments([1, 2, 3]));
});

test('water years run October to September', () => {
  const m = waterYearMaxima(['2018-09-30', '2018-10-01', '2019-09-30'], [5, 7, 6]);
  assert.deepEqual(Object.keys(m), ['2018', '2019']);
  assert.equal(m['2019'].v, 7);
});

test('bulletin and rendered page', async () => {
  const site = (level) => ({
    id: `s${level}`, river: 'Karun', place: 'Ahvaz', prov: 'Khuzestan', name: 'X', fa: 'کارون', thr, trigger: null,
    fcStart: '2026-11-18', level, levelDay: 1, firstAlertDay: level ? 1 : null, peakDay: 1, score: level * 10,
    maxProb: { rp2: 0.6, rp5: 0.1, rp20: 0 }, fc: { p50: [1, 2], p10: [1, 1], p25: [1, 1], p75: [2, 2], p90: [2, 3], pr2: [0, 0.6], pr5: [0, 0.1], pr20: [0, 0], lvl: [0, level], n: [51, 51] },
    past: { start: '2026-11-04', q: [1] }, slat: 31.3, slon: 48.6, top: [['2019-03-26', 1]], qNow: 1, nowRatio: 0.01,
  });
  const river = [site(1), site(0)];
  const snap = {
    generated: '2026-11-18T09:20:00.000Z',
    runs: { glofas: { init: '2026-11-18T00:00:00.000Z', available: '2026-11-18T12:40:00.000Z' }, ecmwf: { init: '2026-11-18T00:00:00.000Z', available: '2026-11-18T09:20:00.000Z' } },
    config: { levels: CONFIG.levels, riverAlertHorizon: 30, rainAlertHorizon: 10, timezone: 'Asia/Tehran', staleHours: CONFIG.staleHours },
    thresholdsInfo: {}, summary: summarize(river, []), river, rain: [],
  };
  const txt = bulletin(snap);
  assert.match(txt, /\[MODERATE\] River: Karun at Ahvaz/);
  assert.match(txt, /Model runs: GloFAS 2026-11-18 00 UTC/);
  assert.doesNotMatch(txt, /s0/);
  const html = await renderHtml(snap);
  assert.ok(!html.includes('__SNAPSHOT__') && !html.includes('__TOPO__'));
});
