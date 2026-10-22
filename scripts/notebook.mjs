// 小本本：我自己的记忆库（notebook/）。
//
//   node scripts/notebook.mjs write "今天想通了一件事"
//   node scripts/notebook.mjs write --to=memories/记忆.md "一条结论"
//   node scripts/notebook.mjs read [--days=3] [--file=notes/2026-10-21.md]
//   node scripts/notebook.mjs find <词>
//   node scripts/notebook.mjs stat
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
  stat                     多大、有几页`);
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
  const files = walk(DIR).filter((f) => !f.endsWith('README.md'));
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

console.error('只认 write / read / find / stat');
process.exit(1);
