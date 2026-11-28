// Copyright © 2026 Parisa Abbasalizadehrezaei. All rights reserved. See LICENSE.
// Return levels from annual maxima (Gumbel / EV1 fitted by L-moments), and the
// "water reaching the ground" index used for rain on wet soil and snowmelt.

export function waterYearMaxima(time, values) {
  // Water year Oct–Sep, labelled by the year it ends in (Oct 2018–Sep 2019 → 2019)
  const m = {};
  time.forEach((t, i) => {
    const v = values[i];
    if (v == null || !isFinite(v)) return;
    const y = +t.slice(0, 4), mo = +t.slice(5, 7);
    const wy = mo >= 10 ? y + 1 : y;
    if (!(wy in m) || v > m[wy].v) m[wy] = { v, t };
  });
  return m;
}

export function gumbelLmoments(maxima) {
  const s = [...maxima].sort((a, b) => a - b), n = s.length;
  if (n < 10) throw new Error(`Only ${n} annual maxima — too few for a return-level fit`);
  let b0 = 0, b1 = 0;
  s.forEach((v, i) => { b0 += v; b1 += (v * i) / (n - 1); });
  b0 /= n; b1 /= n;
  const l1 = b0, l2 = 2 * b1 - b0;
  const alpha = l2 / Math.LN2;
  const xi = l1 - 0.5772156649 * alpha;
  const q = (T) => xi - alpha * Math.log(-Math.log(1 - 1 / T));
  const r = (v) => +v.toFixed(1);
  return { xi: +xi.toFixed(3), alpha: +alpha.toFixed(3), rp2: r(q(2)), rp5: r(q(5)), rp20: r(q(20)), rp50: r(q(50)) };
}

// ---------------------------------------------------------------------------------------------
// Rain on wet ground and snowmelt
//
// The same rain does far more damage on soaked ground or on top of melting snow. Following the
// LISFLOOD model that drives GloFAS, the share of a cell that sheds water is a function of how
// wet its soil is (the Xinanjiang / VIC / ARNO curve A = 1 − (1 − w)^b), and snowmelt comes from
// a degree-day model (melt = Cm · (T − Tmelt)). The index below is
//     E(day) = A(soil wetness of the day before) × (liquid rain + snowmelt)
// and is compared with return levels of the same index computed from ERA5, so it can only raise
// a warning when the ground or the snow makes a storm worse than its rain alone suggests.

export const LAND = {
  layers: [7, 21],   // cm: ECMWF soil layers 0–7 and 7–28 cm, averaged by thickness
  b: 1.0,            // Xinanjiang shape; 1 makes the shedding share equal to soil wetness
  cm: 4.5,           // mm per °C per day (LISFLOOD default SnowMeltCoef)
  tmelt: 0,          // °C
  lo: 0.02, hi: 0.98, // soil wetness 0 and 1 = these quantiles of the site's own ERA5 record
  // wet ground or snowmelt may lower the rain needed for a level by at most 30%: in dry climates
  // the fitted wet-ground levels are tiny (a few mm), and drizzle on damp soil is not a flood risk
  floor: 0.7,
};

export const topSoil = (sm1, sm2) =>
  sm1 == null || sm2 == null ? null : (LAND.layers[0] * sm1 + LAND.layers[1] * sm2) / (LAND.layers[0] + LAND.layers[1]);

export function quantileOf(values, q) {
  const s = values.filter((v) => v != null && isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return null;
  const pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export const wetness = (theta, range) =>
  theta == null || !range ? null : Math.min(1, Math.max(0, (theta - range[0]) / Math.max(range[1] - range[0], 1e-6)));

export const shedShare = (w) => (w == null ? null : 1 - Math.pow(1 - w, LAND.b));

// Degree-day snowpack: returns daily melt (mm) given snowfall water equivalent and mean temperature
export function snowMelt(snowfall, temp, pack0 = 0) {
  let pack = pack0 || 0;
  return snowfall.map((sf, i) => {
    pack += sf || 0;
    const t = temp[i];
    const m = t == null ? 0 : Math.min(pack, LAND.cm * Math.max(0, t - LAND.tmelt));
    pack -= m;
    return m;
  });
}

// Daily land state from soil moisture, snowfall and temperature series (all aligned to `time`)
// share[i] uses the soil wetness of day i-1 (the ground the rain of day i falls on)
export function landState({ sm1, sm2, snowfall, temp, pack0 = 0 }, range) {
  const theta = sm1.map((v, i) => topSoil(v, sm2[i]));
  const w = theta.map((t) => wetness(t, range));
  const share = w.map((_, i) => shedShare(i ? (w[i - 1] ?? w[i]) : w[i]));
  const melt = snowMelt(snowfall, temp, pack0);
  return { w, share, melt };
}

export const effective = (rain, melt, share) =>
  rain == null || share == null ? null : share * (rain + (melt || 0));
