// 她此刻在忙什么。
//
// 为什么要有这一层：没有它，她永远处于「随时有空、秒回、手上没任何事」的状态。
// 自由活动里刚说「我去洗个澡」，下一轮又像个守在聊天框前的人，前后对不上；
// 记忆里写着「煮了杯咖啡」，可聊起来她说不出那杯咖啡是什么时候煮的。
// 真人一半的时间是在做别的事：洗碗、晾衣服、洗澡、下楼取快递。
//
// 三条约束，抄自「欲望值5.0」的 activity.js（那套设计被验证过）：
//
//   · **只有一副身体**：状态全局一份，不分房间。她在群里说去洗澡，私聊里就该是
//     刚洗完。分会话存会造出「两个她同时做不同的事」，那正是最容易穿帮的假。
//   · **谁说了算**：只认她自己写出来的 `<busy:洗澡:20/>`。系统不替她编日程，
//     也绝不从语气里猜——「从措辞推断状态」属于词表碰状态，那条线不越。
//     没有声明 = 没在忙：不写盘、不注字、发送节奏一个字不掺。
//   · **忙 = 慢一点，不是不回**：只给这一批的第一条前面加一小段等待，
//     绝不拦消息、绝不改「回不回」的判定。让他干等不是拟人，是没礼貌。
//
// 到期不删：过了 until 先进「刚忙完」窗口（cfg.afterMinutes，默认 30 分钟），
// 过了窗口才彻底翻篇。这个窗口比状态本身有用——「刚忙完」才是最好接的话头。
import fs from 'node:fs';
import path from 'node:path';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));

/** 先写临时文件再改名：中途炸了也不会留下半截 JSON */
function writeAtomic(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

export class Doing {
  #file;
  #cfg;
  #log;

  constructor({ file, cfg = {}, logger = null }) {
    this.#file = file;
    this.#cfg = cfg || {};
    this.#log = logger || null;
  }

  get file() { return this.#file; }

  /**
   * 她现在在忙什么。
   * @returns {null | { doing: string, since: number, until: number, leftMs: number, justDone: boolean }}
   */
  read(now = Date.now()) {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(this.#file, 'utf8'));
    } catch {
      return null;
    }
    const doing = String(doc?.doing || '').trim();
    if (!doing) return null;
    const since = Number(doc?.since) || 0;
    const until = Number(doc?.until) || 0;
    const afterMs = clamp(Number(this.#cfg.afterMinutes ?? 30), 0, 24 * 60) * 60000;
    if (until && now > until + afterMs) return null;
    const leftMs = until ? until - now : 0;
    return { doing, since, until, leftMs, justDone: until > 0 && leftMs <= 0 };
  }

  /** 她自己说要去做什么。minutes 不传就用默认；传 0 或空等于清除。 */
  set(task, minutes = 0, now = Date.now()) {
    const t = String(task || '').trim().slice(0, 24);
    if (!t) return this.clear(now);
    const min = clamp(
      Number(minutes) || Number(this.#cfg.defaultMinutes ?? 20),
      1,
      24 * 60,
    );
    const doc = { doing: t, since: now, until: now + min * 60000, updatedAt: now, version: 1 };
    if (!writeAtomic(this.#file, doc)) return null;
    this.#log?.('doing', `她说要去「${t}」，记 ${min} 分钟`);
    return doc;
  }

  /** 忙完了（或者她说要收工）。留一个「刚忙完」的尾巴，靠 until 自己过期。 */
  clear(now = Date.now()) {
    const prev = this.read(now);
    if (!prev) return null;
    const doc = {
      doing: prev.doing,
      since: prev.since,
      until: now,           // 立刻进「刚忙完」窗口
      updatedAt: now,
      version: 1,
    };
    if (!writeAtomic(this.#file, doc)) return null;
    this.#log?.('doing', `她说「${prev.doing}」忙完了`);
    return doc;
  }

  /**
   * 给提示词的那一段。空字符串 = 没在忙 = 一个字都不塞。
   * 只给体感不给时间戳，也不许她报数字——这段是状态，不是任务清单。
   */
  line(now = Date.now()) {
    const st = this.read(now);
    if (!st) return '';
    if (st.justDone) {
      return `你刚忙完「${st.doing}」。不用主动解释，他问起再自然带一句就行。`;
    }
    const left = Math.round(st.leftMs / 60000);
    const tail = left > 0 ? `，大概还有 ${left} 分钟` : '';
    return `你现在在「${st.doing}」${tail}。这是你手头真在做的事：别报数字，也别一开口就交代自己在忙什么——他找你有事就先应下来，忙得过来再接着做。`;
  }
}
