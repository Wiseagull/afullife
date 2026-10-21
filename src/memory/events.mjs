// 事件流：追加式 JSONL，按天分文件。
// 这是唯一真相 —— 记忆里的其他东西都是它的投影。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const pad = (n) => String(n).padStart(2, '0');

function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export class EventLog {
  #dir;

  constructor({ dir }) {
    this.#dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  #file(day = dayKey()) {
    return path.join(this.#dir, `events-${day}.jsonl`);
  }

  append(record) {
    const line = JSON.stringify({
      eid: `ev_${randomUUID().slice(0, 8)}`,
      ts: Date.now(),
      ...record,
    });
    fs.appendFileSync(this.#file(), line + '\n', 'utf8');
    return JSON.parse(line);
  }

  #files() {
    try {
      return fs.readdirSync(this.#dir)
        .filter((f) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }

  /**
   * 取最近的事件（时间正序返回）。
   * @param {{room?: string, limit?: number}} opts
   */
  readRecent({ room = null, limit = 40 } = {}) {
    const out = [];
    for (const name of this.#files()) {
      let text = '';
      try { text = fs.readFileSync(path.join(this.#dir, name), 'utf8'); } catch { continue; }
      const lines = text.split('\n');
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i].trim();
        if (!line) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        if (room && rec.room !== room) continue;
        out.push(rec);
        if (out.length >= limit) break;
      }
      if (out.length >= limit) break;
    }
    return out.reverse();
  }

  /**
   * 取 ts >= sinceTs 的全部事件（时间正序）。
   * 整理记忆时用：从上次整理到现在，发生了什么。
   */
  readSince(sinceTs = 0) {
    const out = [];
    const names = this.#files().slice().reverse(); // 旧 → 新
    for (const name of names) {
      let text = '';
      try { text = fs.readFileSync(path.join(this.#dir, name), 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        const s = line.trim();
        if (!s) continue;
        let rec;
        try { rec = JSON.parse(s); } catch { continue; }
        if ((rec.ts || 0) >= sinceTs) out.push(rec);
      }
    }
    return out;
  }
}
