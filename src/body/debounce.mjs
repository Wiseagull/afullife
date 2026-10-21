// 连发聚批：同一间屋子里，短时间内来的几条消息攒成一批再处理。
// 窗口从第一条开始算，不被后续消息重置（否则连发会让它一直等）。
export class Debounce {
  #ms;
  #onFlush;
  #buckets = new Map();

  constructor(ms, onFlush) {
    this.#ms = Math.max(0, Number(ms) || 0);
    this.#onFlush = onFlush;
  }

  get pendingKeys() { return [...this.#buckets.keys()]; }

  push(key, item) {
    let bucket = this.#buckets.get(key);
    if (!bucket) {
      bucket = { items: [], timer: null };
      bucket.timer = setTimeout(() => this.#flush(key), this.#ms);
      this.#buckets.set(key, bucket);
    }
    bucket.items.push(item);
    return bucket.items.length;
  }

  /** 立刻放行某个键（比如收到停止指令）。 */
  flush(key) {
    const bucket = this.#buckets.get(key);
    if (!bucket) return;
    if (bucket.timer) clearTimeout(bucket.timer);
    this.#flush(key);
  }

  #flush(key) {
    const bucket = this.#buckets.get(key);
    if (!bucket) return;
    this.#buckets.delete(key);
    const items = bucket.items.slice();
    bucket.items.length = 0;
    if (!items.length) return;
    Promise.resolve()
      .then(() => this.#onFlush(key, items))
      .catch(() => { /* 由 onFlush 自己记日志 */ });
  }

  async drain() {
    for (const key of [...this.#buckets.keys()]) this.flush(key);
  }
}
