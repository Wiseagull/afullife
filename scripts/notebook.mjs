// 小本本：我自己的记忆库（notebook/）。
//
//   node scripts/notebook.mjs write "今天想通了一件事"
//   node scripts/notebook.mjs write --to=memories/记忆.md "一条结论"
//   node scripts/notebook.mjs read [--days=3] [--file=notes/2026-10-21.md]
//   node scripts/notebook.mjs find <词>
//   node scripts/notebook.mjs stat
//   node scripts/notebook.mjs index     重建 INDEX.md（每条一行：原文一截 + 门牌）
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, notebookDir } from '../src/config.mjs';

const cfg = loadConfig();
const DIR = notebookDir(cfg);
const LIMIT_BYTES = (Number(cfg.notebook?.limitMb) || 20480) * 1024 * 1024;

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function now() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else if (ent.isFile()) out.push(full);
  }
  return out;
}

function dirSize(dir) {
  let total = 0;
  try {
    for (const f of walk(dir)) total += fs.statSync(f).size;
  } catch { /* 空目录 */ }
  return total;
}

const args = process.argv.slice(2);
const cmd = args[0];
const flags = Object.fromEntries(
  args.filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.slice(2).split('=');
    return [k, v ?? true];
  }),
);
let words = args.slice(1).filter((a) => !a.startsWith('--')).join(' ').trim();

fs.mkdirSync(path.join(DIR, 'notes'), { recursive: true });
fs.mkdirSync(path.join(DIR, 'memories'), { recursive: true });

if (!cmd || cmd === 'help') {
  console.log(`小本本在 ${DIR}

  write "一句话"           写进今天的 notes/
  write --to=memories/x.md "一句话"   写进指定文件
  read [--days=3]          读最近几天的
  read --file=notes/2026-10-21.md     读某个文件
  find <词>                全文找
  stat                     多大、有几页
  index                    重建 INDEX.md（每条一行，带 file:line 门牌）`);
  process.exit(0);
}

if (cmd === 'write') {
  if (!words && !process.stdin.isTTY) {
    words = fs.readFileSync(0, 'utf8').trim();
  }
  if (!words) { console.error('要写点东西：notebook.mjs write "…"'); process.exit(1); }

  const size = dirSize(DIR);
  if (size > LIMIT_BYTES) {
    console.error(`小本本已经 ${(size / 1024 ** 3).toFixed(2)}GB，超上限了，先清理或压缩再写`);
    process.exit(1);
  }

  const rel = flags.to ? String(flags.to) : path.join('notes', `${today()}.md`);
  const file = path.join(DIR, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fresh = !fs.existsSync(file);
  const head = fresh ? `# ${today()}\n\n` : '';
  fs.appendFileSync(file, `${head}- ${now()} ${words}\n`, 'utf8');
  console.log(`记进 ${rel}`);
  process.exit(0);
}

if (cmd === 'read') {
  if (flags.file) {
    const file = path.join(DIR, String(flags.file));
    if (!fs.existsSync(file)) { console.error('没有这个文件'); process.exit(1); }
    process.stdout.write(fs.readFileSync(file, 'utf8'));
    process.exit(0);
  }
  const days = Number(flags.days || 1);
  const since = new Date(Date.now() - days * 86400000);
  const files = walk(path.join(DIR, 'notes'))
    .filter((f) => fs.statSync(f).mtime >= since)
    .sort();
  if (!files.length) { console.log(`这 ${days} 天没有记东西`); process.exit(0); }
  for (const f of files) {
    console.log(`\n=== ${path.relative(DIR, f).replace(/\\/g, '/')}`);
    process.stdout.write(fs.readFileSync(f, 'utf8'));
  }
  process.exit(0);
}

if (cmd === 'find') {
  if (!words) { console.error('要找什么？'); process.exit(1); }
  let hit = 0;
  for (const f of walk(DIR)) {
    if (!/\.(md|txt|json)$/i.test(f)) continue;
    if (path.basename(f) === 'INDEX.md') continue; // 索引是门牌，不是原文，别重复命中
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (line.includes(words)) {
        hit += 1;
        console.log(`${path.relative(DIR, f).replace(/\\/g, '/')}:${i + 1}  ${line.trim().slice(0, 120)}`);
      }
    });
  }
  console.log(hit ? `\n共 ${hit} 处` : '没找到');
  process.exit(0);
}

if (cmd === 'stat') {
  const files = walk(DIR).filter((f) => !/(^|\/)(README|INDEX)\.md$/.test(f.replace(/\\/g, '/')));
  const size = dirSize(DIR);
  console.log(`小本本：${files.length} 个文件，${(size / 1024).toFixed(1)}KB / 上限 20GB`);
  const byDir = {};
  for (const f of files) {
    const top = path.relative(DIR, f).split(path.sep)[0];
    byDir[top] = (byDir[top] || 0) + 1;
  }
  for (const [k, v] of Object.entries(byDir)) console.log(`  ${k}/  ${v} 个`);
  process.exit(0);
}

// 索引层：只许指路，不许生产内容。
// 每一条都是原文的一截（截断，不改写）+ 指回原文的门牌 file:line。
// 拿不准的地方宁可留"（标题）"，也不要概括——概括过的门牌会让人以为找过了。
const KEY_MAX = 46;

function keyOf(text) {
  let s = String(text).replace(/\s+/g, ' ').trim();
  // 有的条目开头连着好几个时间戳，剥掉，别让它占了正文的位置
  for (let i = 0; i < 3; i += 1) {
    const m = s.match(/^\d{1,2}:\d{2}(\s*[-~—]\s*\d{1,2}:\d{2})?\s+/);
    if (!m) break;
    s = s.slice(m[0].length);
  }
  // 只取第一句：逗号留着，句号/冒号/分号之后就是另一件事了
  const cut = s.split(/[。；]/)[0];
  const one = (cut || s).trim();
  // 按码点切，不按 UTF-16 码元切：正好切在 emoji 的代理对中间会切出半个字
  const cps = Array.from(one);
  return cps.length > KEY_MAX ? `${cps.slice(0, KEY_MAX).join('')}…` : one;
}

if (cmd === 'index') {
  const skip = new Set(['README.md', 'INDEX.md']);
  const files = walk(DIR)
    .filter((f) => /\.md$/i.test(f) && !skip.has(path.basename(f)))
    .sort();

  const groups = [];
  let total = 0;
  for (const f of files) {
    const rel = path.relative(DIR, f).replace(/\\/g, '/');
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    const rows = [];
    const bodyAt = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const n = i + 1;
      const bullet = line.match(/^\s*-\s+(\d{1,2}:\d{2})\s+(.*)$/);
      if (bullet) {
        const key = keyOf(bullet[2]);
        if (key) rows.push({ time: bullet[1], key, n });
        continue;
      }
      const heading = line.match(/^(#{1,3})\s+(.*\S)\s*$/);
      if (heading && heading[1].length > 1) {
        rows.push({ time: '', key: `〔${heading[2]}〕`, n, section: true });
        continue;
      }
      if (line.trim() && !line.startsWith('#')) bodyAt.push(i);
    }
    // 一条门牌都没落下（整篇是段落，或者 bullet 不是时间格式）：退回首段第一句。
    // 宁可只留一句，也别让这份文件从索引里整个消失。
    if (!rows.length && bodyAt.length) {
      const i = bodyAt[0];
      const key = keyOf(lines[i].replace(/^[-*>]\s+/, ''));
      if (key) rows.push({ time: '', key, n: i + 1 });
    }
    if (!rows.length) continue;
    total += rows.length;
    // 排法：notes（新的在前）→ memories → 其他（archive/tmp）
    const rank = rel.startsWith('notes/') ? 0 : rel.startsWith('memories/') ? 1 : 2;
    groups.push({ rel, rows, rank });
  }

  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;

  const out = [
    '# 小本本索引',
    '',
    '> 每行 = 原文的一截 + 指回原文的门牌。**只许指路，不许生产内容**：',
    '> 这里的字都是从原文截的，不是概括；要细节就按 `file:line` 回去读那一行。',
    '> 改了原文就重建：`node scripts/notebook.mjs index`',
    '',
    `共 ${total} 条 / ${groups.length} 个文件 · 生成于 ${stamp}`,
    '',
  ];
  for (const g of groups.sort((a, b) => a.rank - b.rank || b.rel.localeCompare(a.rel))) {
    out.push(`## ${g.rel}  (${g.rows.length})`);
    for (const r of g.rows) {
      const head = r.time ? `${r.time}  ` : '';
      out.push(`- ${head}${r.key}  → ${g.rel}:${r.n}`);
    }
    out.push('');
  }

  const file = path.join(DIR, 'INDEX.md');
  fs.writeFileSync(file, out.join('\n'), 'utf8');
  console.log(`索引重建：${total} 条 / ${groups.length} 个文件 → ${path.relative(DIR, file)}`);
  process.exit(0);
}

console.error('只认 write / read / find / stat / index');
process.exit(1);
