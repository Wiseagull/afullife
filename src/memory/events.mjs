// 事件流：追加式 JSONL，按天分文件。
// 这是唯一真相 —— 记忆里的其他东西都是它的投影。
//
// 2026-10-23：读最近 N 条不再把整份文件读进内存（那天一天能攒几千到几万行）。
// 从文件尾巴往前按块读，够数就停；跨天的按「最近的那几天」倒着找。
// 只改读的方式，文件格式和写入口都没动 —— 老数据直接可读。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const pad = (n) => String(n).padStart(2, '0');

// 一次从尾巴读多少：64KB 够装几百条，绝大多数请求一次就够
const TAIL_CHUNK = 64 * 1024;
const FILE_RE = /^events-(\d{4})-(\d{2})-(\d{2})\.jsonl$/;
const NEWLINE = 0x0a;

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
        .filter((f) => FILE_RE.test(f))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }

  /**
   * 从一份文件里按「新 → 旧」取记录，只读尾巴。
   * @param {string} name 文件名
   * @param {number} need 最多要几条
   * @param {string|null} room 只取这个房间
   * @returns {Array} 新 → 旧
   */
  #readTail(name, need, room) {
    if (!(need > 0)) return [];
    const file = path.join(this.#dir, name);
    let size = 0;
    try { size = fs.statSync(file).size; } catch { return []; }
    if (!size) return [];

    let fd;
    try { fd = fs.openSync(file, 'r'); } catch { return []; }
    try {
      let window = Math.min(TAIL_CHUNK, size);
      for (;;) {
        const start = size - window;
        const buf = Buffer.alloc(window);
        const n = fs.readSync(fd, buf, 0, window, start);
        let text = buf.subarray(0, n).toString('utf8');
        // 从半行开始读的时候，第一条是残的：先看看它前面那个字节是不是换行。
        // 是换行 = 正好从一行开头读的，别丢；不是 = 这段开头是半行，丢掉。
        if (start > 0) {
          const prev = Buffer.alloc(1);
          fs.readSync(fd, prev, 0, 1, start - 1);
          if (prev[0] !== NEWLINE) {
            const cut = text.indexOf('\n');
            text = cut === -1 ? '' : text.slice(cut + 1);
          }
        }
        const lines = text.split('\n');
        const out = [];
        for (let i = lines.length - 1; i >= 0; i -= 1) {
          const line = lines[i].trim();
          if (!line) continue;
          let rec;
          try { rec = JSON.parse(line); } catch { continue; }
          if (room && rec.room !== room) continue;
          out.push(rec);
          if (out.length >= need) return out;
        }
        if (start === 0) return out;   // 整份都读完了
        window = Math.min(window * 4, size);
      }
    } catch {
      return [];
    } finally {
      try { fs.closeSync(fd); } catch { /* 关不上也没别的办法 */ }
    }
  }

  /**
   * 取最近的事件（时间正序返回）。
   * @param {{room?: string, limit?: number}} opts
   */
  readRecent({ room = null, limit = 40 } = {}) {
    const need = Math.max(1, Number(limit) || 40);
    const out = [];
    for (const name of this.#files()) {
      out.push(...this.#readTail(name, need - out.length, room));
      if (out.length >= need) break;
    }
    return out.slice(0, need).reverse();
  }

  /**
   * 取 ts >= sinceTs 的全部事件（时间正序）。
   * 整理记忆时用：从上次整理到现在，发生了什么。
   */
  readSince(sinceTs = 0) {
    const since = Number(sinceTs) || 0;
    const out = [];
    const names = this.#files().slice().reverse(); // 旧 → 新
    for (const name of names) {
      // 按天的文件：这一天的尾巴都早于 sinceTs 就整份跳过，不用读
      const m = FILE_RE.exec(name);
      if (m) {
        const end = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1).getTime();
        if (end <= since) continue;
      }
      let text = '';
      try { text = fs.readFileSync(path.join(this.#dir, name), 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        const s = line.trim();
        if (!s) continue;
        let rec;
        try { rec = JSON.parse(s); } catch { continue; }
        if ((rec.ts || 0) >= since) out.push(rec);
      }
    }
    return out;
  }
}
