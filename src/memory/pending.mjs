// 对不上的事：我记着的，和刚听到的，不一致。
// 不自己改，攒成一条待确认，等找个机会问他一句。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

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

  /** 他回话了 —— 最近一条问过的那件事，记下他的说法 */
  markAnswered({ room, text }) {
    const p = this.#items.find((x) => x.status === 'asked' && (x.room === room || !x.room));
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
