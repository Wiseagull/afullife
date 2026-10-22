// 发布前自检：扫一遍会被提交的文件，看有没有不该出去的字符串。
//
//   node scripts/check-secrets.mjs
//
// 只读，不改任何东西。退出码 1 = 有可疑项。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/config.mjs';

// 这些目录本来就不进仓库，扫它们没有意义
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'data', 'tmp', 'backups', 'dist',
]);

// 会被推上去的文件才看
const SKIP_FILES = new Set(['config.local.json', 'package-lock.json', 'pnpm-lock.yaml']);
const SKIP_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.zip', '.exe', '.log', '.pid']);

// 自检用的假图（PNG/JPEG 的 base64 开头）会被"长令牌"规则误判成密钥——
// 它们本来就是测试夹具，不是秘密。这里显式放行。
const BASE64_IMAGE = /^(iVBORw0KGgo|ffd8ffe|R0lGODlh|UklGR)/;

/** 看着像密钥/令牌的东西 */
const PATTERNS = [
  { name: 'DeepSeek key', re: /\bsk-[A-Za-z0-9]{20,}/g },
  { name: '长令牌（40+ 位混合串）', re: /\b[A-Za-z0-9_-]{40,}\b/g },
  { name: '疑似密码赋值', re: /\b(password|passwd|pwd)\s*[:=]\s*['"][^'"]{4,}['"]/gi },
  { name: 'Bearer 头里的真令牌', re: /Bearer\s+[A-Za-z0-9._-]{20,}/g },
];

/** 疑似个人标识：QQ 号、群号、昵称。留个眼，不一定都要改。 */
const IDENTITY = [
  { name: 'QQ号/群号（5-11位数字）', re: /(?<![\d.])(\d{5,11})(?![\d.])/g, noisy: true },
];

/** 这些是本机路径，发出去会暴露你的目录结构（不算致命，但值得知道） */
const LOCAL_PATHS = [
  { name: '个人目录', re: /[A-Za-z]:\\+Users\\+[^\\'"\s]+/g },
  { name: '本机路径', re: /(?<![A-Za-z])[A-Za-z]:\\[^'"\s]{3,}/g },
];

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) walk(path.join(dir, ent.name), out);
      continue;
    }
    if (!ent.isFile()) continue;
    if (SKIP_FILES.has(ent.name)) continue;
    if (SKIP_EXT.has(path.extname(ent.name).toLowerCase())) continue;
    out.push(path.join(dir, ent.name));
  }
  return out;
}

const files = walk(ROOT);
const hits = [];
const softHits = [];
const idHits = [];

for (const file of files) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  // 自检脚本自己带着这些正则，别自己报自己
  const isSelf = rel === 'scripts/check-secrets.mjs';

  for (const p of PATTERNS) {
    for (const m of text.matchAll(p.re)) {
      // 测试用例里的假串放过；自检夹具里的 base64 假图也放过
      if (/FAKE|example|dummy|xxxx/i.test(m[0])) continue;
      if (BASE64_IMAGE.test(m[0])) continue;
      hits.push({ file: rel, kind: p.name, sample: m[0].slice(0, 12) + '…' });
    }
  }
  if (isSelf) continue;
  const isDoc = /\.md$/i.test(rel);   // 文档里本来就要举例子，路径不算泄露
  for (const p of isDoc ? [] : LOCAL_PATHS) {
    for (const m of text.matchAll(p.re)) {
      if (/someone|<user>|example/i.test(m[0])) continue;
      softHits.push({ file: rel, kind: p.name, sample: m[0] });
    }
  }
  for (const p of IDENTITY) {
// eslint-disable-next-line no-control-regex
    if (p.noisy && !/(?:\d{9,11})/.test(text)) continue; // 长数字才像号码，短的太多噪音
    for (const m of text.matchAll(p.re)) {
      // 形如 123456789 / 1000000001 这种一眼假的号码放过（真号码不会这么整齐）
      if (/^(1?2?3?4?5?6?7?8?9?0?)0{3,}$/.test(m[0])) continue;
      if (/^(123456789|1234567890|1000000001|2000000001|3000000001)$/.test(m[0])) continue;
      idHits.push({ file: rel, kind: p.name, sample: m[0] });
    }
  }
}

function report(title, list, limit = 12) {
  console.log(`\n${title}：${list.length} 处`);
  for (const h of list.slice(0, limit)) console.log(`  ${h.file} · ${h.kind} · ${h.sample}`);
  if (list.length > limit) console.log(`  …… 还有 ${list.length - limit} 处`);
}

console.log(`扫了 ${files.length} 个文件（data/ tmp/ backups/ node_modules 不在其中）`);
report('⚠ 可能是密钥/令牌', hits);
report('· 本机路径（不致命，看你介不介意）', softHits, 6);
report('· 疑似个人标识（QQ 号 / 群号 / 昵称，自己看一眼要不要留）', idHits, 10);

if (!hits.length) console.log('\n没有发现密钥。可以发。');
process.exit(hits.length ? 1 : 0);
