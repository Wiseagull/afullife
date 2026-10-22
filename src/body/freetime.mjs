// 自由活动：给她一段自己的时间。
//
// 不是开一条跑 30 分钟的长会话（那样几秒钟就烧完了，剩下 29 分钟对你来说不存在），
// 而是“一拍一拍”地叫她：每拍她都重新看一眼表、看一眼你、决定这一拍干什么。
// 这样她才是真的在这段时间里活着。

import { ROOT } from '../config.mjs';

const PERM = {
  look: '这一段你只能看，不能动：可以截图看屏幕、读文件、看进程、上网翻东西；不要点鼠标键盘，不要改任何文件，不要装东西。',
  act: '这一段你可以动手：能开程序、点鼠标、翻文件、写东西。但别删东西、别改系统设置、别装东西。',
  full: '这一段你可以自己做主：能动手，也能装东西、改设置。只有很危险的事（删盘、动系统目录、碰密码）要先问他。',
};

const PROTOCOL = [
  '这一拍你想做什么就做，做完再决定说不说话。',
  '不想说话、也不想动，就只回 <pass/>。',
  '想再等一会儿（比如等他离开电脑）就只回 <wait:秒>。',
  '觉得这段可以结束了就只回 <done/>。',
  '想跟他说一句，就直接说那句话（别加引号、别解释、别写“我打算”）。',
].join('\n');

function fmtMs(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  return `${m} 分钟`;
}

// 开场那句要不要硬开口。
//
// 06:31 那次：他 05:39 说了晚安去睡，我六点半醒来，协议要我"先主动说一句"，
// 于是"天亮得比昨天早一点"就落在一间睡着的房间里。那句话本身没写错，规则错了。
// 所以现在先看房间：没人、或者他刚说了晚安、或者隔了太久，就允许安静地待着。
export function openingMood(state = {}, {
  now = Date.now(),
  quietAfterMs = 2 * 3600_000,
  recentMs = 30 * 60_000,
  nightFrom = 23,
  nightTo = 7,
} = {}) {
  const lastTs = Number(state.lastTs) || 0;
  const lastDir = String(state.lastDir || '');
  const lastInTs = Number(state.lastInTs) || 0;
  const lastInText = String(state.lastInText || '');

  if (/晚安|睡了|睡啦|先睡|去睡|好梦/.test(lastInText.slice(-20))) {
    return { quiet: true, why: `他最后说的是「${lastInText.slice(0, 14)}」` };
  }
  if (lastDir === 'in' && lastTs && now - lastTs < recentMs) {
    return { quiet: false, why: '他刚说过话' };
  }
  if (!lastInTs) return { quiet: true, why: '这个房间里还没人说过话' };
  const gap = now - lastInTs;
  if (gap >= quietAfterMs) return { quiet: true, why: `他 ${Math.round(gap / 60000)} 分钟没出声了` };
  const h = new Date(now).getHours();
  const night = nightFrom > nightTo ? (h >= nightFrom || h < nightTo) : (h >= nightFrom && h < nightTo);
  if (night) return { quiet: true, why: '这会儿是夜里' };
  return { quiet: false, why: '' };
}

export class FreeTime {
  #cfg;
  #brain;
  #send;
  #log;
  #queue;
  #timer = null;
  #running = false;
  #endsAt = 0;
  #startedAt = 0;
  #beats = 0;
  #messages = 0;
  #opening = false;
  #errors = 0;
  #openTries = 0;
  #last = '';
  #sid = null;
  #recent = null;
  #roomState = null;
  #room;
  #onUsage;
  #reason = '';
  #interests = null;
  #drafts = null;      // 攒着的「也许想记下来的」
  #reviewed = false;   // 这一段有没有回顾过
  #openingQuiet = false; // 开场这一句是不是"没人也应"的，允许不回

  constructor({ cfg, brain, send, logger, queue, room, recent, roomState, interests, drafts, onUsage }) {
    this.#cfg = cfg;
    this.#brain = brain;
    this.#send = send;
    this.#log = logger || (() => {});
    this.#queue = queue || null;
    this.#room = room || 'private';
    this.#onUsage = onUsage || null;
    // 上一段/这一段时间里她自己说过的话，喂一拍开头，免得一段一段重复同一句
    this.#recent = recent || null;
    // 这个房间最后一条是谁说的、隔了多久——决定开场要不要硬开口
    this.#roomState = roomState || null;
    // 她自己的兴趣清单（可以不做，但至少知道自己想做什么）
    this.#interests = interests || null;
    // 草稿箱：这段快结束时递给她，看她想不想写进自己那份
    this.#drafts = drafts || null;
  }

  get room() { return this.#room; }
  set room(v) { this.#room = v; }

  status() {
    const f = this.#cfg.freeTime || {};
    return {
      running: this.#running,
      room: this.#room,
      startedAt: this.#startedAt,
      endsAt: this.#endsAt,
      remainingMs: this.#running ? Math.max(0, this.#endsAt - Date.now()) : 0,
      beats: this.#beats,
      messages: this.#messages,
      maxMessages: Number(f.maxMessages ?? 3),
      permission: f.permission || 'look',
      reason: this.#reason,
    };
  }

  /** 开一段。minutes 不传就用配置里的时长。 */
  start({ minutes } = {}) {
    const f = this.#cfg.freeTime || {};
    if (this.#running) return { ok: false, error: '已经在自由活动了', status: this.status() };
    const dur = Number(minutes) > 0 ? Number(minutes) * 60000 : Number(f.durationMs ?? 1800000);
    this.#running = true;
    this.#startedAt = Date.now();
    this.#endsAt = this.#startedAt + dur;
    this.#beats = 0;
    this.#messages = 0;
    this.#opening = true;
    this.#openingQuiet = false;
    this.#reviewed = false;
    this.#openTries = 0;
    this.#last = '';
    this.#sid = null;
    this.#reason = '';
    this.#log('free', `自由活动开始：${Math.round(dur / 60000)} 分钟，权限=${f.permission || 'look'}，最多说 ${f.maxMessages ?? 3} 句`);
    this.#schedule(2000);
    return { ok: true, status: this.status() };
  }

  stop(reason = '手动结束') {
    if (!this.#running) return { ok: false, error: '没在自由活动' };
    this.#finish(reason);
    return { ok: true, status: this.status() };
  }

  #finish(reason) {
    this.#running = false;
    this.#reason = reason;
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; }
    const secs = Math.round((Date.now() - this.#startedAt) / 1000);
    this.#log('free', `自由活动结束（${reason}）：${secs} 秒，${this.#beats} 拍，说了 ${this.#messages} 句`);
  }

  #schedule(ms) {
    if (!this.#running) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#tick(), Math.max(1000, ms));
    this.#timer.unref?.();
  }

  #tick() {
    this.#timer = null;
    if (!this.#running) return;
    if (Date.now() >= this.#endsAt) return this.#finish('时间到');
    const task = () => this.#beat().then(() => { this.#errors = 0; }).catch((e) => {
      this.#log('free', `这一拍出错：${e?.message ?? e}`);
      this.#errors = (this.#errors || 0) + 1;
      // 连着出错说明不是偶发：别一路空转，说一声、停下来
      if (this.#errors >= 3) {
        this.#errors = 0;
        this.#send('这一段好像有点问题，我先停下：' + String(e?.message ?? e).slice(0, 120)).catch(() => {});
        return this.#finish('连续出错');
      }
      this.#schedule(15000);
    });
    if (this.#queue) this.#queue.push(task, `${this.#room}::free`);
    else task();
  }

  async #beat() {
    if (!this.#running) return;

    // 他正在说话：这一拍让路。
    //
    // 起因是主人 2026-10-22 问的「你在跟我聊的时候，自由活动要不要先闭嘴」——
    // 她当时只做了"空房间别硬开口"那一半，这一半反着来：只要他刚在这个房间说过话，
    // 这一拍就不动脑子、不占额度、也不出声，等他安静下来再说。
    // 配成 0 就关掉这个让路逻辑。
    const activeMs = Number((this.#cfg.freeTime || {}).skipIfActiveMs ?? 300_000);
    if (activeMs > 0 && this.#roomState) {
      let st = {};
      try { st = this.#roomState() || {}; } catch { st = {}; }
      const lastTs = Number(st.lastTs) || 0;
      if (st.lastDir === 'in' && lastTs && Date.now() - lastTs < activeMs) {
        this.#last = '他还在说话，这一拍她让开了。';
        this.#log('free', `他 ${Math.round((Date.now() - lastTs) / 1000)} 秒前还在说话，这一拍让路`);
        this.#schedule(this.#beatMs());
        return;
      }
    }

    const f = this.#cfg.freeTime || {};
    const perm = PERM[f.permission] || PERM.look;
    const maxMsg = Number(f.maxMessages ?? 3);
    const left = Math.max(0, this.#endsAt - Date.now());

    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const quota = Math.max(0, maxMsg - this.#messages);
    const opening = this.#opening;

    const said = (() => {
      try { return String(this.#recent?.() || '').trim(); } catch { return ''; }
    })();

    // 房间里有没有人应：没人就不硬开这个口
    let quiet = null;
    if (opening && this.#roomState) {
      let st = {};
      try { st = this.#roomState() || {}; } catch { st = {}; }
      const mood = openingMood(st, { now: now.getTime() });
      if (mood.quiet) quiet = mood;
    }
    this.#openingQuiet = !!quiet;

    // 今天可以干的三件事：按"多久没做 + 做过几次 + self.md 里的轻重"挑，不随机抽
    let interestLines = null;
    try {
      const cand = this.#interests?.pick(3) || [];
      if (cand.length) {
        interestLines = [
          '你给自己列过这些想做的事，今天可以先看看这三件（挑一件，也可以一件都不挑）：',
          ...cand.map((it) => `- ${it.name}${it.count ? `（${it.idleDays} 天前做过）` : '（还没做过）'}`),
        ].join(String.fromCharCode(10));
      }
    } catch { /* 清单坏了不影响这一段 */ }

    // 快到点了就留一拍做回顾：这段是你自己的时间，翻翻刚才聊的，看有没有想记进自己那份的
    let reviewLine = null;
    if (!opening && !this.#reviewed && left <= this.#beatMs() * 1.5) {
      this.#reviewed = true;
      const drafts = (() => { try { return String(this.#drafts?.() || '').trim(); } catch { return ''; } })();
      reviewLine = [
        '【这一段快结束了】',
        '不用再找事做了。回头看看刚才这几个小时：他说过什么、你自己想过什么，有没有哪一句你想留在心里。',
        drafts ? drafts : null,
        '想记就写进去：`node scripts/self.mjs add 喜欢 "…"` / `add 讨厌 "…"` / `log "…"`（在项目根跑）；什么都不想记就回 <done/>。',
      ].filter(Boolean).join(String.fromCharCode(10));
      this.#log('free', '这一段要收尾了，留一拍做回顾');
    }

    const prompt = [
      '【自由活动】',
      `现在是 ${hhmm}，这一段还剩 ${fmtMs(left)}。`,
      `权限：${perm}`,
      said || null,
      opening
        ? (quiet
          ? `这一段刚开始，不过房间里这会儿没人：${quiet.why}。开场不用硬开——没人应的时候，一句问候也只是落在空房间里。想说话就说，不想就 <pass/>，安静地待着也算这一拍。`
          : '这一段刚开始。先主动跟他说一句话——不用等他说什么，随便一句真的想说的就行（这会儿在做什么、想到什么、或者单纯打个招呼）。这一句不算在额度里。')
        : null,
      quota > 0 ? `这段时间你还能主动说 ${quota} 句话。` : '这一段时间的话已经说完了，剩下的时间只能自己待着，不能再发消息。',
      this.#last ? `你上一拍：${this.#last}` : null,
      '',
      opening
        ? (quiet ? '想做点什么就做，不想做就安静待着。' : '想做点什么就做，不想做也可以。先把那句话说完。')
        : '你可以做点自己想做的事：看看他在干什么、翻翻文件、上网看点东西、或者什么都没必要做。',
      opening ? null : '别为了动而动。真没什么想干的，就安安静静待着一拍。',
      opening ? null : interestLines,
      opening ? null : `做完一件就记一笔：\`node scripts/interests.mjs did "名字" "这一回的感觉"\`（在 ${ROOT} 下跑）。想添新的：\`node scripts/interests.mjs add "名字" --why="为什么想"\`。`,
      opening ? null : `挑的顺序不是随机的——久没碰的排前面。清单在 \`data/interests.json\`，你自己的那份话在 \`persona/self.md\`。`,
      '',
      `想到什么值得留的，记进小本本（\`node scripts/notebook.mjs write "…"\`，在 ${ROOT} 下跑）——那是你自己的地方。`,
      reviewLine,
      '',
      PROTOCOL,
    ].filter(Boolean).join('\n');

    const t0 = Date.now();
    const r = await this.#brain.run({ prompt, sessionId: this.#sid });
    try { this.#onUsage?.(this.#room, r, 'free'); } catch { /* 记账失败不影响她说话 */ }
    if (!this.#running) return;
    if (r?.sessionId) this.#sid = r.sessionId;
    const text = String(r?.text ?? '').trim();
    this.#beats += 1;
    this.#log('free', `第 ${this.#beats} 拍 ${Date.now() - t0}ms：${text.slice(0, 60).replace(/\s+/g, ' ')}`);

    // 结束
    if (/<done\s*\/?>/i.test(text)) {
      this.#last = '她说这一段弄完了。';
      await this.#say('我先收工啦。', { free: true });
      return this.#finish('她说完了');
    }

    // 等待
    const wait = text.match(/<wait:\s*(\d+)\s*\/?>/i);
    if (wait) {
      const secs = Math.min(600, Math.max(10, Number(wait[1])));
      this.#last = `她想再等 ${secs} 秒（${text.replace(wait[0], '').trim().slice(0, 40) || '没多说'}）。`;
      // 开场那句不能省：等完了还是得说
      if (opening) this.#opening = true;
      this.#schedule(secs * 1000);
      return;
    }

    // 沉默
    if (/^<pass\s*\/?>$|^pass$/i.test(text) || !text) {
      if (opening && this.#openingQuiet) {
        // 房间里没人：不硬开这个口，也不再要一次
        this.#opening = false;
        this.#last = '房间里没人，她没开口，安静地待着。';
        this.#log('free', `开场没硬开（${quiet?.why || ''}）`);
        this.#schedule(this.#beatMs());
        return;
      }
      if (opening) {
        // 开场这一句必须发，跳过就再要一次，最多两次
        this.#openTries += 1;
        this.#last = '她想跳过开场，但这一段总得先开个口。';
        if (this.#openTries < 3) return this.#schedule(3000);
      }
      this.#last = '这一拍她什么都没做。';
      this.#schedule(this.#beatMs());
      return;
    }

    // 说话（开场那句不占额度）
    if (!opening && quota <= 0) {
      this.#last = '话已经说完了，她把想说的咽回去了。';
      this.#schedule(this.#beatMs());
      return;
    }

    const sent = await this.#say(text, { free: opening && !this.#openingQuiet });
    this.#last = sent ? `她跟他说：「${text.slice(0, 50)}」` : '她说了句，但没发出去。';
    if (sent && opening) {
      this.#opening = false;
      this.#openTries = 0;
      this.#log('free', '开场那句发出去了（不占额度）');
    }
    this.#schedule(this.#beatMs());
  }

  #beatMs() {
    const f = this.#cfg.freeTime || {};
    return Math.max(15000, Number(f.beatMs ?? 75000));
  }

  async #say(text, { free = false } = {}) {
    try {
      await this.#send(text);
      if (!free) this.#messages += 1;
      return true;
    } catch (e) {
      this.#log('free', `发不出去：${e?.message ?? e}`);
      return false;
    }
  }
}
