// Copyright © 2026 Parisa Abbasalizadehrezaei. All rights reserved. See LICENSE.
import { readFile } from 'node:fs/promises';

const here = new URL('.', import.meta.url);
// JSON inside <script> must not contain "</script>"
const embed = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c');

export async function renderHtml(snapshot) {
  const [tpl, topo] = await Promise.all([
    readFile(new URL('dashboard.template.html', here), 'utf8'),
    readFile(new URL('iran_topo.json', here), 'utf8'),
  ]);
  return tpl
    .replace('__SNAPSHOT__', () => embed(snapshot))
    .replace('__TOPO__', () => embed(JSON.parse(topo)));
}

export async function renderReplay(replay) {
  const [tpl, topo] = await Promise.all([
    readFile(new URL('replay.template.html', here), 'utf8'),
    readFile(new URL('iran_topo.json', here), 'utf8'),
  ]);
  return tpl
    .replace('__REPLAY__', () => embed(replay))
    .replace('__TOPO__', () => embed(JSON.parse(topo)));
}
