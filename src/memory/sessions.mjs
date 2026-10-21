// 房间 → DSH 会话 id 的映射。
// 有了它，同一个房间里的话是"接着上次说"，不是每次重新认识你。
import fs from 'node:fs';
import path from 'node:path';

export class SessionMap {
  #file;
  #data = {};

  constructor({ file }) {
    this.#file = file;
    try {
      this.#data = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    } catch {
      this.#data = {};
    }
  }

  get(room) {
    return this.#data[room]?.sessionId || null;
  }

  set(room, sessionId) {
    if (!room || !sessionId) return;
    this.#data[room] = { sessionId, updatedAt: Date.now() };
    this.#save();
  }

  clear(room) {
    if (!this.#data[room]) return;
    delete this.#data[room];
    this.#save();
  }

  entries() {
    return Object.entries(this.#data).map(([room, v]) => ({ room, ...v }));
  }

  #save() {
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.#data, null, 2), 'utf8');
    fs.renameSync(tmp, this.#file);
  }
}
