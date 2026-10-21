// 把 QQ 本地的表情扫成一张索引表，让她"挑着发"。
//
// QQ 自己的表情缓存散在几个目录里（我的表情 / 商城表情 / 群友发来的），
// 文件名是十六进制串，人挑不动。所以扫一遍、写一份 index.json，
// 她按 index 里的 id 挑，再把 path 填进 [[img:...]] 就行。
//
// 只读 QQ 的目录，一个字节都不改。
//
// 用法：node scripts/stickers.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, loadConfig } from '../src/config.mjs';

// 扫哪个号的 QQ 表情缓存：环境变量优先，其次看配置里的主人号，都没有就报错让人指定
const cfg = (() => { try { return loadConfig({ logger: { warn() {}, info() {} } }); } catch { return {}; } })();
const QQ_UIN = process.env.QAD_QQ_UIN || String(cfg?.owner?.userIds?.[0] || '').trim();
if (!QQ_UIN) {
  console.error('不知道该扫哪个 QQ 号的表情缓存：设一下 QAD_QQ_UIN=你的QQ号，');
  console.error('或者先在 config.local.json 里填 owner.userIds。');
  process.exit(1);
}
const BASE = path.join(
  os.homedir(), 'Documents', 'Tencent Files', QQ_UIN, 'nt_qq', 'nt_data', 'Emoji',
);

const SOURCES = [
  { group: '我的表情', dir: path.join(BASE, 'personal_emoji', 'Ori') },
  { group: '商城表情', dir: path.join(BASE, 'marketface') },
  { group: '收到', dir: path.join(BASE, 'emoji-recv') },
];

const EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

function walk(dir, out = [], depth = 0) {
  if (depth > 4) return out;
  let list = [];
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const ent of list) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out, depth + 1);
    else if (EXT.has(path.extname(ent.name).toLowerCase())) out.push(p);
  }
  return out;
}

const items = [];
const seen = new Set();
for (const src of SOURCES) {
  const files = walk(src.dir);
  for (const f of files) {
    // emoji-recv 有 Ori/ 和 Thumb/ 两份，缩略图不要
    if (/[\\/]Thumb[\\/]/i.test(f)) continue;
    if (seen.has(f)) continue;
    let bytes = 0;
    try { bytes = fs.statSync(f).size; } catch { continue; }
    if (bytes < 1024) continue;
    seen.add(f);
    items.push({ group: src.group, path: f, bytes });
  }
}

// 大到小排，缩略图那种小图自然沉底
items.sort((a, b) => b.bytes - a.bytes);

const data = {
  scannedAt: new Date().toISOString(),
  sources: SOURCES.map((s) => ({ group: s.group, dir: s.dir })),
  count: items.length,
  items: items.map((it, i) => ({ id: `s${String(i + 1).padStart(4, '0')}`, ...it })),
};

const outDir = path.join(ROOT, 'data', 'stickers');
fs.mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, 'index.json');
const tmp = `${file}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
fs.renameSync(tmp, file);

const byGroup = {};
for (const it of items) byGroup[it.group] = (byGroup[it.group] ?? 0) + 1;
console.log(`扫到 ${items.length} 张 → ${file}`);
for (const [g, n] of Object.entries(byGroup)) console.log(`  ${g}: ${n}`);

// 另外单独留一份"自己的"（我的表情 + 商城），挑起来快
const mine = { scannedAt: data.scannedAt, count: 0, items: [] };
for (const it of data.items) {
  if (it.group === '我的表情' || it.group === '商城表情') {
    mine.items.push({ ...it, id: `m${String(mine.items.length + 1).padStart(3, '0')}` });
  }
}
mine.count = mine.items.length;
const mineFile = path.join(outDir, 'mine.json');
const mineTmp = `${mineFile}.tmp`;
fs.writeFileSync(mineTmp, JSON.stringify(mine, null, 1), 'utf8');
fs.renameSync(mineTmp, mineFile);
console.log(`自己的表情 ${mine.count} 张 → ${mineFile}`);
