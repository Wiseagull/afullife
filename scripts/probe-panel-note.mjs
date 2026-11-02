/**
 * 退回说明的「两份渲染」对账。
 *
 * 为什么要有它：同一句话今天假过两次，两次都是因为写了两处。
 *   20:0x  uneven 写「N 条缝切出 M 段」，N 用全部、M 只用够高的 —— 一句话里两个数出自两处；
 *   20:1x  改这句时只改了 src/stickers/screen.mjs，`python tools/panel-split.py --dry`
 *          自己那行还在印「4 条缝切出 3 段」，而 416 项自检喂的全是 JS 那边，全过也没照到。
 * 两处代码共用一份 detail 了，但仍是两份代码。这个探针拿同一张图、同一份 detail，
 * 把 python 的 reason_note 和 mjs 的 uncutNote 放在一起逐数比对，谁改单边谁红。
 *
 *   node scripts/probe-panel-note.mjs                 # 扫 data/stickers/reject 全量
 *   node scripts/probe-panel-note.mjs --limit=20      # 只扫前 20 张，改文案时够用
 *   node scripts/probe-panel-note.mjs --dir=<别的目录>
 *
 * 只读：--dry，不落盘。python 或 PIL 没装时直接报「没验」，不当成过。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { uncutNote } from '../src/stickers/screen.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const dir = path.resolve(ROOT, opt('dir', path.join('data', 'stickers', 'reject')));
const limit = Number(opt('limit', 0)) || 0;
const selftest = args.includes('--selftest');
const py = process.env.QAD_PYTHON || 'python';
const script = path.join(ROOT, 'tools', 'panel-split.py');

if (!fs.existsSync(dir)) {
  console.log(`没这个目录：${dir}——没验，不算过`);
  process.exit(2);
}
// 别漏 .gif：reject 里 329 张有 19 张是动图，脚本对它们一样量（PIL 取第一帧）。
// 第一版这里只写了 png/jpe?g/webp，扫出来 310 张，差点当成"全量"。
const files = fs.readdirSync(dir)
  .filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f))
  .sort()
  .map((f) => path.join(dir, f))
  .slice(0, limit || undefined);
if (!files.length) {
  console.log('目录里没有图——没验，不算过');
  process.exit(2);
}

// PYTHONIOENCODING：本机 python 往管道里写的是 cp936，用 utf8 解就是一片问号。
// （mjs 那边同理，见 src/stickers/screen.mjs 的 panelize。）
const r = spawnSync(py, [script, '--files', ...files, '--dry', '--json'],
  {
    encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
if (r.status !== 0) {
  console.log(`${py} 跑不起来（status ${r.status}）：${(r.stderr || '').trim().slice(0, 300)}`);
  console.log('没验，不算过。');
  process.exit(2);
}
let rows;
try {
  rows = JSON.parse(String(r.stdout || '').trim());
} catch {
  console.log('python 的 JSON 解析不了，没验');
  process.exit(2);
}

// 一句话里所有的数（含小数），按大小排好比：157..824 这种区间也算两个数。
const nums = (s) => (String(s).match(/\d+(?:\.\d+)?/g) || []).map(Number).sort((a, b) => a - b);
// 不要求逐位相同：python 的倍数写一位（4.9），mjs 拿 seg_ratio 写两位（4.88），
// 差的是精度不是事实。整数得一刀不差，小数容 1% 或 0.05。
const sameNums = (a, b) => a.length === b.length
  && a.every((x, i) => {
    const y = b[i];
    const tol = Number.isInteger(x) && Number.isInteger(y) ? 0 : Math.max(0.05, 0.01 * Math.max(Math.abs(x), Math.abs(y)));
    return Math.abs(x - y) <= tol;
  });
const bandsOf = (row) => (Array.isArray(row?.detail?.cut_bands) ? row.detail.cut_bands.length : 0);
// 「N 条缝…M 段」：段数恒等于缝数 + 1（薄边被 min_h 丢了也一样，那是另说的）。
const seamMath = (s) => {
  const m = String(s).match(/(\d+)\s*条缝.*?(\d+)\s*段/s);
  return m ? { seams: Number(m[1]), segs: Number(m[2]) } : null;
};

// 两边的说明都过一遍：账算得通不通、数一不一样。
// mutate 只在负控里用：把某一侧加一个不可能撞上的数，探针必须报出来。
// 没有负控的探针只证明「今天两边一样」，不证明「不一样的时候它会红」。
const compare = (row, { mutateJs = false, mutatePy = false } = {}) => {
  const out = [];
  const name = path.basename(row.file);
  const jsRaw = uncutNote(row);
  const pyRaw = row.note || '';
  const js = mutateJs ? jsRaw + MUT : jsRaw;
  const note = mutatePy ? pyRaw + MUT : pyRaw;
  const where = `detail 有 ${bandsOf(row)} 条缝`;

  const sm = seamMath(js);
  if (sm && sm.segs !== sm.seams + 1) {
    out.push(`${name}｜JS 那句账算不通：${sm.seams} 条缝却 ${sm.segs} 段 ← ${js}`);
  }
  const sm2 = seamMath(note);
  if (sm2 && sm2.segs !== sm2.seams + 1) {
    out.push(`${name}｜python 那句账算不通：${sm2.seams} 条缝却 ${sm2.segs} 段 ← ${note}`);
  }
  if (row.reason !== 'not_strip') {
    // not_strip 两边本来就说法不同（这边要报中位段高，脚本那边只给一句人话），只对账数。
    if (!sameNums(nums(js), nums(note))) {
      out.push(`${name}｜两份渲染的数不一样\n  JS: ${js}\n  py: ${note}\n  ${where}`);
    }
  }
  return out;
};

const MUT = ' 999999';
const bad = [];
let checked = 0;
const seen = {};
const missed = [];
let guarded = 0;
for (const row of rows) {
  if (!row || row.error) continue;
  seen[row.reason] = (seen[row.reason] || 0) + 1;
  if (!['uneven', 'too_small', 'not_strip'].includes(row.reason)) continue;
  checked += 1;
  bad.push(...compare(row));

  // 负控：只对真要比数的两类做。not_strip 两边数本来就不对账，改了也不该红。
  if (selftest && row.reason !== 'not_strip') {
    guarded += 1;
    const name = path.basename(row.file);
    if (!compare(row, { mutateJs: true }).length) missed.push(`${name}｜改了 JS 的数，探针没红`);
    if (!compare(row, { mutatePy: true }).length) missed.push(`${name}｜改了 py 的数，探针没红`);
  }
}

const tally = Object.entries(seen).map(([k, v]) => `${k} ${v}`).join('、');
console.log(`扫 ${files.length} 张：${tally}`);
if (!checked) {
  console.log('一张退回说明都没扫到——没验，不算过');
  process.exit(2);
}
if (selftest) {
  if (missed.length) {
    console.log(`\n负控没过：${missed.length} 处改了数它还不红，这探针照不出错：`);
    for (const m of missed.slice(0, 10)) console.log('  · ' + m);
    process.exit(1);
  }
  console.log(`负控 ${guarded} 条（not_strip 不数）：改哪一侧的数都红了，这探针确实会响`);
}
if (bad.length) {
  console.log(`\n${bad.length} 处对不上（查了 ${checked} 条说明）：`);
  for (const b of bad.slice(0, 20)) console.log('  · ' + b);
  if (bad.length > 20) console.log(`  …还有 ${bad.length - 20} 条`);
  process.exit(1);
}
console.log(`对账 ${checked} 条退回说明：两份渲染逐数一致，段数=缝数+1，0 条错`);
