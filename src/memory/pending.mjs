// 对不上的事：我记着的，和刚听到的，不一致。
// 不自己改，攒成一条待确认，等找个机会问他一句。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// 他那句话像不像在说这件事：拿字面的双字词对一遍。
// 2026-10-26 22:1x 之前这里不看内容——任何一句主人说的话都会落到第一条"问过"的事上，
// 两条一起问的时候第二条永远收不到回答，而第一条会把一句完全无关的话记成"他说清楚了"，
// 再当成【他的解释】喂给 distill 去改记忆。宁可当没回、再问一遍，别把错话写进记忆。
const STOP_GRAMS = new Set([
  '可以', '这个', '那个', '什么', '一个', '我们', '你们', '他们',
  '就是', '还是', '不是', '这样', '那样', '时候', '现在', '知道',
]);

function gramSet(text) {
  const s = String(text || '').toLowerCase().replace(/[^\p{Script=Han}a-z0-9]+/gu, '');
  const out = new Set();
  for (let i = 0; i + 1 < s.length; i += 1) {
    const g = s.slice(i, i + 2);
    if (!STOP_GRAMS.has(g)) out.add(g);
  }
  return out;
}

/** 一句话里有多少字面跟这件事重合（双字词个数） */
export function overlap(item, text) {
  const said = gramSet(text);
  if (!said.size) return 0;
  const asked = gramSet(`${item.noteText}${item.claim}`);
  let hit = 0;
  for (const g of said) if (asked.has(g)) hit += 1;
  return hit;
}

export class PendingStore {
  #file;
  #items = [];

  constructor({ file }) {
    this.#file = file;
    this.#load();
  }

  #load() {
    try {
      this.#items = JSON.parse(fs.readFileSync(this.#file, 'utf8')) || [];
    } catch {
      this.#items = [];
    }
  }

  all() {
    return [...this.#items];
  }

  /** 还没问出口的 */
  open(room = null) {
    return this.#items.filter((p) => p.status === 'open' && (!room || p.room === room || !p.room));
  }

  answered() {
    return this.#items.filter((p) => p.status === 'answered');
  }

  add({ noteId, noteText, claim, source = [], room = null }) {
    const text = String(claim || '').trim();
    if (!text) return null;
    // 同一件事别攒一堆
    if (this.#items.some((p) => p.status !== 'closed' && p.noteId === noteId && p.claim === text)) return null;
    const item = {
      id: `pd_${randomUUID().slice(0, 8)}`,
      at: new Date().toISOString(),
      status: 'open',
      noteId,
      noteText: String(noteText || '').trim(),
      claim: text,
      source: source.filter(Boolean),
      room,
    };
    this.#items.push(item);
    this.#save();
    return item;
  }

  markAsked(id) {
    const p = this.#items.find((x) => x.id === id);
    if (!p || p.status !== 'open') return false;
    p.status = 'asked';
    p.askedAt = new Date().toISOString();
    this.#save();
    return true;
  }

  /** 还挂着等回话的：同一个房间的先算，其次是不分房间的 */
  askedFor(room) {
    const asked = this.#items.filter((x) => x.status === 'asked');
    return [
      ...asked.filter((x) => x.room && x.room === room),
      ...asked.filter((x) => !x.room),
    ];
  }

  /** 他回话了 —— 只有那句真的像在回答这件事，才记下他的说法 */
  markAnswered({ room, text }) {
    const p = this.askedFor(room).find((x) => overlap(x, text) >= 2);
    if (!p) return null;
    p.status = 'answered';
    p.answer = String(text || '').slice(0, 500);
    p.answeredAt = new Date().toISOString();
    this.#save();
    return p;
  }

  close(id) {
    const p = this.#items.find((x) => x.id === id);
    if (!p) return false;
    p.status = 'closed';
    p.closedAt = new Date().toISOString();
    this.#save();
    return true;
  }

  #save() {
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.#items, null, 2), 'utf8');
    fs.renameSync(tmp, this.#file);
  }
}
