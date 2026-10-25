/**
 * 一轮没跑完时，把「卡在哪」交回给她。
 *
 * 旧行为：超时 = 整轮作废、一个字都不发出去。2026-10-24 21:42 她画图连着撞了
 * 两次五分钟超时，他对着手机等了四十分钟，没图也没话，只有在日志里才看得见
 * 「重开也失败」。这里的出口只有一个：让失败落到她自己身上，由她说出来。
 */

/**
 * 写进下一次尝试的 prompt 末尾。
 *
 * @param {string} why 上一轮失败的原因（超时那条里带着卡在哪一步、多少秒没动静）
 * @param {{retry?: boolean}} opts
 *   retry=true：还有机会，让她自己定要接着做还是如实说没弄成；
 *   retry=false：已经连着两轮没跑完，只让她说一句实话，别再动手。
 */
export function stallNote(why, { retry = true } = {}) {
  const head = `【刚才那一轮没跑完】${String(why || '没有原因').slice(0, 300)}`;
  return retry
    ? `${head}\n这不是他的错，也不是他在催。这一轮你自己定：接着把刚才那件事做完，或者如实告诉他这次没弄成、卡在哪一步——别装作做完了。`
    : `${head}\n连着两轮都没跑完。这一轮先别动手，也不要再调用任何工具。就说一句实话：这件事没弄成，卡在哪一步。`;
}

/**
 * 「上一轮没跑完」留个记号，等她下次开口时自己提。
 *
 * 为什么不直接发一句出去：三轮都塌了，说明模型根本起不来——第四次是同一条路，
 * 还会死在同一个地方。而替她说一句「没弄成」是在冒充她，比不吭声更假。
 * 所以那时什么也不发，只把这件事记下来，等她下一轮开口时放回她眼前，
 * 由她决定提不提、怎么提。
 */
export class FailBook {
  constructor({ ttlMs = 6 * 3600_000 } = {}) {
    this.ttlMs = ttlMs;
    this.map = new Map();
  }

  /**
   * 记一笔。同一个房间连着塌，只留最后一次。
   *
   * @param {string} roomKey
   * @param {{why?: string, said?: string, tools?: string[]}} what
   *   why 失败原因；said 他当时说的那句话——不提这个，她下次开口就是没头没脑
   *   一句「上次卡住了」，他自己都忘了那是在说什么；tools 她当时停在哪个工具。
   */
  add(roomKey, { why = '', said = '', tools = [] } = {}) {
    const list = (Array.isArray(tools) ? tools : []).filter(Boolean).slice(-3);
    this.map.set(String(roomKey), {
      why: String(why || '没有原因').slice(0, 300),
      said: String(said || '').replace(/\s+/g, ' ').trim().slice(0, 60),
      tools: list.join(' → '),
      at: Date.now(),
    });
  }

  /**
   * 取出来就清掉——只提醒一次。
   * 隔太久（默认六小时）就不提了：那时候「上次没弄成」已经没意义，
   * 硬提一句反而像失忆的人在翻旧账。
   */
  take(roomKey, now = Date.now()) {
    const key = String(roomKey);
    const hit = this.map.get(key);
    if (!hit) return '';
    this.map.delete(key);
    if (now - hit.at > this.ttlMs) return '';
    // 先说清「那是件什么事」：他那时候说的是哪句、她停在哪个工具上。
    // 少了这层，她隔两小时再开口，听的人根本接不上。
    const bits = [];
    if (hit.said) bits.push(`他那时候说：「${hit.said}」`);
    if (hit.tools) bits.push(`你当时停在 ${hit.tools}`);
    const about = bits.length
      ? `${bits.join('，')}。那次没弄成——${hit.why}`
      : `那次没弄成——${hit.why}`;
    return `【上一次卡在这儿】${about}。\n你还没跟他说过。要是现在合适就提一句；不想提也行，但别当成做完了。`;
  }
}
