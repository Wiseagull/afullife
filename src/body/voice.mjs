// 「她平时怎么说话」的样例。
//
// 为什么需要这个东西：人设不是被忘掉的，是被最近的自己带跑的。
// 一轮对话里，她看到的最近几十条里有一半是她自己刚说的话；
// 只要有一阵子说得长、说得像在交报告，后面就会照着那个样子继续说下去。
// 光在末尾写「说话用平时那样」压不住——规则比不过样例。
//
// 所以这里挑几句**短、自然、没有工具痕迹**的旧话，摆在她眼前当锚。
// 挑的是「最像她」的，不是「最新的」：新话质量没保证，旧话已经沉淀过了。
import fs from 'node:fs';
import path from 'node:path';

// 两个字的「早呀」「耶！」也是她的样子，别嫌短；但一个字太没信息量
const MIN_LEN = 2;
const MAX_LEN = 45;

// 长得像"规程/说明书"的句子不能当样例，否则等于把跑偏的样子钉在她的锚上
const BAD = [
  /^\s*[-*•]\s/m, /\*\*/, /```/, /^\s*\d+[.、]\s/m,
  /首先|其次|最后|综上|总之|总结一下|以下几点|需要注意/,
  /https?:\/\//, /[A-Za-z]:\\/, /`[^`]+`/, /[/\\]/,
  /(read_image|pwsh|git |node |npm |curl )/i,
];

/** 一句能不能当样例 */
export function isSample(text = '') {
  const t = String(text).trim();
  if (t.length < MIN_LEN || t.length > MAX_LEN) return false;
  if (t.includes('\n')) return false;
  if (BAD.some((re) => re.test(t))) return false;
  return true;
}

function bigrams(s = '') {
  const clean = String(s).replace(/\s|[，。！？…、,.!?~～]/g, '');
  const out = new Set();
  for (let i = 0; i < clean.length - 1; i += 1) out.add(clean.slice(i, i + 2));
  return out;
}

function tooSimilar(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return false;
  let hit = 0;
  for (const x of A) if (B.has(x)) hit += 1;
  return hit / Math.min(A.size, B.size) > 0.5;
}

/**
 * 从事件流里挑几句当口吻样例。
 * @param {Array} events 事件（按时间正序）
 * @param {{n?:number, room?:string, selfNames?:string[]}} opts
 * @returns {string[]}
 */
export function pickSamples(events = [], { n = 5, room = '', selfNames = [] } = {}) {
  const names = [selfNames].flat().filter(Boolean);
  const pool = events.filter((e) => {
    if (!e || e.dir !== 'out') return false;
    if (room && e.room !== room) return false;
    return isSample(e.text);
  });
  // 从新到旧扫，先收新的（近的更像现在的她），但要去掉互相太像的
  const out = [];
  for (let i = pool.length - 1; i >= 0 && out.length < n; i -= 1) {
    const t = String(pool[i].text).trim();
    if (names.some((nm) => t === nm)) continue;
    if (out.some((x) => tooSimilar(x, t))) continue;
    out.unshift(t);
  }
  return out;
}

/** 读样例文件；没有/坏了就当没有 */
export function loadSamples(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(raw) ? raw : raw?.samples;
    return (Array.isArray(list) ? list : []).filter((x) => typeof x === 'string' && x.trim()).slice(0, 8);
  } catch { return []; }
}

export function saveSamples(file, samples = []) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ samples, pickedAt: new Date().toISOString() }, null, 2));
  return samples.length;
}

/** 拼成提示词里那一段 */
export function voiceBlock(samples = []) {
  const list = (samples || []).filter((x) => typeof x === 'string' && x.trim()).slice(0, 8);
  if (!list.length) return '';
  const lines = ['【你平时说话的样子】'];
  for (const s of list) lines.push(`- ${s.trim()}`);
  lines.push('（这是你自己说过的话。照这个样子说，别换一种腔调——上面的规矩再长，也不该把你的声音改掉。）');
  return lines.join(String.fromCharCode(10));
}
