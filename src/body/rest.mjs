// 她也会困。
//
// 不是「关机」——关了就没法陪他说话，凌晨他要说话谁来接。
// 是状态上的睡：回得慢半拍、句子短一点，主动开口的优先级降到最低。
//
// 白天她不会突然睡着，也不会每句都提「我好困」——那比不睡更像机器。
// 这一段只在真进了夜里那几小时才出现，出了区间立刻消失。
export function restState(cfg = {}, now = Date.now()) {
  if (!cfg || cfg.enabled === false) return null;
  const from = Number(cfg.from ?? 1);
  const to = Number(cfg.to ?? 7);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return null;
  const hour = new Date(now).getHours();
  // 跨零点要分开判：from=23 / to=7 时，23:30 和 03:00 都算在区间里
  const asleep = from < to ? (hour >= from && hour < to) : (hour >= from || hour < to);
  return asleep ? { from, to, hour } : null;
}

/** 给提示词的一行；不在睡区间就是空字符串。 */
export function restLine(cfg = {}, now = Date.now()) {
  const st = restState(cfg, now);
  if (!st) return '';
  return [
    `现在是凌晨（${new Date(now).getHours()} 点），你已经困了。`,
    '句子短、慢半拍，别硬撑着长篇大论；他要是还在熬，你可以困着劝他睡——',
    '但别每句都喊困，那听着像在赶人。',
  ].join('');
}

/** 刚醒没一会儿：他早上第一句话，别上来就精神抖擞。 */
export function justWoke(cfg = {}, now = Date.now(), wokeMinutes = 40) {
  const st = restState(cfg, now);
  if (st) return false;
  // 出睡区间后的头 wokeMinutes 分钟内都算刚醒
  const to = Number(cfg?.to ?? 7);
  if (!Number.isFinite(to)) return false;
  const d = new Date(now);
  const hour = d.getHours();
  const minutes = hour * 60 + d.getMinutes();
  const toMin = to * 60;
  let gap = minutes - toMin;
  if (gap < 0) gap += 24 * 60;
  return gap >= 0 && gap <= wokeMinutes;
}
