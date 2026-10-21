// 她自己的兴趣：自由时间里可以做的那些事。
//
// 两本账的分工：
//   - `persona/self.md` 里那节「自由时间里想做的事」是她**写下的话**，人读的；
//   - 这个 store 是**账本**：每件事上次做是什么时候、做过几次、上次什么感觉。
// 账本只管状态，不重复记意愿。`sync()` 只做一件事：把 self.md 里新写的那几条
// 导进来（不覆盖已有状态、不因为 self.md 删了一句就把账删掉）。
//
// 挑的时候不是随机抽：越久没碰、做得越少的排前面；self.md 里排在前面的权重也高一点。
// 太久没碰的会标"凉了"，但不删——人也会这样，一阵子迷的东西过阵子就不想碰了。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DAY = 24 * 60 * 60 * 1000;

const idOf = (name) => 'in_' + crypto.createHash('sha1').update(name).digest('hex').slice(0, 8);

/** 从 self.md 的「自由时间里想做的事」那节里抠出条目名 */
export function interestsFromPersona(text) {
  const src = String(text || '');
  const lines = src.split(/\r?\n/);
  const out = [];
  let inSection = false;
  for (const line of lines) {
    if (/^##\s*/.test(line)) {
      inSection = /想做的事|兴趣/.test(line);
      continue;
    }
    if (!inSection) continue;
    const m = line.match(/^\s*[-*]\s+(.+)$/);
    if (!m) continue;
    // "画画。画得慢，但喜欢；画自己、画主人随口说的一句话。" → 只取"画画"
    const first = m[1].split(/[。，,、；;：:（(]/)[0].trim();
    if (first) out.push(first);
  }
  return out;
}

export class InterestStore {
  #file;
  #data;

  constructor({ file }) {
    this.#file = file;
    try {
      this.#data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      this.#data = { items: [] };
    }
    if (!Array.isArray(this.#data.items)) this.#data.items = [];
    this.#migrate();
  }

  #migrate() {
    for (const it of this.#data.items) {
      if (!it.id) it.id = idOf(it.name);
      if (typeof it.count !== 'number') it.count = 0;
      if (it.lastAt === undefined) it.lastAt = null;
      if (!Array.isArray(it.feelings)) it.feelings = [];
    }
  }

  #save() {
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.#data, null, 2), 'utf8');
    fs.renameSync(tmp, this.#file);
  }

  all() {
    return this.#data.items.map((it) => ({ ...it }));
  }

  get(key) {
    const k = String(key || '').trim();
    return this.#data.items.find((i) => i.id === k || i.name === k) || null;
  }

  /** 把 self.md 里新写的兴趣导进来（只增不改）。 */
  sync(personaText) {
    const names = interestsFromPersona(personaText);
    const added = [];
    names.forEach((name, idx) => {
      const hit = this.#data.items.find((i) => i.name === name);
      if (hit) {
        hit.order = idx; // self.md 里的顺序 = 她心里的轻重
        return;
      }
      this.#data.items.push({
        id: idOf(name),
        name,
        why: '',
        order: idx,
        count: 0,
        lastAt: null,
        feelings: [],
        addedAt: Date.now(),
      });
      added.push(name);
    });
    if (added.length || names.length) this.#save();
    return { added, total: this.#data.items.length };
  }

  add({ name, why = '', order = null }) {
    const n = String(name || '').trim();
    if (!n) throw new Error('兴趣总得有个名字');
    if (this.get(n)) return this.get(n);
    const it = {
      id: idOf(n),
      name: n,
      why: String(why || '').trim(),
      order: order ?? this.#data.items.length,
      count: 0,
      lastAt: null,
      feelings: [],
      addedAt: Date.now(),
    };
    this.#data.items.push(it);
    this.#save();
    return this.get(it.id);
  }

  drop(key) {
    const i = this.#data.items.findIndex((x) => x.id === key || x.name === key);
    if (i < 0) return false;
    this.#data.items.splice(i, 1);
    this.#save();
    return true;
  }

  /** 记一次"做了"。feelings 只留最近 5 条。 */
  did(key, feeling = '') {
    const it = this.#data.items.find((x) => x.id === key || x.name === key);
    if (!it) return null;
    it.count += 1;
    it.lastAt = Date.now();
    const f = String(feeling || '').trim();
    if (f) it.feelings = [...(it.feelings || []), f].slice(-5);
    this.#save();
    return { ...it };
  }

  /** 多久没碰（天）；从没碰过给一个大数，让它先被挑到。 */
  idleDays(it, now = Date.now()) {
    return it.lastAt ? (now - it.lastAt) / DAY : 999;
  }

  /**
   * 挑几件今天可以干的。
   * 分高的排前面：久没做的、做得少的、她写在 self.md 前面的。
   */
  pick(n = 3, { now = Date.now(), exclude = [] } = {}) {
    const skip = new Set(exclude.map(String));
    const scored = this.#data.items
      .filter((it) => !skip.has(it.id) && !skip.has(it.name))
      .map((it) => {
        const idle = Math.min(this.idleDays(it, now), 60);
        const order = typeof it.order === 'number' ? it.order : 0;
        const front = 1 + 1 / (1 + order); // 排前面的一点点加成
        const done = 1 + 0.5 * it.count; // 做过的往后沉
        return { it, score: (idle + 1) * front / done };
      })
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, n).map(({ it, score }) => ({
      ...it,
      idleDays: Math.round(this.idleDays(it, now)),
      score: Math.round(score * 100) / 100,
      cold: this.idleDays(it, now) > 14 && it.count > 0,
    }));
  }
}
