// 戳一戳：他戳她一下，她可以说话、戳回去、或者不理。
//
// 三个概率加起来不用等于 1：按权重抽，抽到哪个算哪个（都没配就默认 说话 0.5 / 戳回 0.3 / 不理 0.2）。
// 另外有冷却：刚戳过就别连着回，不然两个人互相戳个没完。

/** OneBot v11 的戳一戳通知。不同实现字段略有差别，这里都认。 */
export function isPoke(raw) {
  if (!raw || raw.post_type !== 'notice') return false;
  const t = String(raw.notice_type || '');
  const sub = String(raw.sub_type || '');
  return (t === 'notify' && sub === 'poke') || t === 'poke';
}

/** 戳的是不是她自己 */
export function pokedMe(raw, selfId) {
  const target = raw?.target_id ?? raw?.target;
  if (target === undefined || target === null || target === '') return true; // 有些实现不带 target，当戳自己
  return String(target) === String(selfId);
}

/** 抠出房间号：群里带 group_id，私聊没有 */
export function pokeRoom(raw) {
  const gid = raw?.group_id ?? raw?.group;
  return gid ? `group:${gid}` : `private:${raw?.user_id ?? raw?.user}`;
}

const WEIGHTS = { text: 0.5, poke: 0.3, silent: 0.2 };

/**
 * 抽一个反应。
 * @returns {'text'|'poke'|'silent'}
 */
export function decidePoke(cfg = {}, random = Math.random) {
  const p = cfg?.poke || {};
  if (p.enabled === false) return 'silent';
  const w = {
    text: Number.isFinite(Number(p.text)) ? Number(p.text) : WEIGHTS.text,
    poke: Number.isFinite(Number(p.poke)) ? Number(p.poke) : WEIGHTS.poke,
    silent: Number.isFinite(Number(p.silent)) ? Number(p.silent) : WEIGHTS.silent,
  };
  const total = w.text + w.poke + w.silent;
  if (!(total > 0)) return 'silent';
  const r = random() * total;
  if (r < w.text) return 'text';
  if (r < w.text + w.poke) return 'poke';
  return 'silent';
}

/** 冷却用的小本子：按房间记住上一次回应的时间 */
export class PokeCooldown {
  #last = new Map();
  #ms;
  constructor(ms = 30000) {
    this.#ms = Number(ms) > 0 ? Number(ms) : 0;
  }
  /** 面板里改了 poke.cooldownMs 之后原地换掉，不用重启桥。 */
  setMs(ms) {
    this.#ms = Number(ms) > 0 ? Number(ms) : 0;
  }
  /** 冷却中返回 true */
  hot(room, now = Date.now()) {
    if (!this.#ms) return false;
    const t = this.#last.get(room) || 0;
    return now - t < this.#ms;
  }
  mark(room, now = Date.now()) {
    this.#last.set(room, now);
  }
}
