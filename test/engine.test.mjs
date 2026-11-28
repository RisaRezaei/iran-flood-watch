// Copyright © 2026 Parisa Abbasalizadehrezaei. All rights reserved. See LICENSE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  quantile, membersByDay, memberSeries, rollingSums, dayLevel, ensembleStats, assess, summarizeEnsemble,
  bulletin, summarize, escalations, runAll, CONFIG, weightedQuantile, combineRain, pickGlofas, nothingNew, tehranDate,
} from '../src/engine.mjs';
import { gumbelLmoments, waterYearMaxima, snowMelt, landState, shedShare, wetness } from '../src/climate.mjs';
import { rainThresholds } from '../src/thresholds.mjs';
import { addImpacts } from '../src/impact.mjs';
import { capMessages, capXml, capTime } from '../src/feeds.mjs';
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

test('runAll reuses an unchanged river run and the cached rain models', async () => {
  const now = new Date('2026-11-28T05:00:00Z');
  const runs = { glofasLatest: { 4: { init: '2026-11-27T00:00:00.000Z' }, 5: null }, rain: {} };
  const prev = { runs: { glofas: { version: 4, init: '2026-11-27T00:00:00.000Z' } }, thresholdsInfo: { built: 'x' }, river: [{ id: 'old-river', level: 0 }] };
  const snap = await runAll({ info: { built: 'x' }, river: [], rain: [] }, { runs, prev, force: false, now });
  assert.equal(snap.river[0].id, 'old-river');
  assert.equal(snap.runs.glofas.version, 4);
});

const T = ['2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29', '2026-11-30', '2026-12-01'];
const series = (n, f) => Array.from({ length: n }, (_, k) => T.map((_, i) => f(k, i)));
const point = { id: 'p', name: 'P', fa: 'پ', prov: 'X', lat: 35, lon: 51, thr: { rp2: 25, rp5: 32, rp20: 41 }, thr3: { rp2: 39, rp5: 50, rp20: 65 },
  thrE: { rp2: 18, rp5: 24, rp20: 33 }, thrE3: { rp2: 28, rp5: 38, rp20: 52 }, soilRange: [0.1, 0.4], pop: { n: 1234567, r: 10 } };

test('models count equally however many members they have', () => {
  const big = { key: 'a', init: 'i', data: { time: T, p: series(64, (k, i) => (i === 3 ? 30 : 0)), s: series(64, () => 0) } };   // all above 2-yr
  const small = { key: 'b', init: 'i', data: { time: T, p: series(18, () => 0), s: series(18, () => 0) } };                      // none
  const r = combineRain({ ...point, thrE: null, thrE3: null }, [big, small], null, { today: '2026-11-28' });
  assert.equal(r.fc.pr2[1], 0.5);           // (1 + 0) / 2 models, not 64 / 82 members
  assert.equal(r.fc.m[1], 2);
  assert.equal(r.level, 1);
  assert.deepEqual(r.agree, { alerting: 1, total: 2 });
});

test('wet ground raises a warning that rain alone does not, and never lowers one', () => {
  const m = { key: 'a', init: 'i', data: { time: T, p: series(51, (k, i) => (i === 3 ? 22 : 0)), s: series(51, () => 0) } };
  const wet = { time: T, temp: T.map(() => 5), snowfall: T.map(() => 0), sm1: T.map(() => 0.4), sm2: T.map(() => 0.4), swe0: 0 };
  const dry = { ...wet, sm1: T.map(() => 0.1), sm2: T.map(() => 0.1) };
  const a = combineRain(point, [m], wet, { today: '2026-11-28' });
  const b = combineRain(point, [m], dry, { today: '2026-11-28' });
  assert.equal(a.levelRainOnly, 0);
  assert.ok(a.level >= 1 && a.boosted);       // 22 mm on saturated ground > 18 mm wet-ground 2-yr level
  assert.equal(b.level, 0);                   // the same rain on dry ground: no alert
  const storm = { key: 'a', init: 'i', data: { time: T, p: series(51, (k, i) => (i === 3 ? 45 : 0)), s: series(51, () => 0) } };
  assert.equal(combineRain(point, [storm], dry, { today: '2026-11-28' }).level, 3); // dry ground does not hide a big storm
});

test('snowmelt and soil wetness helpers', () => {
  assert.deepEqual(snowMelt([10, 0, 0], [-5, 2, 10]).map((v) => +v.toFixed(1)), [0, 9, 1]); // 4.5 mm/°C/day, limited by the pack
  assert.ok(Math.abs(wetness(0.25, [0.1, 0.4]) - 0.5) < 1e-9);
  assert.equal(shedShare(0.5), 0.5);
  const L = landState({ sm1: [0.1, 0.4], sm2: [0.1, 0.4], snowfall: [0, 0], temp: [0, 0] }, [0.1, 0.4]);
  assert.deepEqual(L.share, [0, 0]); // day 2 uses day 1's (dry) ground
});

test('weighted quantile', () => {
  assert.equal(weightedQuantile([[1, 1], [2, 1], [3, 2]], 0.5), 2);
  assert.equal(weightedQuantile([], 0.5), null);
});

test('GloFAS v5 is used only once live and built; otherwise a rebuild is requested', () => {
  const now = new Date('2026-12-20T12:00:00Z');
  const latest = { 4: { init: '2026-12-20T00:00:00Z' }, 5: { init: '2026-12-20T00:00:00Z' } };
  const plain = { river: [{ id: 'a', thr: {} }] };
  assert.deepEqual(pickGlofas(latest, plain, { now }).use.version, 4);
  assert.equal(pickGlofas(latest, plain, { now }).needRebuild, 'glofas-v5');
  const built = { river: [{ id: 'a', thr: {}, v5: { thr: {} } }] };
  assert.equal(pickGlofas(latest, built, { now }).use.version, 5);
  assert.equal(pickGlofas({ 4: latest[4], 5: null }, built, { now }).use.version, 4);
});

test('nothingNew compares the runs in use, each model refresh interval and the local day', () => {
  const now = new Date('2026-11-28T05:00:00Z');
  const runs = { glofasLatest: { 4: { init: '2026-11-27T00:00:00Z' } }, rain: { ifs: { init: '2026-11-27T18:00:00Z' }, gem: { init: '2026-11-27T12:00:00Z' } } };
  const sites = { info: { built: 'x' }, river: [] };
  const prev = { generated: '2026-11-28T04:00:00Z', thresholdsInfo: { built: 'x' },
    runs: { glofas: { version: 4, init: '2026-11-27T00:00:00Z' }, rain: {}, used: [{ key: 'ifs', init: '2026-11-27T18:00:00Z' }, { key: 'gem', init: '2026-11-27T12:00:00Z' }] } };
  const cfg = { ...CONFIG, rainModels: [{ key: 'ifs', refreshHours: 6 }, { key: 'gem', refreshHours: 12 }] };
  assert.equal(nothingNew(prev, runs, sites, { cfg, now }), true);
  assert.equal(nothingNew(prev, { ...runs, rain: { ...runs.rain, ifs: { init: '2026-11-28T00:00:00Z' } } }, sites, { cfg, now }), false); // ECMWF every 6 h
  assert.equal(nothingNew(prev, { ...runs, rain: { ...runs.rain, gem: { init: '2026-11-27T18:00:00Z' } } }, sites, { cfg, now }), true);  // GEPS waits for 12 h
  assert.equal(nothingNew(prev, { ...runs, rain: { ...runs.rain, gem: { init: '2026-11-28T00:00:00Z' } } }, sites, { cfg, now }), false);
  assert.equal(nothingNew(prev, runs, sites, { cfg, now: new Date('2026-11-28T21:00:00Z') }), false); // past midnight in Tehran
  assert.equal(tehranDate('2026-11-28T20:31:00Z'), '2026-11-29');
});

test('ERA5 thresholds: wet-ground levels sit below rain-only levels', () => {
  const n = 365 * 12, time = [], P = [], S = [], Tm = [], sm = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2000, 9, 1) + i * 864e5); time.push(d.toISOString().slice(0, 10));
    const r = (Math.sin(i * 1.7) + 1) * (i % 97 === 0 ? 30 : 2); P.push(+r.toFixed(1)); S.push(0); Tm.push(10); sm.push(0.2 + 0.1 * Math.sin(i / 30));
  }
  const t = rainThresholds({ time, precipitation_sum: P, snowfall_water_equivalent_sum: S, temperature_2m_mean: Tm, soil_moisture_0_to_7cm_mean: sm, soil_moisture_7_to_28cm_mean: sm }, { endDate: '2099-01-01' });
  assert.ok(t.thrE.rp2 < t.thr.rp2);
  assert.ok(t.alertDaysPerYear.withGround >= t.alertDaysPerYear.rainOnly);
});

test('CAP messages: alert, then kept, then cancelled with a reference', () => {
  const m = { key: 'a', init: 'i', data: { time: T, p: series(51, (k, i) => (i === 3 ? 45 : 0)), s: series(51, () => 0) } };
  const r = combineRain(point, [m], null, { today: '2026-11-28' });
  const snap = { generated: '2026-11-28T05:00:00.000Z', config: { levels: CONFIG.levels, riverAlertHorizon: 30, rainAlertHorizon: 10 }, river: [], rain: [r] };
  addImpacts(snap);
  const c1 = capMessages(snap, null);
  assert.equal(c1.messages[0].msgType, 'Alert');
  const xml = capXml(c1.messages[0], 'rain', r, snap);
  assert.match(xml, /<sent>2026-11-28T05:00:00-00:00<\/sent>/);
  assert.match(xml, /<language>fa-IR<\/language>/);
  assert.equal(capTime('2026-11-28T05:00:00Z'), '2026-11-28T05:00:00-00:00');
  const prev = { ...snap, cap: c1.state };
  assert.equal(capMessages({ ...snap, generated: '2026-11-28T06:00:00.000Z' }, prev).messages[0].keep, true);
  const c3 = capMessages({ ...snap, generated: '2026-11-28T07:00:00.000Z', rain: [{ ...r, level: 0 }] }, prev);
  assert.equal(c3.messages[0].msgType, 'Cancel');
  assert.match(c3.messages[0].references, /IFW-rain-p-20261128T050000Z/);
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
    id: `s${level}`, river: 'Karun', place: 'Ahvaz', prov: 'Khuzestan', name: 'X', fa: 'کارون', thr, trigger: null, lat: 31.3, lon: 48.6,
    fcStart: '2026-11-18', level, levelDay: 1, firstAlertDay: level ? 1 : null, peakDay: 1, score: level * 10, pop: { n: 500000, r: 5 },
    maxProb: { rp2: 0.6, rp5: 0.1, rp20: 0 }, fc: { p50: [1, 2], p10: [1, 1], p25: [1, 1], p75: [2, 2], p90: [2, 3], pr2: [0, 0.6], pr5: [0, 0.1], pr20: [0, 0], lvl: [0, level], n: [51, 51] },
    past: { start: '2026-11-04', q: [1] }, slat: 31.3, slon: 48.6, top: [['2019-03-26', 1]], qNow: 1, nowRatio: 0.01,
  });
  const river = [site(1), site(0)];
  const T2 = ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20'];
  const m = { key: 'ifs', init: '2026-11-18T00:00:00.000Z', data: { time: T2, p: Array.from({ length: 51 }, () => [0, 0, 1, 40, 2]), s: Array.from({ length: 51 }, () => [0, 0, 0, 0, 0]) } };
  const rain = [combineRain(point, [m], { time: T2, temp: T2.map(() => 5), snowfall: T2.map(() => 0), sm1: T2.map(() => 0.3), sm2: T2.map(() => 0.3), swe0: 0 }, { today: '2026-11-18' })];
  const snap = {
    generated: '2026-11-18T09:20:00.000Z',
    runs: { glofas: { version: 4, init: '2026-11-18T00:00:00.000Z' }, glofasLatest: {}, rain: {}, used: [{ key: 'ifs', init: '2026-11-18T00:00:00.000Z' }] },
    config: { levels: CONFIG.levels, riverAlertHorizon: 30, rainAlertHorizon: 10, timezone: 'Asia/Tehran', staleHours: CONFIG.staleHours, rainModels: CONFIG.rainModels },
    thresholdsInfo: {}, summary: summarize(river, rain), river, rain,
  };
  addImpacts(snap);
  const txt = bulletin(snap);
  assert.match(txt, /\[MODERATE\] River: Karun at Ahvaz/);
  assert.match(txt, /River model: GloFAS v4, run 2026-11-18 00 UTC/);
  assert.match(txt, /Rain models \(1\): ECMWF IFS ENS/);
  assert.match(txt, /about 500,000 people within 5 km/);
  assert.doesNotMatch(txt, /s0/);
  assert.equal(snap.river[0].impact.advice.fa.length > 10, true);
  const html = await renderHtml(snap);
  assert.ok(!html.includes('__SNAPSHOT__') && !html.includes('__TOPO__'));
});
