#!/usr/bin/env node
// 挑几句「她平时怎么说话」当样例，写进 data/voice-samples.json。
//
// 为什么要挑旧的、而不是最新的：最新的几句质量没保证（可能正是在跑偏的那些）。
// 挑的标准是「短、像人话、没有工具痕迹」——这些句子摆回她眼前，就是把她自己的声音钉住。
//
//   node scripts/voice.mjs pick [--n=5] [--room=private:123] [--days=3]
//   node scripts/voice.mjs show
//   node scripts/voice.mjs clear
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { ROOT } from '../src/config.mjs';
import { pickSamples, loadSamples, saveSamples } from '../src/body/voice.mjs';

const cfg = loadConfig();
const FILE = path.join(ROOT, 'data', 'voice-samples.json');
const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const cmd = process.argv[2] || 'show';

function readEvents(days) {
  const dir = path.join(ROOT, 'data', 'events');
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().slice(-Math.max(1, days))
    : [];
  const out = [];
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
    }
  }
  return out;
}

if (cmd === 'pick') {
  const n = Number(arg('n', 5));
  const days = Number(arg('days', 3));
  const room = arg('room', '');
  const events = readEvents(days);
  const samples = pickSamples(events, { n, room });
  if (!samples.length) {
    console.log('没挑到合适的句子（可能是这几天她没说话，或者说的都不够短）。');
    process.exit(1);
  }
  saveSamples(FILE, samples);
  console.log(`挑了 ${samples.length} 句，写进 ${path.relative(ROOT, FILE)}：`);
  for (const s of samples) console.log(`  · ${s}`);
  console.log('\n下一轮她就照这个腔调说话（不用重启桥）。');
} else if (cmd === 'show') {
  const samples = loadSamples(FILE);
  if (!samples.length) {
    console.log('还没有口吻样例。跑一句：node scripts/voice.mjs pick');
  } else {
    console.log(`${samples.length} 句：`);
    for (const s of samples) console.log(`  · ${s}`);
  }
} else if (cmd === 'clear') {
  if (fs.existsSync(FILE)) fs.rmSync(FILE);
  console.log('清掉了。她不带样例说话了（全靠人设卡）。');
} else {
  console.log('用法：\n  node scripts/voice.mjs pick [--n=5] [--room=] [--days=3]\n  node scripts/voice.mjs show\n  node scripts/voice.mjs clear');
  process.exit(1);
}
