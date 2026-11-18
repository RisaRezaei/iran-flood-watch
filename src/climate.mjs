// Copyright © 2026 Parisa Abbasalizadehrezaei. All rights reserved. See LICENSE.
// Return levels from annual maxima: Gumbel (EV1) distribution fitted by L-moments.

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
