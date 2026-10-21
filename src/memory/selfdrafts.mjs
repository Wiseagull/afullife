// 「她可能想写进自己那份的话」——草稿箱。
//
// 为什么要有这个：`persona/self.md` 是她的东西，我们不该替她写；
// 但她自己也不会凭空想起来写（2026-10-22 实测：正常聊、甚至提醒一句「想记就记」，
// self.md 都一字未动）。所以桥做一件很轻的事：把对话里带情绪的话摘出来，攒成草稿，
// 下次开口时递到她眼前——写不写、怎么写，还是她决定。
import fs from 'node:fs';
import path from 'node:path';

const EMOTION = /累|难过|烦|哭|生气|高兴|开心|焦虑|失眠|委屈|难受|疼|痛|爽|孤独|寂寞|想你|舍不得|后悔|害怕|紧张|压力|崩溃|head?ache|tired|sad|angry|happy|anxious|lonely/i;

export class SelfDrafts {
  #file;
  #data;
  #save() {
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.#data, null, 1), 'utf8');
      fs.renameSync(tmp, this.#file);
    } catch { /* 存不下不影响说话 */ }
  }

  constructor({ file }) {
    this.#file = file;
    try {
      this.#data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      this.#data = { items: [], seq: 0 };
    }
    if (!Array.isArray(this.#data.items)) this.#data.items = [];
  }

  all() {
    return this.#data.items;
  }

  /** 从一条事件里摘草稿。同一句话只记一次；攒太多就让老的先走。 */
  take({ text, name = '', room = '', source = '', maxItems = 20 } = {}) {
    const t = String(text || '').trim();
    if (!t || !EMOTION.test(t)) return null;
    // 太长的（多半是转述或链接）不摘
    if (t.length > 120) return null;
    if (this.#data.items.some((i) => i.text === t)) return null;
    const item = {
      id: `sd_${(++this.#data.seq).toString(16)}`,
      text: t,
      name: String(name || ''),
      room: String(room || ''),
      source: String(source || ''),
      at: new Date().toISOString(),
    };
    this.#data.items.push(item);
    // 只留最近的 maxItems 条
    if (this.#data.items.length > maxItems) {
      this.#data.items = this.#data.items.slice(-maxItems);
    }
    this.#save();
    return item;
  }

  /** 她写过 self.md 之后，草稿就该清一清（她要么记了、要么决定不记） */
  clear() {
    const n = this.#data.items.length;
    this.#data.items = [];
    this.#save();
    return n;
  }

  /** 太老的自己过期，别一直挂着 */
  expire(days = 7, now = Date.now()) {
    const cut = now - days * 86400000;
    const before = this.#data.items.length;
    this.#data.items = this.#data.items.filter((i) => {
      const ts = Date.parse(i?.at || '');
      return !Number.isFinite(ts) || ts >= cut;
    });
    const removed = before - this.#data.items.length;
    if (removed) this.#save();
    return removed;
  }

  /** 拼成给她的那一段话；没草稿就返回空串 */
  render(limit = 3) {
    const items = this.#data.items.slice(-limit);
    if (!items.length) return '';
    const lines = items.map((i, n) => `${n + 1}. ${i.name ? `${i.name}说：` : ''}${i.text}`);
    return [
      '【也许你想记下来的】',
      '（下面这些话，是最近聊天里带着情绪的那几句——不是任务，也不是要你回应。',
      ' 你要是觉得哪句值得留在自己心里，可以写进你那份 persona/self.md：',
      ' `node scripts/self.mjs add 喜欢 "…"` / `add 讨厌 "…"` / `log "…"`。',
      ' 不想记就什么都别做，草稿会自己过期。）',
      ...lines,
    ].join('\n');
  }
}

export { EMOTION };
