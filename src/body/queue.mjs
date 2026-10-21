// 全局串行队列：同一时刻只有一个我在说话。
// 不抛错、不阻塞调用方 —— 失败只记录，队列继续。
export class SerialQueue {
  #tail = Promise.resolve();
  #depth = 0;
  #logger;

  constructor({ logger = null } = {}) {
    this.#logger = logger;
  }

  get depth() { return this.#depth; }

  /**
   * 排一次任务。
   * @param {() => Promise<any>} task
   * @param {string} label 仅用于日志
   */
  push(task, label = '') {
    this.#depth += 1;
    const run = async () => {
      try {
        return await task();
      } catch (err) {
        this.#logger?.('queue', `任务失败${label ? `(${label})` : ''}: ${err?.message ?? err}`);
        return undefined;
      } finally {
        this.#depth -= 1;
      }
    };
    this.#tail = this.#tail.then(run, run);
    return this.#tail;
  }

  /** 等所有排队的任务跑完（测试与退出时用）。 */
  async drain() {
    await this.#tail;
  }
}
