// 用量账本：她花了你多少 token，记在明处。
//
// 为什么要有这个：DSH 每轮都会回 usage（新输入 / 输出 / 命中缓存），
// 以前这些数拿到就丢了。攒下来有三个用处——
//   ① 面板上看得见（今天多少、各房间多少、大概多少钱）；
//   ② 她自己看得见（提示词里带一句，或者跑 node scripts/usage.mjs today）；
//   ③ 以后真想加上限时，账本已经在这儿了。
//
// 落盘：data/usage/usage-YYYY-MM-DD.jsonl，一行一轮，只追加不改写。
import fs from 'node:fs';
import path from 'node:path';

const KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'];

function ymd(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function zero() {
  return { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };
}

function addInto(acc, usage) {
  if (!usage) return acc;
  acc.turns += 1;
  for (const k of KEYS) {
    const n = Number(usage[k]);
    if (Number.isFinite(n)) acc[k] += n;
  }
  return acc;
}

/** 按配置里的单价估个钱。没配单价就返回 null（只报 token，不瞎猜价钱）。 */
export function estimateCost(usage, price) {
  const inPerM = Number(price?.inputPerM);
  const outPerM = Number(price?.outputPerM);
  const cachePerM = Number(price?.cacheReadPerM);
  if (!Number.isFinite(inPerM) && !Number.isFinite(outPerM)) return null;
  // 单价全是 0 等于没填，别显示「¥0」骗人
  if (!inPerM && !outPerM && !cachePerM) return null;
  const m = (t) => (Number(t) || 0) / 1e6;
  const cost =
    m(usage.inputTokens) * (Number.isFinite(inPerM) ? inPerM : 0) +
    m(usage.outputTokens) * (Number.isFinite(outPerM) ? outPerM : 0) +
    m(usage.cacheReadTokens) * (Number.isFinite(cachePerM) ? cachePerM : 0);
  return Math.round(cost * 10000) / 10000;
}

/** 一句话概括，给提示词和命令行共用：`12 轮 / 8.4 万 token` */
export function describeUsage(agg, { price = null, currency = '¥' } = {}) {
  const total = Number(agg?.totalTokens) || 0;
  if (!agg || !agg.turns) return '今天还没说话';
  const wan = (n) => (n >= 10000 ? `${(n / 10000).toFixed(1)} 万` : String(n));
  const parts = [`${agg.turns} 轮`, `${wan(total)} token`];
  if (agg.cacheReadTokens) parts.push(`其中 ${wan(agg.cacheReadTokens)} 命中缓存`);
  const cost = estimateCost(agg, price);
  if (cost !== null) parts.push(`${currency}${cost}`);
  return parts.join(' / ');
}

export class UsageStore {
  #dir;
  #cache = new Map(); // date -> { at, rows }

  constructor({ dir }) {
    this.#dir = dir;
    fs.mkdirSync(this.#dir, { recursive: true });
  }

  fileOf(date) {
    return path.join(this.#dir, `usage-${date}.jsonl`);
  }

  /** 记一轮。usage 来自 headless 的 status 事件。 */
  add({ room = '', usage = null, model = '', kind = 'chat' } = {}) {
    if (!usage) return null;
    const row = {
      at: new Date().toISOString(),
      room: String(room || ''),
      kind,
      model: String(model || ''),
    };
    for (const k of KEYS) row[k] = Number(usage[k]) || 0;
    fs.appendFileSync(this.fileOf(ymd()), JSON.stringify(row) + '\n', 'utf8');
    this.#cache.clear();
    return row;
  }

  rowsOf(date) {
    const hit = this.#cache.get(date);
    if (hit) return hit;
    const file = this.fileOf(date);
    const rows = [];
    try {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const s = line.trim();
        if (!s) continue;
        try { rows.push(JSON.parse(s)); } catch { /* 跳过坏行 */ }
      }
    } catch { /* 这天没有记录 */ }
    this.#cache.set(date, rows);
    return rows;
  }

  /** 今天（或指定那天）的汇总 + 按房间拆开。 */
  today(date = ymd(), opts = {}) {
    const rows = this.rowsOf(date);
    const all = zero();
    const byRoom = new Map();
    for (const r of rows) {
      addInto(all, r);
      const key = r.room || '(未知)';
      if (!byRoom.has(key)) byRoom.set(key, zero());
      addInto(byRoom.get(key), r);
    }
    const rooms = [...byRoom.entries()]
      .map(([room, agg]) => ({ room, ...agg, cost: estimateCost(agg, opts.price) }))
      .sort((a, b) => b.totalTokens - a.totalTokens);
    return { date, ...all, cost: estimateCost(all, opts.price), rooms };
  }

  /** 最近 N 天（含今天），从旧到新。 */
  days(n = 7, opts = {}) {
    const out = [];
    for (let i = n - 1; i >= 0; i -= 1) {
      const date = ymd(Date.now() - i * 86400000);
      const rows = this.rowsOf(date);
      const agg = zero();
      for (const r of rows) addInto(agg, r);
      out.push({ date, ...agg, cost: estimateCost(agg, opts.price) });
    }
    return out;
  }
}
