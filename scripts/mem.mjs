#!/usr/bin/env node
// 翻原文的地方 —— 记忆上那个「（据 ev_xxxx）」的门牌，就是用来敲这里的。
//
// 只说一件事：**不转述**。这里吐出来的永远是一手原文，
// 不做总结、不挑选、不解释 —— 一总结就又多了一层可能出错的东西。
//
// 用法（在哪儿跑都行，路径已写死）：
//   node scripts/mem.mjs open ev_9717e7f0     # 按事件号取那一条原文
//   node scripts/mem.mjs open -1971946467     # 也可以按 QQ 消息号（老记忆里存的是这个）
//   node scripts/mem.mjs search 表情包         # 原文里含这个词的都列出来
//   node scripts/mem.mjs search 表情包 --days=3 --limit=30
//   node scripts/mem.mjs now                  # 今天到目前为止，各房间最后一句
//
// 一条都找不到时**直说找不到**，不猜、不编、不拿相近的顶替（门牌纪律第三条）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVENTS_DIR = path.join(ROOT, 'data', 'events');

const [, , cmd, ...rest] = process.argv;
const flags = Object.fromEntries(
  rest.filter((a) => a.startsWith('--')).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.length ? v.join('=') : true];
  }),
);
const argv = rest.filter((a) => !a.startsWith('--'));

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function daysBack(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(dayKey(new Date(Date.now() - i * 86400000)));
  return out;
}

function files({ days = 7 } = {}) {
  let names = [];
  try {
    names = fs.readdirSync(EVENTS_DIR).filter((f) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
  } catch {
    return [];
  }
  const want = new Set(daysBack(days));
  return names
    .filter((f) => want.has(f.replace(/^events-|\.jsonl$/g, '')))
    .sort()
    .reverse()
    .map((f) => path.join(EVENTS_DIR, f));
}

/** 这一天所有事件（原文，不裁剪） */
function readAll(opts) {
  const rows = [];
  for (const f of files(opts)) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* 半截行，跳过 */ }
    }
  }
  return rows;
}

function who(e) {
  if (e.dir === 'out') return '我';
  return e.name || e.from || '某人';
}

/** 一条事件的原样 —— 时间、房间、谁、话，一个字段都不加工 */
function show(e, i) {
  const t = new Date(Number(e.ts) || 0);
  const stamp = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
  const lines = [];
  lines.push(`${i ? `${i}. ` : ''}[${stamp}] ${e.room || '-'} · ${who(e)}${e.atMe ? '（@我）' : ''}${e.replyId ? `（回 ${e.replyId}）` : ''}`);
  lines.push(`   ${String(e.text || '').replace(/\n/g, '\n   ') || '（没有文字）'}`);
  if (Array.isArray(e.imageFiles) && e.imageFiles.length) {
    lines.push(`   图：${e.imageFiles.join(' / ')}`);
  }
  const ids = [e.eid, e.msgId].filter(Boolean).join(' / ');
  if (ids) lines.push(`   号：${ids}`);
  return lines.join('\n');
}

function cmdOpen(key) {
  if (!key) { console.log('要给个号：node scripts/mem.mjs open ev_xxxxxxxx（或 QQ 消息号）'); process.exitCode = 1; return; }
  const k = String(key).trim();
  const rows = readAll({ days: 60 });
  // 先按事件号认，认不到再按 QQ 消息号认（老记忆里存的是后者）
  let hit = rows.filter((e) => String(e.eid || '') === k);
  let by = '事件号';
  if (!hit.length) { hit = rows.filter((e) => String(e.msgId || '') === k); by = 'QQ 消息号'; }
  if (!hit.length) {
    console.log(`没有这个号：${k}`);
    console.log('（我翻了最近 60 天的事件流，一条都对不上。不猜、不拿相近的顶替 —— 可能是更早的事，或者号记错了。）');
    process.exitCode = 2;
    return;
  }
  console.log(`按${by}找到 ${hit.length} 条原文：`);
  hit.forEach((e) => { console.log(''); console.log(show(e)); });
}

function cmdSearch(word) {
  if (!word) { console.log('要给个词：node scripts/mem.mjs search 表情包'); process.exitCode = 1; return; }
  const days = Number(flags.days ?? 7) || 7;
  const limit = Number(flags.limit ?? 20) || 20;
  const needle = String(word).toLowerCase();
  const rows = readAll({ days }).filter((e) => String(e.text || '').toLowerCase().includes(needle));
  if (!rows.length) {
    console.log(`最近 ${days} 天的原文里没有「${word}」。`);
    process.exitCode = 2;
    return;
  }
  const tail = rows.slice(-limit);
  console.log(`最近 ${days} 天里含「${word}」的共 ${rows.length} 条，列最后 ${tail.length} 条（原文，未加工）：`);
  tail.forEach((e, i) => { console.log(''); console.log(show(e, i + 1)); });
}

function cmdNow() {
  const rows = readAll({ days: 1 });
  if (!rows.length) { console.log('今天还没有事件。'); return; }
  const lastByRoom = new Map();
  for (const e of rows) lastByRoom.set(e.room || '-', e);
  console.log('今天各房间最后一条（原文）：');
  for (const [room, e] of lastByRoom) { console.log(''); console.log(show(e)); }
}

switch (cmd) {
  case 'open': cmdOpen(argv[0]); break;
  case 'search': cmdSearch(argv[0]); break;
  case 'now': cmdNow(); break;
  default:
    console.log(`用法：
  node scripts/mem.mjs open <事件号|QQ消息号>   取那一条原文
  node scripts/mem.mjs search <词> [--days=7] [--limit=20]
  node scripts/mem.mjs now                    今天各房间最后一条`);
}
