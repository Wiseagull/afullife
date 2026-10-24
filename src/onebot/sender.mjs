// 发送侧：Markdown 清洗、空格分条、长文切分、逐条发出。
// 空格分条 = 模型用空格表示"这里断成下一条"，像真人那样连着发几条。
import fs from 'node:fs';
import { toPlain, splitMessage, splitSentences } from '../util/text.mjs';
import { stripLeaks } from '../util/sanitize.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Sender {
  constructor({ client, maxLen = 1200, gapMs = 350, dryRun = false, split = null, logger = null, random = Math.random }) {
    this.client = client;
    this.maxLen = maxLen;
    this.gapMs = gapMs;
    this.dryRun = dryRun;
    this.split = split || { enabled: false };
    this.logger = logger;
    this.random = random;
  }

  /**
   * 面板里改了 send.*（分句开关、条间间隔、单条上限、演练开关）之后原地换掉。
   * 为什么不每轮现读：这些值每发一条都要用，构造时拷进来最快；
   * 改的时候调一次这个，比把 cfg 塞进每个方法干净。
   */
  reconfigure(next = {}) {
    if (next.maxLen != null) this.maxLen = next.maxLen;
    if (next.gapMs != null) this.gapMs = next.gapMs;
    if (next.dryRun != null) this.dryRun = next.dryRun;
    if (next.split !== undefined) this.split = next.split || { enabled: false };
  }

  /**
   * 一句一行：她按回车分条，一行就是一条消息。
   * 不再按空格切 —— 中文里空格不是分句号，切出来全是断句不对的碎块。
   */
  splitIntoBursts(text) {
    const s = String(text ?? '').trim();
    if (!s) return [];
    if (this.split?.enabled === false) return [s];

    const softMax = Number(this.split?.softMax ?? 120);
    const rows = s
      .split(String.fromCharCode(10))
      .map((x) => x.split(String.fromCharCode(13)).join('').trim())
      .filter(Boolean);
    const list = (rows.length ? rows : [s]).flatMap((line) => splitSentences(line, softMax));

    const max = Math.max(1, Number(this.split?.maxBubbles ?? 8));
    if (list.length <= max) return list;
    // 条数太多就并到末尾一条，免得刷屏
    const head = list.slice(0, max - 1);
    head.push(list.slice(max - 1).join(' '));
    return head;
  }

  /** 准备要发的内容：清洗 + 按空格分条 + 每条再按长度兜底切。 */
  prepare(text) {
    // 先擦系统标记再清洗：她偶尔会把上下文里的 ACP 编号（m00123 那种）当成开头抄出来
    return this.splitIntoBursts(stripLeaks(toPlain(text))).flatMap((p) => splitMessage(p, this.maxLen));
  }

  /** 两条之间的停顿：按上一条多长估「他在打字」的时间，再抖一下。 */
  #burstGap(prev = '') {
    const s = this.split || {};
    const perChar = Number(s.perCharMs ?? 55);
    const min = Number(s.gapMinMs ?? 400);
    const max = Math.max(min, Number(s.gapMaxMs ?? 2600));
    const jitter = 0.85 + this.random() * 0.35;
    let gap = Math.min(max, Math.max(min, String(prev).length * perChar)) * jitter;
    if (this.random() < Number(s.longGapProbability ?? 0)) {
      const lmin = Number(s.longGapMinMs ?? gap);
      const lmax = Math.max(lmin, Number(s.longGapMaxMs ?? lmin));
      gap = lmin + this.random() * (lmax - lmin);
    }
    return Math.round(gap);
  }

  async sendPrivate(userId, text, opts = {}) {
    return this.#deliver('send_private_msg', { user_id: Number(userId) }, text, opts);
  }

  async sendGroup(groupId, text, opts = {}) {
    return this.#deliver('send_group_msg', { group_id: Number(groupId) }, text, opts);
  }

  /** 发一张图。走 base64，省得为路径、盘符和权限操心。 */
  async sendPrivateImage(userId, file) {
    return this.#deliverImage('send_private_msg', { user_id: Number(userId) }, file);
  }

  async sendGroupImage(groupId, file) {
    return this.#deliverImage('send_group_msg', { group_id: Number(groupId) }, file);
  }

  /** 戳回去。群里要带 group_id，私聊只带 user_id。 */
  async sendPoke({ userId, groupId = 0 } = {}) {
    const params = groupId ? { group_id: Number(groupId), user_id: Number(userId) } : { user_id: Number(userId) };
    try {
      await this.client.call('send_poke', params);
      return true;
    } catch (err) {
      this.logger?.('send', `戳回去失败：${err?.message ?? err}`);
      return false;
    }
  }

  async #deliverImage(action, target, file) {
    if (this.dryRun) {
      this.logger?.('send', `(dry) 图片 ${file}`);
      return [null];
    }
    const b64 = fs.readFileSync(file).toString('base64');
    const data = await this.client.call(action, {
      ...target,
      message: [{ type: 'image', data: { file: `base64://${b64}` } }],
    });
    return [data?.message_id ?? null];
  }

  async #deliver(action, target, text, opts = {}) {
    const bursts = this.splitIntoBursts(toPlain(text));
    const replyTo = opts?.replyTo ? String(opts.replyTo) : '';
    const ids = [];
    const parts = [];
    let sentFirst = false;
    for (let bi = 0; bi < bursts.length; bi += 1) {
      const chunks = splitMessage(bursts[bi], this.maxLen).filter(Boolean);
      for (let ci = 0; ci < chunks.length; ci += 1) {
        const part = chunks[ci];
        // 分几条发的时候中间有停顿（按字数算的间隔）。这段停顿里房间可能变——
        // 他插一句，后面那几条的含义就变了。所以每发下一条之前问一句"还要不要发"。
        // 第一段不问：调用方在调进来之前已经看过一次了。
        if (ids.length > 0 && typeof opts.shouldContinue === 'function') {
          let go = true;
          try {
            go = await opts.shouldContinue({ sent: parts.length, part });
          } catch {
            go = true; // 判断本身出错就别拦她说话
          }
          if (!go) {
            opts.aborted = true;
            opts.sentParts = parts.slice();
            this.logger?.('send', `发到第 ${parts.length} 段，房间变了，剩下的不发了`);
            return ids;
          }
        }
        // 只有当她要引用的那条是第一条：引用段挂在第一句上，后面几句跟着走
        const withReply = replyTo && !sentFirst;
        const message = withReply
          ? [{ type: 'reply', data: { id: replyTo } }, { type: 'text', data: { text: part } }]
          : part;
        if (this.dryRun) {
          this.logger?.('send', `(dry) ${JSON.stringify(target)}${withReply ? ` reply→${replyTo}` : ''} → ${part.slice(0, 80)}`);
          ids.push(null);
        } else {
          try {
            const data = await this.client.call(action, { ...target, message });
            ids.push(data?.message_id ?? null);
          } catch (err) {
            this.logger?.('send', `发送失败（第 ${ids.length + 1} 段）: ${err?.message ?? err}`);
            throw err;
          }
        }
        parts.push(part);
        sentFirst = true;
        const lastChunk = ci === chunks.length - 1;
        const last = lastChunk && bi === bursts.length - 1;
        if (last) continue;
        // 换一条（空格分条）用真人的停顿节奏；同一条被长度切开用固定的短间隔
        const gap = lastChunk ? this.#burstGap(part) : this.gapMs;
        if (gap > 0) await sleep(gap);
      }
    }
    return ids;
  }
}
