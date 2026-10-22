// 记忆条目：从流水里整理出来的、长期有用的东西。
// 一条一行 JSONL —— 可追加、可 diff、可直接肉眼看、可直接 grep。
// 每条都必须带 source（来自哪些事件），否则无从对质。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const KINDS = new Set(['约定', '偏好', '事实', '待办', '交接']);

function nowIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}+08:00`;
}

function norm(text) {
  return String(text || '').replace(/\s+/g, '').replace(/[，。！？、,.!?~～…]/g, '');
}

export class NotesStore {
  #file;
  #items = [];

  constructor({ file }) {
    this.#file = file;
    this.#load();
  }

  #load() {
    this.#items = [];
    try {
      const text = fs.readFileSync(this.#file, 'utf8');
      for (const line of text.split('\n')) {
        const s = line.trim();
        if (!s) continue;
        try {
          const item = JSON.parse(s);
          if (item?.id && item?.text) this.#items.push(item);
        } catch { /* 坏行跳过，不因为一行坏了整份记忆都读不出来 */ }
      }
    } catch { /* 还没有 */ }
  }

  all() {
    return [...this.#items];
  }

  /** 还在用的（没被标成过时的） */
  active() {
    return this.#items.filter((n) => !n.staleAt);
  }

  /** 标成过时：不是删，是压下去不再摆到眼前；后悔了还能 restore */
  stale(id, why = '') {
    const item = this.get(id);
    if (!item) return null;
    item.staleAt = nowIso();
    item.staleWhy = String(why || '').slice(0, 200);
    this.#save();
    return item;
  }

  restore(id) {
    const item = this.get(id);
    if (!item) return null;
    delete item.staleAt;
    delete item.staleWhy;
    this.#save();
    return item;
  }

  get(id) {
    return this.#items.find((n) => n.id === id) || null;
  }

  add({ kind = '事实', text, room = null, source = [], weight = 2 } = {}) {
    const body = String(text || '').trim();
    if (!body) return null;
    if (this.#items.some((n) => norm(n.text) === norm(body))) return null; // 已经有了
    const item = {
      id: `nt_${randomUUID().slice(0, 8)}`,
      at: nowIso(),
      kind: KINDS.has(kind) ? kind : '事实',
      text: body,
      room,
      source: Array.isArray(source) ? source.filter(Boolean) : [],
      weight: Math.min(3, Math.max(1, Number(weight) || 2)),
    };
    this.#items.push(item);
    this.#save();
    return item;
  }

  update(id, patch = {}) {
    const item = this.get(id);
    if (!item) return null;
    if (typeof patch.text === 'string' && patch.text.trim()) item.text = patch.text.trim();
    if (patch.kind && KINDS.has(patch.kind)) item.kind = patch.kind;
    if (patch.weight != null) item.weight = Math.min(3, Math.max(1, Number(patch.weight) || 2));
    if (Array.isArray(patch.source)) item.source = patch.source.filter(Boolean);
    item.updatedAt = nowIso();
    this.#save();
    return item;
  }

  drop(id) {
    const item = this.get(id);
    if (!item) return false;
    // 先归档再删：删错了还能从 archive 里捞回来
    try {
      const dir = path.join(path.dirname(this.#file), 'archive');
      fs.mkdirSync(dir, { recursive: true });
      const day = new Date().toISOString().slice(0, 10);
      fs.appendFileSync(path.join(dir, `notes-${day}.jsonl`), `${JSON.stringify(item)}\n`, 'utf8');
    } catch { /* 归档失败也不拦住删除 */ }
    this.#items = this.#items.filter((n) => n.id !== id);
    this.#save();
    return true;
  }

  #save() {
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    const body = this.#items.map((n) => JSON.stringify(n)).join('\n') + (this.#items.length ? '\n' : '');
    const tmp = `${this.#file}.tmp`;
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, this.#file);
  }
}
