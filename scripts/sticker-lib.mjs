// 她自己的表情库：收、分类、找、发之前记一笔。
//
// 库只有一个写者：桥。这个脚本先走桥的 HTTP 接口（127.0.0.1:3220/api/stickers），
// 桥没开的时候才自己直接写文件——那时它本来就是唯一写者，不会互相覆盖。
// （2026-10-21 实测发现：两边各拿一份内存、整份写回，谁最后写谁赢，条目会被抹掉。）
//
// 用法：
//   node scripts/sticker-lib.mjs list [--all]
//   node scripts/sticker-lib.mjs pickup <图片路径> [--when=群里有人装逼] [--from=群123456789] [--tags=无语,翻白眼]
//   node scripts/sticker-lib.mjs tag <id> --tags=撒娇,困 [--when=…]
//   node scripts/sticker-lib.mjs find [--tags=无语] [--text=装逼] [--todo]   # --todo 只列还没分类的
//   node scripts/sticker-lib.mjs use <id>
//   node scripts/sticker-lib.mjs drop <id>
//   node scripts/sticker-lib.mjs stats                            # 多少张、多大
//   node scripts/sticker-lib.mjs prune [--count=300] [--mb=200] [--dry]  # 满了清用得最少的
//   node scripts/sticker-lib.mjs screen [--max=4]                 # 把候选过一遍眼，决定收不收
//   node scripts/sticker-lib.mjs dedupe [--dry]                   # 按内容找重复，后收的标「重复」
//   node scripts/sticker-lib.mjs where                            # 现在是谁在写库（桥 / 本地）
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadConfig } from '../src/config.mjs';
import { StickerLibrary } from '../src/stickers/library.mjs';
import { readToken } from '../src/web/token.mjs';

const cfg = loadConfig({ logger: { warn: () => {} } });
const PORT = Number(process.env.QAD_WEB_PORT || cfg.web?.port || 3220);
const URL_BASE = `http://127.0.0.1:${PORT}/api/stickers`;

/** 走桥。桥没开 → null（调用方退回本地）；桥开着但这次出错 → 原样抛，别偷偷换成本地写。 */
async function bridge(method, payload) {
  let r;
  try {
    r = await fetch(URL_BASE, {
      method,
      headers: { 'x-qad-ui': '1', 'x-qad-token': readToken(path.join(ROOT, 'data')), 'content-type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(payload || {}) : undefined,
      signal: AbortSignal.timeout(2500),
    });
  } catch (err) {
    // 只有“端口根本没人听”才算桥没开、可以退回本地写。
    // 超时是另一回事：桥多半正忙着跑一轮，它内存里还有一份账，
    // 这时候本地写进去就是两个写者，等它下次保存照样会被合并救回来，
    // 但没必要冒险——让它报错、等一会儿再试。
    const code = err?.cause?.code || err?.code || '';
    if (code === 'ECONNREFUSED' || /fetch failed/i.test(String(err?.message || '')) && !/timeout/i.test(String(err?.message || ''))) {
      return null;
    }
    throw new Error(`连不上桥（${code || err?.message || err}）——它可能在忙，等一下再试`);
  }
  const j = await r.json().catch(() => ({}));
  if (r.status === 404 && /没有 GET|没有 POST/.test(String(j?.error || ''))) {
    // 桥开着，但跑的是没有表情库接口的旧版：这时候它仍会写库，别偷偷退回本地写
    throw new Error('桥还在跑旧版（没有 /api/stickers），重启桥就好了');
  }
  if (!r.ok) throw new Error(j?.error || `桥回了 ${r.status}`);
  return j;
}

let _local = null;
function local() {
  if (!_local) {
    _local = new StickerLibrary({
      file: path.join(ROOT, 'data', 'stickers', 'library.json'),
      dir: path.join(ROOT, 'data', 'stickers', 'library'),
      root: ROOT,
      logger: (t, m) => console.log(`[${t}] ${m}`),
    });
  }
  return _local;
}

/** 读整个库：桥优先。返回 { items, stats, via } */
async function snapshot() {
  const j = await bridge('GET');
  if (j) return { items: j.items || [], stats: j.stats || { count: 0, bytes: 0 }, via: 'bridge' };
  const lib = local();
  return { items: lib.all(), stats: lib.stats(), via: 'local' };
}

/** 写操作：桥优先，桥没开才本地写。返回 { via, ...result } */
async function write(op, payload) {
  const j = await bridge('POST', { op, ...payload });
  if (j) return { via: 'bridge', ...j };
  const lib = local();
  if (op === 'add') {
    const r = lib.add({ src: path.resolve(payload.src), tags: payload.tags || [], when: payload.when || '', ctx: payload.ctx || '', from: payload.from || '', room: payload.room ?? null });
    return { via: 'local', ok: true, item: r.item, dup: r.dup };
  }
  if (op === 'update') return { via: 'local', ok: true, item: lib.update(payload.id, { ...(payload.tags !== undefined ? { tags: payload.tags } : {}), ...(payload.when !== undefined ? { when: payload.when } : {}) }) };
  if (op === 'use') return { via: 'local', ok: true, item: lib.markUsed(payload.id) };
  if (op === 'approve') return { via: 'local', ok: true, item: lib.approve(payload.id, { tags: payload.tags || [], when: payload.when || '' }) };
  if (op === 'reject') return { via: 'local', ok: lib.reject(payload.id, payload.reason || '') };
  if (op === 'drop') return { via: 'local', ok: lib.drop(payload.id) };
  if (op === 'prune') return { via: 'local', ok: true, ...lib.prune({ maxCount: payload.maxCount, maxMb: payload.maxMb, dry: payload.dry }, (t, m) => console.log(`[${t}] ${m}`)) };
  throw new Error(`不认识的写操作：${op}`);
}

const [cmd, ...rest] = process.argv.slice(2);

const arg = (name, dflt) => {
  const hit = rest.find((x) => x.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const dry = rest.includes('--dry');

const args = {};
const pos = [];
for (const a of rest) {
  const m = /^--([a-z-]+)(?:=(.*))?$/i.exec(a);
  if (m) args[m[1]] = m[2] ?? true;
  else pos.push(a);
}
const tags = (v) => (typeof v === 'string' ? v.split(/[,，、\s]+/).filter(Boolean) : []);

function show(it) {
  const mark = it.tags?.length || it.when ? '✓' : '·';
  console.log(
    `${mark} ${it.id}  [${(it.tags || []).join('/') || '未分类'}]  ${it.when || ''}` +
    `  ${(it.bytes / 1024).toFixed(0)}KB  used=${it.used ?? 0}\n    ${it.abs ?? it.file}`,
  );
}

if (cmd === 'where') {
  try {
    const j = await bridge('GET');
    console.log(j ? `库现在归桥写（127.0.0.1:${PORT}）` : `桥没开，这个脚本直接写文件（它是唯一写者）`);
  } catch (e) {
    console.log(`桥在，但用不了：${e.message}`);
  }
  process.exit(0);
}

if (cmd === 'stats') {
  const s = await snapshot();
  console.log(`${s.stats.count} 张 / ${(s.stats.bytes / 1048576).toFixed(1)} MB  （${s.via === 'bridge' ? '桥' : '本地'}）`);
  process.exit(0);
}

if (cmd === 'pending') {
  const s = await snapshot();
  const list = s.items.filter((i) => i.pending === true);
  console.log(`${list.length} 张等着看`);
  for (const it of list) console.log(`  ${it.id}  ${Math.round(it.bytes / 1024)}KB  ${it.ctx || '(没留语境)'}`);
  process.exit(0);
}

if (cmd === 'prune') {
  const r = await write('prune', { maxCount: Number(arg('count', 300)), maxMb: Number(arg('mb', 200)), dry });
  console.log(`删了 ${r.removed} 张，剩 ${r.count} 张 / ${(r.bytes / 1048576).toFixed(1)} MB  （${r.via === 'bridge' ? '桥' : '本地'}）`);
  process.exit(0);
}

if (cmd === 'screen') {
  const { HeadlessBrain } = await import('../src/brain/headless.mjs');
  const { screenStickers } = await import('../src/stickers/screen.mjs');
  const brain = new HeadlessBrain({ ...cfg.brain.headless });
  // 过眼要读候选、还要改状态：桥在就用桥的，桥没开用本地
  const up = await bridge('GET').catch(() => null);
  const book = up
    ? {
      pendingAll: async () => (await bridge('GET')).items.filter((i) => i.pending === true),
      approve: async (id, opts = {}) => (await write('approve', { id, ...opts })).item,
      reject: async (id, reason = '') => (await write('reject', { id, reason })).ok,
    }
    : local();
  const r = await screenStickers({
    brain,
    stickers: book,
    maxOps: Number(arg('max', 4)),
    logger: (t, m) => console.log(`[${t}] ${m}`),
  });
  console.log(`过眼 ${r.checked} 张：收 ${r.kept} / 退 ${r.rejected} / 跳过 ${r.skipped}`);
  process.exit(0);
}

switch (cmd) {
  case 'dedupe': {
    // 按内容认图，不按名字：QQ 转发一张表情会换名字，只有字节不变。
    // 每组留标签/语境最全的那条（一样全就留最早收的），其余加「重复」——
    // prune 的第一档就是「重复」，所以标完下次清库先走它们，不删记录也不删图。
    const fp = (p) => {
      try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16); } catch { return null; }
    };
    const s = await snapshot();
    const byHash = new Map();
    for (const it of s.items) {
      const p = path.isAbsolute(it.file) ? it.file : path.resolve(ROOT, it.file);
      const h = fp(p);
      if (!h) continue;
      if (!byHash.has(h)) byHash.set(h, []);
      byHash.get(h).push(it);
    }
    const groups = [...byHash.values()].filter((g) => g.length > 1);
    // 「重复」这个标不算分量：它只是记号，不是内容信息。否则会挑出
    // 一张空图当主、把有标签的那张标成重复（2026-10-22 dry 第一次跑就撞上了）。
    const rank = (it) => (((it.tags || []).filter((t) => t !== '重复').length ? 1 : 0) + (it.when ? 1 : 0));
    let marked = 0;
    for (const g of groups) {
      g.sort((a, b) => rank(b) - rank(a) || (a.addedAt || 0) - (b.addedAt || 0));
      const [keep, ...rest] = g;
      console.log(`留 ${keep.id} [${(keep.tags || []).join('/') || '未分类'}] ${keep.when || ''}`);
      for (const it of rest) {
        const mine = it.tags || [];
        if (mine.includes('重复')) { console.log(`  · ${it.id} 早就标了重复`); continue; }
        if (dry) { console.log(`  · ${it.id} 会标重复`); continue; }
        const r = await write('update', { id: it.id, tags: [...mine, '重复'] });
        console.log(`  · ${it.id} ${r.item ? '标了重复' : '没改成'}`);
        if (r.item) marked += 1;
      }
    }
    console.log(`${groups.length} 组重复，${marked} 张新标上「重复」（${s.via === 'bridge' ? '桥' : '本地'}）${dry ? '｜dry' : ''}`);
    break;
  }
  case 'list': {
    const s = await snapshot();
    const items = s.items;
    const list = args.all ? items : items.filter((i) => i.tags?.length || i.when);
    console.log(`库里 ${items.length} 张，已分类 ${items.filter((i) => i.tags?.length || i.when).length} 张`);
    for (const it of list.slice(-30)) show(it);
    break;
  }
  case 'pickup': {
    if (!pos[0]) { console.log('要给我一张图的路径'); break; }
    const r = await write('add', {
      src: path.resolve(pos[0]),
      tags: tags(args.tags),
      when: args.when === true ? '' : (args.when || ''),
      from: args.from === true ? '' : (args.from || ''),
      room: args.room || null,
    });
    if (!r.item) { console.log('没收进去：桥那边没给回条目'); break; }
    console.log(r.dup ? `已经在库里了：${r.item.id}` : `收下了：${r.item.id} → ${r.item.file}`);
    break;
  }
  case 'tag': {
    const r = await write('update', {
      id: pos[0],
      ...(args.tags !== undefined ? { tags: tags(args.tags) } : {}),
      ...(args.when !== undefined ? { when: args.when === true ? '' : args.when } : {}),
    });
    const it = r.item;
    console.log(it ? `改好了：${it.id} [${(it.tags || []).join('/')}] ${it.when || ''}` : '没有这个 id');
    break;
  }
  case 'find': {
    const s = await snapshot();
    const wantTags = tags(args.tags);
    const text = args.text === true ? '' : String(args.text || '');
    let list = s.items;
    if (args.todo) list = list.filter((i) => !(i.tags?.length) && !i.when);
    if (wantTags.length) {
      list = list.filter((i) => {
        const mine = i.tags || [];
        return wantTags.some((t) => mine.some((x) => x.includes(t)));
      });
    }
    if (text) {
      const t = text.toLowerCase();
      list = list.filter((i) => `${i.tags?.join(' ') || ''} ${i.when || ''} ${i.ctx || ''}`.toLowerCase().includes(t));
    }
    if (!list.length) { console.log('没找到；换个词，或者先 pickup 几张'); break; }
    for (const it of list) show(it);
    break;
  }
  case 'use': {
    const r = await write('use', { id: pos[0] });
    console.log(r.item ? `记了一笔：${r.item.id} used=${r.item.used}` : '没有这个 id');
    break;
  }
  case 'drop': {
    const r = await write('drop', { id: pos[0] });
    console.log(r.ok ? '删掉了' : '没有这个 id');
    break;
  }
  default:
    console.log(
      '用法：list | pickup <路径> [--tags=] [--when=] [--from=] | tag <id> [--tags=] [--when=] | ' +
      'find [--tags=] [--text=] [--todo] | use <id> | drop <id> | ' +
      'pending | screen [--max=4] | dedupe [--dry] | stats | prune [--count=300] [--mb=200] [--dry] | where',
    );
}
