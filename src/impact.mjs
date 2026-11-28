// Copyright © 2026 Parisa Abbasalizadehrezaei. All rights reserved. See LICENSE.
// Impact-based alert content: who is exposed, how likely it is, and what to do — in English and
// Persian. People counts come from the GHSL 2025 population grid (tools/build_exposure.py).

import { LEVEL_NAMES, fmtPeople, addDays } from './engine.mjs';

export const LEVEL_FA = ['عادی', 'متوسط', 'زیاد', 'شدید'];

export const ADVICE = {
  river: {
    1: {
      en: 'Keep away from riverbanks, and do not cross flooded roads, fords or low bridges. Check official updates.',
      fa: 'از کناره رودخانه دور بمانید و از جاده‌ها، گدارها و پل‌های کوتاهِ زیر آب عبور نکنید. اطلاعیه‌های رسمی را دنبال کنید.',
    },
    2: {
      en: 'Move vehicles, livestock and valuables away from the river and low ground. Be ready to leave if officials advise it.',
      fa: 'خودرو، دام و وسایل باارزش را از کنار رودخانه و زمین‌های پست دور کنید. اگر مسئولان توصیه کردند، آماده ترک محل باشید.',
    },
    3: {
      en: 'Serious flooding is possible. Follow evacuation orders at once and move to higher ground. Never walk or drive into floodwater.',
      fa: 'احتمال سیل شدید وجود دارد. دستور تخلیه را فوراً اجرا کنید و به نقاط بلندتر بروید. هرگز پیاده یا با خودرو وارد آب سیلاب نشوید.',
    },
  },
  rain: {
    1: {
      en: 'Avoid riverbeds, dry valleys and underpasses during heavy rain: flash floods arrive with little warning.',
      fa: 'هنگام باران شدید از بستر رودخانه‌ها، مسیل‌ها و زیرگذرها دوری کنید؛ سیلاب ناگهانی تقریباً بدون هشدار می‌رسد.',
    },
    2: {
      en: 'Do not camp or park in valleys or riverbeds. Clear drains near your home and keep children away from channels.',
      fa: 'در دره‌ها و بستر رودخانه‌ها چادر نزنید و خودرو پارک نکنید. آبراه‌های اطراف خانه را باز کنید و کودکان را از جوی‌ها و کانال‌ها دور نگه دارید.',
    },
    3: {
      en: 'Dangerous flash flooding is possible. Stay out of valleys and low streets, move to higher floors or ground, and never drive through moving water.',
      fa: 'احتمال سیلاب ناگهانی خطرناک وجود دارد. از دره‌ها و خیابان‌های پست دور بمانید، به طبقات یا زمین‌های بالاتر بروید و هرگز با خودرو از آب روان عبور نکنید.',
    },
  },
};

export const EMERGENCY = {
  en: 'Emergency: 112 (Red Crescent rescue), 115 (ambulance).',
  fa: 'امداد و نجات هلال احمر: ۱۱۲ — اورژانس: ۱۱۵',
};

const faNum = (n) => Number(n).toLocaleString('fa-IR');
function faPeople(n) {
  if (n >= 1e6) return `${(n / 1e6).toLocaleString('fa-IR', { maximumFractionDigits: n >= 1e7 ? 0 : 1 })} میلیون`;
  if (n >= 1e3) return `${faNum(Math.round(n / 1e3))} هزار`;
  return faNum(Math.round(n / 10) * 10);
}

const faDate = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('fa-IR', { day: 'numeric', month: 'long', timeZone: 'UTC' });
const enDate = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

// The probability behind the level on its strongest day
export function levelChance(s, levels) {
  if (!s.level) return null;
  const L = levels.find((x) => x.level === s.level);
  const k = { rp2: 'pr2', rp5: 'pr5', rp20: 'pr20' }[L.rp];
  const parts = [s.fc, s.fc3, s.fcw, s.fcw3].filter(Boolean);
  return Math.max(...parts.map((p) => p[k][s.levelDay] ?? 0));
}

export function impactOf(s, kind, levels) {
  const out = { level: s.level ?? 0 };
  if (s.pop && s.pop.n != null) {
    out.people = s.pop.n;
    out.radiusKm = s.pop.r;
    out.exposure = kind === 'river'
      ? { en: `About ${fmtPeople(s.pop.n)} people live within ${s.pop.r} km of this reach.`, fa: `حدود ${faPeople(s.pop.n)} نفر در شعاع ${faNum(s.pop.r)} کیلومتری این بازه از رودخانه زندگی می‌کنند.` }
      : { en: `About ${fmtPeople(s.pop.n)} people live within ${s.pop.r} km of the city centre.`, fa: `حدود ${faPeople(s.pop.n)} نفر در شعاع ${faNum(s.pop.r)} کیلومتری مرکز شهر زندگی می‌کنند.` };
  }
  if (!s.level) return out;
  const p = levelChance(s, levels);
  const day = addDays(s.fcStart, s.levelDay), from = addDays(s.fcStart, s.firstAlertDay ?? s.levelDay);
  const rp = { 1: 2, 2: 5, 3: 20 }[s.level];
  const wet = /wet ground/.test(s.trigger || '');
  const what = kind === 'river'
    ? { en: `the ${rp}-year flood flow`, fa: `دبی سیل ${faNum(rp)} ساله` }
    : wet
      ? { en: `the ${rp}-year level for rain on wet ground or snowmelt`, fa: `سطح ${faNum(rp)} ساله باران روی خاک مرطوب یا ذوب برف` }
      : { en: `the ${rp}-year rainfall`, fa: `بارش ${faNum(rp)} ساله` };
  out.chance = p;
  out.headline = {
    en: `${LEVEL_NAMES[s.level]} ${kind === 'river' ? 'river-flood' : 'flash-flood'} warning: ${Math.round(p * 100)}% chance of passing ${what.en} on ${enDate(day)}` +
      (from !== day ? ` (alert conditions from ${enDate(from)})` : '') + '.',
    fa: `هشدار ${kind === 'river' ? 'سیل رودخانه‌ای' : 'سیلاب ناگهانی'} — سطح ${LEVEL_FA[s.level]}: احتمال ${faNum(Math.round(p * 100))}٪ عبور از ${what.fa} در ${faDate(day)}` +
      (from !== day ? ` (شرایط هشدار از ${faDate(from)})` : '') + '.',
  };
  out.advice = ADVICE[kind][s.level];
  out.emergency = EMERGENCY;
  return out;
}

export function addImpacts(snap) {
  for (const kind of ['river', 'rain']) for (const s of snap[kind]) if (!s.error) s.impact = impactOf(s, kind, snap.config.levels);
  return snap;
}
