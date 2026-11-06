// 给清理目录里「不想按账龄删」的文件登记一下：keep.json 的增删和查看。
//
// 清理那头（src/media/cleanup.mjs）只认文件名：登过的，再老也不动，
// 超出容量时也排在最后。原来这件事只能手改 JSON——多一个手改的机会，
// 就多一次把名字写错、把 path 写进去、把整份格式改坏的机会。
//
// 只管登记，不删文件：
//   node scripts/keep.mjs list  data/stickers/reject
//   node scripts/keep.mjs add   data/stickers/reject k0247.png
//   node scripts/keep.mjs rm    data/stickers/reject k0247.png
//
// 名字必须先真在目录里，不然不登记——防止拼错一个名字，以为护住了，其实没有。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/config.mjs';

const [cmd, dirArg, ...names] = process.argv.slice(2);
const USAGE = '用法：node scripts/keep.mjs list|add|rm <目录> [文件名...]';

function resolveDir(a) {
  if (!a) return '';
  const abs = path.isAbsolute(a) ? a : path.join(ROOT, a);
  if (fs.existsSync(abs)) return abs;
  const fromCwd = path.resolve(a);
  return fs.existsSync(fromCwd) ? fromCwd : abs;
}

function load(file) {
  // 读不懂就当空表，但别覆盖掉坏掉的原文——先另存一份再说
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(j)) return { note: '', keep: j };
    return { ...j, keep: Array.isArray(j?.keep) ? j.keep : [] };
  } catch {
    if (fs.existsSync(file)) {
      const bak = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}`;
      fs.copyFileSync(file, bak);
      console.log(`keep.json 读不懂，原样留了一份：${bak}`);
    }
    return { note: '', keep: [] };
  }
}

function save(file, data) {
  const body = { ...data, keep: [...new Set(data.keep)] };
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

if (!['list', 'add', 'rm'].includes(cmd)) {
  console.log(USAGE);
  process.exit(1);
}
const dir = resolveDir(dirArg);
if (!dir || !fs.existsSync(dir)) {
  console.error(`目录不存在：${dirArg || '(没给)'}`);
  process.exit(1);
}
const file = path.join(dir, 'keep.json');
const data = load(file);

const inDir = new Set(
  fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name !== 'keep.json') // 清单自己不算内容
    .map((e) => e.name),
);
const stat = (n) => {
  try {
    const st = fs.statSync(path.join(dir, n));
    return `${(st.size / 1024).toFixed(0)}KB  ${Math.floor((Date.now() - st.mtimeMs) / 86400000)}天前`;
  } catch { return '读不到'; }
};

if (cmd === 'list') {
  const pinned = data.keep.filter((n) => inDir.has(n));
  const gone = data.keep.filter((n) => !inDir.has(n));
  const rest = [...inDir].filter((n) => !data.keep.includes(n));
  console.log(`${path.relative(ROOT, dir) || dir}：${inDir.size} 个文件，登记 ${pinned.length} 个`);
  for (const n of pinned) console.log(`  ${n}  ${stat(n)}`);
  if (gone.length) console.log(`  登记了但目录里没有：${gone.join('、')}`);
  console.log(`  没登记、照常按账龄清：${rest.length} 个`);
  if (data.note) console.log(`  备注：${data.note}`);
} else {
  if (!names.length) {
    console.log(USAGE);
    process.exit(1);
  }
  if (cmd === 'add') {
    const bad = names.filter((n) => !inDir.has(n));
    if (bad.length) {
      console.error(`目录里没有这些文件，没登记：${bad.join('、')}`);
      process.exit(1);
    }
    save(file, { ...data, keep: [...data.keep, ...names] });
    console.log(`登记 ${names.length} 个 → ${path.relative(ROOT, file)}`);
  } else {
    save(file, { ...data, keep: data.keep.filter((n) => !names.includes(n)) });
    console.log(`撤掉 ${names.length} 个 → ${path.relative(ROOT, file)}`);
  }
  const now = load(file).keep.length;
  console.log(`现在共登记 ${now} 个`);
}
