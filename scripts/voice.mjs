#!/usr/bin/env node
// 挑几句「她平时怎么说话」当样例，写进 data/voice-samples.json。
//
// 为什么要挑旧的、而不是最新的：最新的几句质量没保证（可能正是在跑偏的那些）。
// 挑的标准是「短、像人话、没有工具痕迹」——这些句子摆回她眼前，就是把她自己的声音钉住。
//
// 私聊和群聊的腔调不一样，所以按场合分开存（scope）：
//   node scripts/voice.mjs pick --scope=private        # 只从私聊里挑
//   node scripts/voice.mjs pick --scope=group          # 只从群里挑
//   node scripts/voice.mjs pick --scope=room:group:123 # 只给这个房间挑
//   node scripts/voice.mjs show [--room=private:123]   # 看这个房间实际会用哪份
//   node scripts/voice.mjs clear --scope=private
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/config.mjs';
import {
  pickSamples, loadStore, saveStore, setScope, samplesFor, parseScope, kindOfRoom,
} from '../src/body/voice.mjs';

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

function whereLabel(parsed, kind) {
  if (parsed.kind === 'room') return '这个房间';
  if (kind === 'private') return '私聊里';
  if (kind === 'group') return '群里';
  return '';
}

if (cmd === 'pick') {
  const n = Number(arg('n', 5));
  const days = Number(arg('days', 3));
  // --scope 是「写给谁」；--room 是旧的偷懒写法（只挑这个房间、也只写给这个房间）
  const scope = arg('scope', arg('room', 'global'));
  const parsed = parseScope(scope);
  const onlyRoom = parsed.kind === 'room' ? parsed.room : '';
  const kind = parsed.kind === 'private' || parsed.kind === 'group' ? parsed.kind : '';
  let events = readEvents(days);
  if (kind) events = events.filter((e) => e.room && kindOfRoom(e.room) === kind);
  const samples = pickSamples(events, { n, room: onlyRoom });
  if (!samples.length) {
    console.log(`${whereLabel(parsed, kind)}这几天她说的都太长了，没挑出合适的（只要 2~45 字、不带路径和工具痕迹的）。`);
    process.exit(1);
  }
  const store = loadStore(FILE);
  setScope(store, scope, samples);
  saveStore(FILE, store);
  console.log(`给「${scope}」挑了 ${samples.length} 句：`);
  for (const s of samples) console.log(`  · ${s}`);
  console.log('\n下一轮她就照这个腔调说话（不用重启桥）。');
} else if (cmd === 'show') {
  const store = loadStore(FILE);
  const room = arg('room', '');
  if (room) {
    const hit = samplesFor(store, room);
    console.log(`房间 ${room} 会用「${hit.from || '没有'}」那一份：`);
    for (const s of hit.samples) console.log(`  · ${s}`);
    if (!hit.samples.length) console.log('  （空的——她只靠人设卡说话）');
  } else {
    const dump = (label, list) => {
      console.log(`${label}：${list.length ? '' : '（空）'}`);
      for (const s of list) console.log(`  · ${s}`);
    };
    dump('私聊', store.private);
    dump('群聊', store.group);
    dump('全局', store.global);
    for (const [k, v] of Object.entries(store.rooms || {})) dump(`房间 ${k}`, v);
  }
} else if (cmd === 'clear') {
  const store = loadStore(FILE);
  const scope = arg('scope', 'global');
  setScope(store, scope, []);
  saveStore(FILE, store);
  console.log(`清掉了（${scope}）。那一档她不再带样例。`);
} else {
  console.log('用法：\n  node scripts/voice.mjs pick --scope=private|group|global|room:<房间号> [--n=5] [--days=3]\n  node scripts/voice.mjs show [--room=<房间号>]\n  node scripts/voice.mjs clear --scope=...');
  process.exit(1);
}
