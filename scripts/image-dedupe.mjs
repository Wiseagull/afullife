// 收图的去重：按内容哈希分组，一组只留一张（留最早到的那张），其余挪进 archive，不删。
//
// 2026-11-05 第一次是拿 tmp/dupscan2.cjs 手工跑的：1070 个文件 → 507 张，563 份进了
// data/images/archive-dupes，清单写在 data/images/dupes-manifest.csv。
// 但桥在跑旧代码（还按 msgId 起名），新图一直进来、一直重复，手工跑一遍只顶一阵。
// 所以把那次的手工活固化成这个脚本：可以反复跑，幂等，默认只报告不动手。
//
// 用法：
//   node scripts/image-dedupe.mjs              # 只看：多少张、多少组、能省多少
//   node scripts/image-dedupe.mjs --apply      # 真搬（只挪进 archive，不删）
//   node scripts/image-dedupe.mjs --apply --dir data/images --archive data/images/archive-dupes
//
// 清单格式跟第一次的一致（大写 sha256 / kept / moved，moved 用 ; 分隔），
// 同一组以后再冒出来就往原来那行后面接，不新开一行。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
}
const APPLY = process.argv.includes('--apply');
const DIR = path.resolve(arg('dir', 'data/images'));
const ARCHIVE = path.resolve(arg('archive', path.join(DIR, 'archive-dupes')));
const MANIFEST = path.resolve(arg('manifest', path.join(DIR, 'dupes-manifest.csv')));

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase();

function readManifest() {
  const rows = new Map();
  if (!fs.existsSync(MANIFEST)) return rows;
  const lines = fs.readFileSync(MANIFEST, 'utf8').split(/\r?\n/).filter(Boolean);
  for (const line of lines.slice(1)) {
    const m = line.match(/^"([0-9A-F]+)","([^"]*)","([^"]*)"$/);
    if (!m) continue;
    rows.set(m[1], { kept: m[2], moved: m[3] ? m[3].split(';') : [] });
  }
  return rows;
}

function writeManifest(rows) {
  const keys = [...rows.keys()].sort();
  const out = ['"hash","kept","moved"'];
  for (const k of keys) {
    const r = rows.get(k);
    out.push(`"${k}","${r.kept}","${r.moved.join(';')}"`);
  }
  fs.writeFileSync(MANIFEST, out.join('\n') + '\n');
}

// ── 扫 ────────────────────────────────────────────────────
const files = fs.readdirSync(DIR, { withFileTypes: true })
  .filter((e) => e.isFile() && IMAGE_RE.test(e.name))
  .map((e) => {
    const p = path.join(DIR, e.name);
    const st = fs.statSync(p);
    return { name: e.name, p, size: st.size, mtime: st.mtimeMs, hash: sha(p) };
  });

const groups = new Map();
for (const f of files) {
  if (!groups.has(f.hash)) groups.set(f.hash, []);
  groups.get(f.hash).push(f);
}

const dupGroups = [...groups.entries()].filter(([, a]) => a.length > 1);
const waste = dupGroups.reduce((s, [, a]) => s + a.reduce((t, x) => t + x.size, 0) - a[0].size, 0);

console.log(`目录 ${path.relative(process.cwd(), DIR) || '.'}`);
console.log(`文件 ${files.length} 个，不同内容 ${groups.size} 张，重复组 ${dupGroups.length} 个`);
console.log(`重复多占 ${(waste / 1048576).toFixed(1)}MB${APPLY ? '' : '（只是看看，没动）'}`);

if (!dupGroups.length) process.exit(0);

// ── 搬 ────────────────────────────────────────────────────
const rows = readManifest();
let moved = 0, failed = 0, dirty = false;
const plan = [];

for (const [hash, arr] of dupGroups) {
  arr.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
  const [keeper, ...dupes] = arr;
  plan.push({ hash, keeper, dupes });
}

if (!APPLY) {
  for (const p of plan.slice(0, 8)) {
    console.log(`  ${p.keeper.name}  ←  ${p.dupes.map((d) => d.name).join(', ')}`);
  }
  if (plan.length > 8) console.log(`  …还有 ${plan.length - 8} 组`);
  process.exit(0);
}

fs.mkdirSync(ARCHIVE, { recursive: true });
for (const { hash, keeper, dupes } of plan) {
  const names = [];
  for (const d of dupes) {
    let target = path.join(ARCHIVE, d.name);
    if (fs.existsSync(target)) {
      const ext = path.extname(d.name);
      const base = d.name.slice(0, -ext.length);
      for (let i = 2; fs.existsSync(target); i += 1) target = path.join(ARCHIVE, `${base}-${i}${ext}`);
    }
    try {
      fs.renameSync(d.p, target);
      // 搬完当场核一遍：跟留下的那张字节一致才算数
      if (sha(target) !== hash) {
        fs.renameSync(target, d.p); // 不一致就退回去，别把东西挪丢了
        failed += 1;
        continue;
      }
      names.push(d.name);
      moved += 1;
    } catch {
      failed += 1;
    }
  }
  if (!names.length) continue;
  const row = rows.get(hash) || { kept: keeper.name, moved: [] };
  row.moved.push(...names.filter((n) => !row.moved.includes(n)));
  rows.set(hash, row);
  dirty = true;
}

if (dirty) writeManifest(rows);

const left = fs.readdirSync(DIR, { withFileTypes: true })
  .filter((e) => e.isFile() && IMAGE_RE.test(e.name)).length;
const archived = fs.readdirSync(ARCHIVE, { withFileTypes: true }).filter((e) => e.isFile()).length;

console.log(`搬走 ${moved} 份 → ${path.relative(process.cwd(), ARCHIVE)}${failed ? `，${failed} 份没搬成` : ''}`);
console.log(`现在 data/images ${left} 个文件，archive ${archived} 份；清单 ${rows.size} 组（${path.relative(process.cwd(), MANIFEST)}）`);
