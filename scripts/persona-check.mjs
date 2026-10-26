#!/usr/bin/env node
// 人设有没有漂：拿数据说话，不靠感觉。
//
// 三个指标，都从她自己说过的话里算：
//   ① 平均长度  —— 从"四十来字"涨到一百多，就是开始写小作文了
//   ② 结构化    —— 出现列表/小标题/"首先其次最后"，就是在交报告
//   ③ 自称率    —— 她自己那句口头禅还在不在（具体词从人设卡里摸，摸不到就跳过）
//
//   node scripts/persona-check.mjs [--days=3] [--n=40] [--room=]
//
// 退出码：0 正常，1 有指标越线（方便挂进定时跑）。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/config.mjs';

const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const days = Number(arg('days', 3));
const n = Number(arg('n', 40));
const room = arg('room', '');

function readEvents() {
  const dir = path.join(ROOT, 'data', 'events');
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().slice(-days);
  const out = [];
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* 坏行跳过 */ }
    }
  }
  return out;
}

// 这些是「本」字开头但不是自称的词，别当成她的口头禅
const STOP_SELF = new Set(['本身', '本来', '本次', '本意', '本机', '本地', '本质', '本事', '本能', '本卡', '本领']);

// 她怎么自称：命令行 --self 优先，其次人设卡里出现最多的「本X」，都没有就跳过这项
function selfWord() {
  const given = arg('self', '');
  if (given) return given;
  const counts = new Map();
  for (const name of ['core.md', 'group.md', 'self.md']) {
    const p = path.join(ROOT, 'persona', name);
    if (!fs.existsSync(p)) continue;
    const t = fs.readFileSync(p, 'utf8');
    for (const m of t.matchAll(/(本[\u4e00-\u9fa5]{1,2})/g)) {
      if (STOP_SELF.has(m[1])) continue;
      counts.set(m[1], (counts.get(m[1]) || 0) + 1);
    }
  }
  let best = '';
  let top = 2;
  for (const [w, c] of counts) if (c > top) { best = w; top = c; }
  return best;
}

// 真排版：列表、加粗、编号——不管在哪个房间都算结构化
const STRUCT_HARD = /(^|\n)\s*[-*•]\s|\*\*|(^|\n)\s*\d+[.、]\s/;
// 口头的「首先其次最后」：只在群聊里算。私聊里这些词天天当普通词用
// （「最后只剩一线」「就是最后那两行」），拿它当报告标记只会误伤
const STRUCT_TALK = /首先|其次|最后|综上|总之|总结一下|以下几点/;

const PRIVATE = (k) => k.startsWith('private');

const all = readEvents().filter((e) => e && e.dir === 'out' && typeof e.text === 'string' && e.text.trim());
const mine = (room ? all.filter((e) => e.room === room) : all).slice(-n);

if (mine.length < 10) {
  console.log(`只找到 ${mine.length} 条她的发言，样本太少，先不判断。`);
  process.exit(0);
}

const lens = mine.map((e) => e.text.length).sort((a, b) => a - b);
const avg = Math.round(lens.reduce((a, b) => a + b, 0) / lens.length);
const median = lens[Math.floor(lens.length / 2)];
const long = mine.filter((e) => e.text.length > 120).length;
const hitsStruct = (e) => STRUCT_HARD.test(e.text) || (!PRIVATE(e.room || '') && STRUCT_TALK.test(e.text));
const struct = mine.filter(hitsStruct).length;
const word = selfWord();
let selfCount = word ? mine.filter((e) => e.text.includes(word)).length : -1;
// 自动摸出来的词一次都没出现，多半摸错了（人设卡里“本X”不止自称这一种）→ 干脆不量
if (selfCount === 0 && !arg('self', '')) { console.log(`（认出来的自称「${word}」一次都没出现，跳过这项；想量就加 --self=）`); selfCount = -1; }

console.log(`最近 ${mine.length} 条（${days} 天内${room ? `，房间 ${room}` : ''}）：`);
console.log(`  平均长度 ${avg} 字 / 中位 ${median} 字 / 超过 120 字的 ${long} 条`);

// 上面那个平均是跨房间混算的：群聊该短，私聊的长常常是场景描写。
// 混在一个数里，一句「平均 141」会把「群聊 15 字」也一起判成小作文——拆开才看得清是谁长。
const byRoom = new Map();
for (const e of mine) {
  const k = e.room || '(无房间)';
  if (!byRoom.has(k)) byRoom.set(k, []);
  byRoom.get(k).push(e);
}
if (byRoom.size > 1) {
  console.log('  按房间：');
  for (const [k, rows] of [...byRoom].sort((a, b) => b[1].length - a[1].length)) {
    const l = rows.map((e) => e.text.length).sort((a, b) => a - b);
    const a = Math.round(l.reduce((x, y) => x + y, 0) / l.length);
    console.log(`    ${k.padEnd(22)} ${String(rows.length).padStart(2)} 条  平均 ${String(a).padStart(3)}  中位 ${String(l[Math.floor(l.length / 2)]).padStart(3)}  最长 ${l[l.length - 1]}`);
  }
  console.log('  （长度是按房间混算的；群聊和私聊该用两把尺子）');
}

console.log(`  结构化（列表·小标题·"首先其次"） ${struct} 条`);if (selfCount >= 0) console.log(`  用「${word}」自称 ${selfCount} 条（${Math.round((selfCount / mine.length) * 100)}%）`);
else console.log('  自称：认不出她自称什么，跳过（想量就加 --self=本鲸）');

// 每个房间一把尺子。群聊该短；私聊里的长回复多半是那种场景要的，
// 拿群聊的阈值去量它，红灯会一直亮着，亮久了就没人看了。
function judge(rows, key) {
  const l = rows.map((e) => e.text.length).sort((a, b) => a - b);
  const a = Math.round(l.reduce((x, y) => x + y, 0) / l.length);
  const longN = rows.filter((e) => e.text.length > 120).length;
  const structN = rows.filter(hitsStruct).length;
  const selfN = word ? rows.filter((e) => e.text.includes(word)).length : -1;
  const bad = [];
  // 长度只量群聊；私聊的长短归场景说了算
  if (!PRIVATE(key)) {
    if (a > 90) bad.push(`平均 ${a} 字偏长（像写小作文了）`);
    if (longN >= Math.max(3, rows.length * 0.15)) bad.push(`${longN} 条超过 120 字`);
  }
  if (structN >= Math.max(3, rows.length * 0.1)) bad.push(`${structN} 条带结构化标记（像交报告）`);
  if (selfN >= 0 && selfN / rows.length < 0.2) bad.push(`只有 ${Math.round((selfN / rows.length) * 100)}% 还用自己的自称`);
  return bad;
}

const verdicts = [...byRoom].map(([k, rows]) => [k, judge(rows, k)]);
const bad = verdicts.flatMap(([k, b]) => b.map((x) => (byRoom.size > 1 ? `${k}：${x}` : x)));

if (!bad.length) {
  console.log('\n✓ 没看出漂。');
  process.exit(0);
}
console.log('\n⚠ 看着有点漂：');
for (const b of bad) console.log(`  · ${b}`);
if (byRoom.size > 1) console.log('  （私聊只量结构化和自称，长度不参与）');
console.log('\n两个补救：node scripts/voice.mjs pick（把口吻样例重新挑一遍）；或看看是不是会话里堆了太多长回复。');
process.exit(1);
