// 「她平时怎么说话」的样例。
//
// 为什么需要这个东西：人设不是被忘掉的，是被最近的自己带跑的。
// 一轮对话里，她看到的最近几十条里有一半是她自己刚说的话；
// 只要有一阵子说得长、说得像在交报告，后面就会照着那个样子继续说下去。
// 光在末尾写「说话用平时那样」压不住——规则比不过样例。
//
// 但**私聊和群聊的腔调本来就不一样**：私聊可以黏、可以撒娇、可以晃尾巴；
// 群里得短、得懒、得不招人烦。拿群体的样例去喂私聊（或者反过来），
// 两边都会打架，所以按场合分开存：
//   global  兜底（哪个场合都没单独设时用）
//   private 私聊
//   group   群聊
//   rooms   某个具体房间（最优先）
// 查找顺序：这个房间 → 同类的（私聊/群聊）→ 全局 → 都没有就不带这段。
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

/** 房间号属于哪一类：private / group */
export function kindOfRoom(roomKey = '') {
  const s = String(roomKey);
  if (s.startsWith('group:')) return 'group';
  if (s.startsWith('private:')) return 'private';
  return '';
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

const emptyStore = () => ({ global: [], private: [], group: [], rooms: {} });
const cleanList = (x) => (Array.isArray(x) ? x : [])
  .filter((s) => typeof s === 'string' && s.trim())
  .slice(0, 8);

/**
 * 读整份样例表。老格式（直接是数组 / {samples:[...]}）当成 global，别把存档读坏。
 * @returns {{global:string[], private:string[], group:string[], rooms:Record<string,string[]>}}
 */
export function loadStore(file) {
  const store = emptyStore();
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return store; }
  if (Array.isArray(raw)) { store.global = cleanList(raw); return store; }
  if (!raw || typeof raw !== 'object') return store;
  if (Array.isArray(raw.samples)) store.global = cleanList(raw.samples);
  store.private = cleanList(raw.private);
  store.group = cleanList(raw.group);
  if (raw.rooms && typeof raw.rooms === 'object') {
    for (const [k, v] of Object.entries(raw.rooms)) {
      const list = cleanList(v && v.samples ? v.samples : v);
      if (list.length) store.rooms[k] = list;
    }
  }
  return store;
}

export function saveStore(file, store) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const out = {
    global: store.global || [],
    private: store.private || [],
    group: store.group || [],
    rooms: store.rooms || {},
    pickedAt: new Date().toISOString(),
  };
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  return out;
}

/** scope 写法：global / private / group / room:<房间号>（直接给房间号也认） */
export function parseScope(scope = 'global') {
  const s = String(scope || 'global');
  if (s === 'global' || s === 'private' || s === 'group') return { kind: s, room: '' };
  if (s.startsWith('room:')) return { kind: 'room', room: s.slice(5) };
  if (s.includes(':')) return { kind: 'room', room: s };
  return { kind: 'global', room: '' };
}

/** 往某个 scope 写样例；scope 是 room 时要带房间号 */
export function setScope(store, scope, samples = []) {
  const { kind, room } = parseScope(scope);
  const list = cleanList(samples);
  if (kind === 'room') {
    if (!room) throw new Error('room scope 要带房间号');
    if (list.length) store.rooms[room] = list; else delete store.rooms[room];
  } else {
    store[kind] = list;
  }
  return store;
}

/**
 * 某个房间该看到的样例：这个房间 → 同类（私聊/群聊）→ 全局。
 * @returns {{samples:string[], from:''|'room'|'private'|'group'|'global', scope:string}}
 */
export function samplesFor(store, roomKey = '') {
  const kind = kindOfRoom(roomKey);
  if (roomKey && store.rooms && store.rooms[roomKey] && store.rooms[roomKey].length) {
    return { samples: store.rooms[roomKey], from: 'room', scope: `room:${roomKey}` };
  }
  if (kind && store[kind] && store[kind].length) return { samples: store[kind], from: kind, scope: kind };
  if (store.global && store.global.length) return { samples: store.global, from: 'global', scope: 'global' };
  return { samples: [], from: '', scope: '' };
}

/** 老接口：整份当 global 读写 */
export function loadSamples(file) {
  return loadStore(file).global;
}

export function saveSamples(file, samples = []) {
  const store = loadStore(file);
  setScope(store, 'global', samples);
  saveStore(file, store);
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
