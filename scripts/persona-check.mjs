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
      counts.set(m[1], (counts.get(m[1]) || 0) + 1);
    }
  }
  let best = '';
  let top = 2;
  for (const [w, c] of counts) if (c > top) { best = w; top = c; }
  return best;
}

const STRUCTURED = /(^|\n)\s*[-*•]\s|\*\*|(^|\n)\s*\d+[.、]\s|首先|其次|最后|综上|总之|总结一下|以下几点/;

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
const struct = mine.filter((e) => STRUCTURED.test(e.text)).length;
const word = selfWord();
let selfCount = word ? mine.filter((e) => e.text.includes(word)).length : -1;
// 自动摸出来的词一次都没出现，多半摸错了（人设卡里“本X”不止自称这一种）→ 干脆不量
if (selfCount === 0 && !arg('self', '')) { console.log(`（认出来的自称「${word}」一次都没出现，跳过这项；想量就加 --self=）`); selfCount = -1; }

console.log(`最近 ${mine.length} 条（${days} 天内${room ? `，房间 ${room}` : ''}）：`);
console.log(`  平均长度 ${avg} 字 / 中位 ${median} 字 / 超过 120 字的 ${long} 条`);
console.log(`  结构化（列表·小标题·"首先其次"） ${struct} 条`);
if (selfCount >= 0) console.log(`  用「${word}」自称 ${selfCount} 条（${Math.round((selfCount / mine.length) * 100)}%）`);
else console.log('  自称：认不出她自称什么，跳过（想量就加 --self=本鲸）');

const bad = [];
if (avg > 90) bad.push(`平均 ${avg} 字偏长（像写小作文了）`);
if (long >= Math.max(3, mine.length * 0.15)) bad.push(`${long} 条超过 120 字`);
if (struct >= Math.max(3, mine.length * 0.1)) bad.push(`${struct} 条带结构化标记（像交报告）`);
if (selfCount >= 0 && selfCount / mine.length < 0.2) bad.push(`只有 ${Math.round((selfCount / mine.length) * 100)}% 还用自己的自称`);

if (!bad.length) {
  console.log('\n✓ 没看出漂。');
  process.exit(0);
}
console.log('\n⚠ 看着有点漂：');
for (const b of bad) console.log(`  · ${b}`);
console.log('\n两个补救：node scripts/voice.mjs pick（把口吻样例重新挑一遍）；或看看是不是会话里堆了太多长回复。');
process.exit(1);
