// 串行队列：同一时刻只有一件事在跑。
//
// 分两层用：
//   · 说话锁（main.mjs 里的 queue）——要开口的活都排这条队，保证"一个我一次只说一句"；
//   · 后台道（main.mjs 里的 bgQueue）——整理记忆、体检这种只干活不说话的，单独一条，
//     别让他的一句话排在几分钟的体检后面。这个洞 2026-10-22 下午自己记过：
//     "12:30:42 那条等到 12:31:48 才有人看，连 ack 都没发出来"。
//
// 优先级只决定"排队谁先上"：已经在跑的不会被抢断。所以会跑很久的活不该占说话锁——
// 想事情不占，只有真要发出去那一下才占（见 body/freetime.mjs 的 #say）。
//
// 不抛错、不阻塞调用方 —— 失败只记录，队列继续。
export class SerialQueue {
  #logger;
  #busy = false;
  #waiting = [];
  #seq = 0;
  #depth = 0;
  #idle = [];

  constructor({ logger = null } = {}) {
    this.#logger = logger;
  }

  /** 还没轮到的有几个（不含正在跑的那个）。 */
  get depth() { return this.#depth; }
  get busy() { return this.#busy; }

  /**
   * 排一次任务。
   * @param {() => Promise<any>} task
   * @param {string} label 仅用于日志
   * @param {{priority?: number}} [opts] 大的先跑；同一个优先级按先来后到
   * @returns {Promise<any>} 任务跑完的结果（失败时是 undefined，不 reject）
   */
  push(task, label = '', { priority = 0 } = {}) {
    this.#seq += 1;
    const item = { task, label, priority: Number(priority) || 0, seq: this.#seq, resolve: null };
    // 插到第一个"该排在它后面"的位置：优先级高的往前挤，同优先级老老实实排队
    let at = this.#waiting.length;
    for (let i = 0; i < this.#waiting.length; i += 1) {
      if (this.#waiting[i].priority < item.priority) { at = i; break; }
    }
    this.#waiting.splice(at, 0, item);
    this.#depth += 1;
    const done = new Promise((resolve) => { item.resolve = resolve; });
    this.#pump();
    return done;
  }

  async #pump() {
    if (this.#busy) return;
    const item = this.#waiting.shift();
    if (!item) return this.#settle();
    this.#busy = true;
    let out;
    try {
      out = await item.task();
    } catch (err) {
      this.#logger?.('queue', `任务失败${item.label ? `(${item.label})` : ''}: ${err?.message ?? err}`);
      out = undefined;
    } finally {
      this.#depth -= 1;
      this.#busy = false;
    }
    item.resolve?.(out);
    this.#pump();
    this.#settle();
  }

  #settle() {
    if (this.#busy || this.#waiting.length) return;
    const rs = this.#idle;
    this.#idle = [];
    for (const r of rs) r();
  }

  /** 等所有排队的任务跑完（测试与退出时用）。 */
  drain() {
    if (!this.#busy && !this.#waiting.length) return Promise.resolve();
    return new Promise((r) => this.#idle.push(r));
  }
}
