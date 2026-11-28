// Copyright © 2026 Parisa Abbasalizadehrezaei. All rights reserved. See LICENSE.
// Alert feeds in the international formats other systems read:
//   - CAP 1.2 (OASIS Common Alerting Protocol), one message per alert, English and Persian,
//     with Alert / Update / Cancel so a reader can follow each alert through its life
//   - an Atom index of the current CAP messages (the usual way CAP feeds are published)
//   - an RSS 2.0 feed of the current alerts for news readers and apps

import { LEVEL_NAMES, addDays } from './engine.mjs';
import { levelChance } from './impact.mjs';

export const SITE_URL = 'https://risarezaei.github.io/iran-flood-watch/';
const SENDER = 'https://risarezaei.github.io/iran-flood-watch/';
const SENDER_NAME = { en: 'Iran Flood Watch (unofficial)', fa: 'پایش سیل ایران (غیررسمی)' };
const TEHRAN = '+03:30';

const x = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
// CAP times: seconds and a numeric offset; UTC must be written -00:00, never Z
export const capTime = (d) => new Date(d).toISOString().slice(0, 19) + '-00:00';
const localMidnight = (iso) => `${iso}T00:00:00${TEHRAN}`;
const rfc822 = (d) => new Date(d).toUTCString().replace('GMT', '+0000');

const stamp = (iso) => iso.replace(/[-:]/g, '').slice(0, 15) + 'Z';
const keyOf = (kind, s) => `${kind}:${s.id}`;
const titleOf = (kind, s) => (kind === 'river' ? `${s.river} at ${s.place}` : s.name);
const titleFa = (kind, s) => (kind === 'river' ? s.fa : s.fa);

function lastAlertDay(s, horizon) {
  const parts = [s.fc, s.fc3, s.fcw, s.fcw3].filter(Boolean);
  let last = s.levelDay;
  for (let d = 0; d < Math.min(horizon, parts[0].lvl.length); d++) if (parts.some((p) => (p.lvl[d] ?? 0) > 0)) last = d;
  return last;
}

function capInfo(lang, kind, s, snap, msgType) {
  const imp = s.impact || {};
  const levels = snap.config.levels;
  const horizon = kind === 'river' ? snap.config.riverAlertHorizon : snap.config.rainAlertHorizon;
  const cancel = msgType === 'Cancel';
  const p = cancel ? 0 : levelChance(s, levels);
  const first = s.firstAlertDay ?? s.levelDay;
  const onset = cancel ? null : localMidnight(addDays(s.fcStart, first));
  const expires = cancel
    ? capTime(Date.parse(snap.generated) + 12 * 3.6e6)
    : localMidnight(addDays(s.fcStart, lastAlertDay(s, horizon) + 1));
  const days = cancel ? 99 : (Date.parse(onset) - Date.parse(snap.generated)) / 864e5;
  const fa = lang === 'fa-IR';
  const event = kind === 'river' ? (fa ? 'سیل رودخانه‌ای' : 'River flood') : (fa ? 'سیلاب ناگهانی' : 'Flash flood');
  const headline = cancel
    ? (fa ? `لغو هشدار ${event}: ${titleFa(kind, s)}` : `${event} warning cancelled: ${titleOf(kind, s)}`)
    : (imp.headline ? imp.headline[fa ? 'fa' : 'en'] : `${LEVEL_NAMES[s.level]} ${event.toLowerCase()} warning`);
  const desc = cancel
    ? (fa ? 'پیش‌بینی‌های تازه دیگر از آستانه هشدار عبور نمی‌کنند.' : 'The latest forecasts no longer reach the warning threshold.')
    : [imp.headline && imp.headline[fa ? 'fa' : 'en'], imp.exposure && imp.exposure[fa ? 'fa' : 'en'],
      s.agree ? (fa ? `${s.agree.alerting} از ${s.agree.total} مدل هم‌نظرند.` : `${s.agree.alerting} of ${s.agree.total} weather models agree.`) : null,
      s.boosted ? (fa ? 'خاک مرطوب یا ذوب برف سطح هشدار را بالا برده است.' : 'Wet ground or snowmelt raised the level.') : null,
      fa ? 'هشدار خودکار و غیررسمی بر پایه پیش‌بینی‌های گروهی؛ از اطلاعیه‌های سازمان هواشناسی و مدیریت بحران پیروی کنید.'
        : 'Automated, unofficial alert based on ensemble forecasts. Follow the Iran Meteorological Organization and crisis-management authorities.',
    ].filter(Boolean).join(' ');
  const instruction = cancel ? null : imp.advice && `${imp.advice[fa ? 'fa' : 'en']} ${imp.emergency[fa ? 'fa' : 'en']}`;
  const lines = [
    '  <info>',
    `    <language>${lang}</language>`,
    '    <category>Met</category>',
    `    <event>${x(event)}</event>`,
    `    <responseType>${cancel ? 'AllClear' : s.level >= 2 ? 'Prepare' : 'Monitor'}</responseType>`,
    `    <urgency>${cancel ? 'Past' : days <= 1 ? 'Expected' : 'Future'}</urgency>`,
    `    <severity>${cancel ? 'Minor' : ['Minor', 'Minor', 'Moderate', 'Severe'][s.level]}</severity>`,
    `    <certainty>${cancel ? 'Unlikely' : p >= 0.5 ? 'Likely' : 'Possible'}</certainty>`,
    `    <effective>${capTime(snap.generated)}</effective>`,
    onset ? `    <onset>${onset}</onset>` : null,
    `    <expires>${expires}</expires>`,
    `    <senderName>${x(SENDER_NAME[fa ? 'fa' : 'en'])}</senderName>`,
    `    <headline>${x(headline)}</headline>`,
    `    <description>${x(desc)}</description>`,
    instruction ? `    <instruction>${x(instruction)}</instruction>` : null,
    `    <web>${SITE_URL}#${kind}-${s.id}</web>`,
    cancel ? null : `    <parameter><valueName>warningLevel</valueName><value>${LEVEL_NAMES[s.level]}</value></parameter>`,
    cancel ? null : `    <parameter><valueName>exceedanceProbability</valueName><value>${(p ?? 0).toFixed(2)}</value></parameter>`,
    cancel || !s.pop ? null : `    <parameter><valueName>peopleWithinRadius</valueName><value>${s.pop.n}</value></parameter>`,
    '    <area>',
    `      <areaDesc>${x(fa ? `${titleFa(kind, s)}` : `${titleOf(kind, s)}, ${s.prov} province, Iran`)}</areaDesc>`,
    `      <circle>${s.lat},${s.lon} ${kind === 'river' ? 15 : 15}</circle>`,
    '    </area>',
    '  </info>',
  ];
  return lines.filter((l) => l != null).join('\n');
}

export function capXml(msg, kind, s, snap) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">',
    `  <identifier>${msg.identifier}</identifier>`,
    `  <sender>${SENDER}</sender>`,
    `  <sent>${msg.sent}</sent>`,
    '  <status>Actual</status>',
    `  <msgType>${msg.msgType}</msgType>`,
    '  <scope>Public</scope>',
    '  <note>Unofficial automated forecast alert. Not issued by a national authority.</note>',
    msg.references ? `  <references>${msg.references}</references>` : null,
    capInfo('en-US', kind, s, snap, msg.msgType),
    capInfo('fa-IR', kind, s, snap, msg.msgType),
    '</alert>',
    '',
  ].filter((l) => l != null).join('\n');
}

const signature = (kind, s, levels) => [s.level, addDays(s.fcStart, s.levelDay), addDays(s.fcStart, s.firstAlertDay ?? s.levelDay), Math.round((levelChance(s, levels) || 0) * 10)].join('|');

// Decide which CAP messages exist after this update. Returns the messages to list and the
// state to keep for the next update (stored in the snapshot as snap.cap).
export function capMessages(snap, prev) {
  const before = (prev && prev.cap) || {};
  const sentNow = capTime(snap.generated);
  const state = {}, messages = [];
  const ref = (m) => `${SENDER},${m.identifier},${m.sent}`;
  for (const kind of ['river', 'rain']) for (const s of snap[kind]) {
    if (s.error) { if (before[keyOf(kind, s)] && before[keyOf(kind, s)].active) state[keyOf(kind, s)] = before[keyOf(kind, s)]; continue; }
    const k = keyOf(kind, s), old = before[k];
    if ((s.level ?? 0) > 0) {
      const sig = signature(kind, s, snap.config.levels);
      if (old && old.active && old.sig === sig) { state[k] = old; messages.push({ ...old, kind, site: s, keep: true }); continue; }
      const m = { identifier: `IFW-${kind}-${s.id}-${stamp(snap.generated)}`, sent: sentNow, msgType: old && old.active ? 'Update' : 'Alert', sig, active: true, level: s.level };
      if (old && old.active) m.references = ref(old);
      state[k] = m;
      messages.push({ ...m, kind, site: s });
    } else if (old && old.active) {
      const m = { identifier: `IFW-${kind}-${s.id}-${stamp(snap.generated)}`, sent: sentNow, msgType: 'Cancel', references: ref(old), active: false, level: 0 };
      messages.push({ ...m, kind, site: s });
    }
  }
  return { messages, state };
}

export function capIndexAtom(messages, snap) {
  const updated = new Date(snap.generated).toISOString().slice(0, 19) + 'Z';
  const entries = messages.map((m) => {
    const imp = m.site.impact || {};
    const title = m.msgType === 'Cancel' ? `Cancelled: ${titleOf(m.kind, m.site)}` : (imp.headline ? imp.headline.en : `${LEVEL_NAMES[m.level]}: ${titleOf(m.kind, m.site)}`);
    return [
      '  <entry>',
      `    <id>${SITE_URL}cap/${m.identifier}.xml</id>`,
      `    <title>${x(title)}</title>`,
      `    <updated>${new Date(m.sent.replace('-00:00', 'Z')).toISOString().slice(0, 19)}Z</updated>`,
      `    <summary>${x(`${m.msgType} · ${titleOf(m.kind, m.site)} (${m.site.prov})`)}</summary>`,
      `    <link rel="alternate" type="application/cap+xml" href="${SITE_URL}cap/${m.identifier}.xml"/>`,
      '  </entry>',
    ].join('\n');
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <id>${SITE_URL}cap/index.atom</id>`,
    '  <title>Iran Flood Watch — CAP alerts (unofficial)</title>',
    `  <updated>${updated}</updated>`,
    '  <author><name>Iran Flood Watch</name><uri>https://risarezaei.github.io/</uri></author>',
    `  <link rel="self" href="${SITE_URL}cap/index.atom"/>`,
    `  <link rel="alternate" type="text/html" href="${SITE_URL}"/>`,
    '  <rights>© 2026 Parisa Abbasalizadehrezaei. All rights reserved.</rights>',
    ...entries,
    '</feed>',
    '',
  ].join('\n');
}

export function rss(snap) {
  const items = [];
  for (const kind of ['river', 'rain']) for (const s of snap[kind]) {
    if (s.error || !(s.level > 0)) continue;
    const imp = s.impact || {};
    const body = [imp.headline && imp.headline.en, imp.exposure && imp.exposure.en, imp.advice && imp.advice.en, imp.emergency && imp.emergency.en, '',
      imp.headline && imp.headline.fa, imp.exposure && imp.exposure.fa, imp.advice && imp.advice.fa].filter((l) => l != null).join('\n');
    items.push({ score: s.score, xml: [
      '    <item>',
      `      <title>${x(`${LEVEL_NAMES[s.level]} — ${titleOf(kind, s)} (${s.prov})`)}</title>`,
      `      <link>${SITE_URL}#${kind}-${s.id}</link>`,
      `      <guid isPermaLink="false">IFW-${kind}-${s.id}-${s.level}-${addDays(s.fcStart, s.levelDay)}</guid>`,
      `      <pubDate>${rfc822(snap.generated)}</pubDate>`,
      `      <description>${x(body)}</description>`,
      '    </item>',
    ].join('\n') });
  }
  items.sort((a, b) => b.score - a.score);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    '    <title>Iran Flood Watch — current flood alerts</title>',
    `    <link>${SITE_URL}</link>`,
    `    <atom:link href="${SITE_URL}feed.xml" rel="self" type="application/rss+xml"/>`,
    '    <description>Unofficial river-flood and flash-flood alerts for Iran from ensemble forecasts. English and Persian.</description>',
    '    <language>en</language>',
    '    <copyright>© 2026 Parisa Abbasalizadehrezaei. All rights reserved.</copyright>',
    `    <lastBuildDate>${rfc822(snap.generated)}</lastBuildDate>`,
    '    <ttl>15</ttl>',
    ...items.map((i) => i.xml),
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
}
