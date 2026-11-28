// Copyright © 2026 Parisa Abbasalizadehrezaei. All rights reserved. See LICENSE.
// Return levels for a rain point from a daily ERA5 record (Iran local days). Pure functions:
// used by tools/build-thresholds.mjs and runnable anywhere with the same result.

import { waterYearMaxima, gumbelLmoments, landState, quantileOf, topSoil, effective, LAND } from './climate.mjs';

const floorAt = (fitE, thr) => Object.fromEntries(['rp2', 'rp5', 'rp20', 'rp50'].map((k) => [k, +Math.max(fitE[k], LAND.floor * thr[k]).toFixed(1)]));

export const RAIN_PERIOD = ['1991-10-01', '2024-09-30'];
export const RAIN_VARS = 'precipitation_sum,snowfall_water_equivalent_sum,temperature_2m_mean,soil_moisture_0_to_7cm_mean,soil_moisture_7_to_28cm_mean';

const roll3 = (v) => v.map((_, d) => (d < 2 || v[d] == null || v[d - 1] == null || v[d - 2] == null ? null : v[d] + v[d - 1] + v[d - 2]));
const fit = (time, v) => gumbelLmoments(Object.values(waterYearMaxima(time, v)).map((o) => o.v));
const topYears = (time, v) => Object.values(waterYearMaxima(time, v)).sort((a, b) => b.v - a.v).slice(0, 3).map((o) => [o.t, +o.v.toFixed(1)]);

export function rainThresholds(daily, { endDate = RAIN_PERIOD[1] } = {}) {
  // fit on the climate period only, even when the record runs on
  const n = daily.time.findIndex((t) => t > endDate);
  const cut = (arr) => (n < 0 ? arr : arr.slice(0, n));
  const time = cut(daily.time);
  const P = cut(daily.precipitation_sum);
  const snow = cut(daily.snowfall_water_equivalent_sum);
  const sm1 = cut(daily.soil_moisture_0_to_7cm_mean), sm2 = cut(daily.soil_moisture_7_to_28cm_mean);
  const temp = cut(daily.temperature_2m_mean);
  const liquid = P.map((p, i) => (p == null ? null : Math.max(0, p - (snow[i] || 0))));
  const theta = sm1.map((v, i) => topSoil(v, sm2[i]));
  const soilRange = [quantileOf(theta, LAND.lo), quantileOf(theta, LAND.hi)].map((v) => +v.toFixed(4));
  const L = landState({ sm1, sm2, snowfall: snow, temp, pack0: 0 }, soilRange);
  const E = liquid.map((r, i) => effective(r, L.melt[i], L.share[i]));
  const P3 = roll3(P), E3 = roll3(E);
  const thr = fit(time, P), thr3 = fit(time, P3), fitE = fit(time, E), fitE3 = fit(time, E3);
  const thrE = floorAt(fitE, thr), thrE3 = floorAt(fitE3, thr3);
  // perfect-forecast check: days per year at or above the 2-year level, rain alone vs with ground
  let rainOnly = 0, withGround = 0;
  time.forEach((_, i) => {
    const a = P[i] > thr.rp2 || (P3[i] ?? 0) > thr3.rp2;
    const b = a || (E[i] ?? 0) > thrE.rp2 || (E3[i] ?? 0) > thrE3.rp2;
    rainOnly += a; withGround += b;
  });
  const years = Object.keys(waterYearMaxima(time, P)).length;
  const meltYear = L.melt.reduce((t, m) => t + m, 0) / years;
  return {
    nYears: years,
    annual: Math.round(P.filter((x) => x != null).reduce((a, b) => a + b, 0) / years),
    thr, thr3, thrE, thrE3, thrEfit: { rp2: fitE.rp2, rp5: fitE.rp5, rp20: fitE.rp20 }, soilRange,
    snowmeltPerYear: Math.round(meltYear),
    top: topYears(time, P), top3: topYears(time, P3), topE: topYears(time, E),
    alertDaysPerYear: { rainOnly: +(rainOnly / years).toFixed(2), withGround: +(withGround / years).toFixed(2) },
  };
}
