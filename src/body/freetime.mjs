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
  '手头正要去做什么，想让它算数（你回来它就记得）：在话后面写 `<busy:洗澡:20/>`，数字是大概几分钟。',
  '忙完了就单独回一句 `<busy:done/>`。这条只有你自己写才算数，不会被从语气里猜出来。',
  '想跟他说一句，就直接说那句话（别加引号、别解释、别写“我打算”）。',
].join('\n');

function fmtMs(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  return `${m} 分钟`;
}

/** 事件离现在多久，说人话。 */
function ago(ms) {
  const d = Math.max(0, Number(ms) || 0);
  if (d < 90_000) return '刚刚';
  if (d < 3600_000) return `${Math.max(1, Math.round(d / 60_000))} 分钟前`;
  return `${Math.round(d / 3600_000)} 小时前`;
}

// 他这一句，到底算不算"打断"。
//
// 之前一刀切：这一拍里他开口了，这句就咽回去。但两种情况下那句话其实没过期：
//   1. 他只是"嗯""继续""然后呢"——那不是新信息，是催她往下说；
//   2. 群里是别人在聊，既没 @ 她、也不是回她——跟她这句没关系。
// 只有真的"他带着新信息插进来"才值得咽。
const NUDGE = /^(嗯+|哦+|嗷+|好+|行|可以|对|是|继续|接着说|你继续|然后呢|还有呢|说下去|接着说下去|接着|继续吧|讲|说说|go\s*on|and\?*)[。！？!?.…~～\s]*$/i;

export function shouldYield(roomState = {}, { room = '' } = {}) {
  if (!roomState || roomState.lastDir !== 'in') return { yield: false, why: '他没开口' };
  const his = String(roomState.lastInText || '').replace(/\s+/g, ' ').trim();
  if (his && NUDGE.test(his)) return { yield: false, why: `他在催你继续说（「${his.slice(0, 12)}」）` };
  const isGroup = String(room).startsWith('group:');
  if (isGroup && roomState.lastInAtMe === false && roomState.lastInReplyToMe !== true) {
    return { yield: false, why: '那是别人在说话，不是在叫你' };
  }
  return { yield: true, why: `他刚开口（「${his.slice(0, 12)}」）` };
}

// 咽回去的那句，下一拍要不要还给她。
//
// 光"咽回去"不够：那句话是花了几十秒想出来的，扔掉等于白想一次；
// 而且人被打断之后是会把话接回来的，不是忘掉重来。
// 所以存成草稿，下一拍开头摆给她，让她自己判断还发不发。
//
// 返回 null 表示这拍不用提草稿。
export function draftLines(draft, roomState = null, { now = Date.now() } = {}) {
  if (!draft || !draft.text) return null;
  const left = String(draft.text).replace(/\s+/g, ' ').trim();
  if (!left) return null;
  const when = ago(now - Number(draft.at || now));
  const his = String(roomState?.lastInText || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  const sentPart = Array.isArray(draft.sentParts) && draft.sentParts.length
    ? `（前 ${draft.sentParts.length} 段已经发出去了：「${String(draft.sentParts[draft.sentParts.length - 1]).slice(0, 30)}」）`
    : '';
  return [
    `【你${when}有一句没说完】`,
    `你想说：「${left.length > 160 ? `${left.slice(0, 160)}…` : left}」${sentPart}`,
    draft.why === 'mid'
      ? '发到一半他开口了，后面那些被你咽回去了。'
      : `但就在你想着的时候他开口了${his ? `（他最后一句：「${his}」）` : ''}，那句是按他说话之前的状态想的，被你咽回去了。`,
    '现在这个才是最新的状态。还发不发？发就照原样、或者改成现在该说的样子说出来；不值得说了就回 <pass/>，这句就丢掉。',
  ].filter(Boolean).join('\n');
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
  #draft = null;       // 被咽回去的那句，下一拍还给她（不是丢掉）
  #swallowed = 0;      // 这一段咽回去过几次（太多说明拍太长）
  #swallowWhy = '';    // 最近一次为什么咽
  #thinkMs = 0;        // 这一段想事情一共花了多少毫秒
  #reviewed = false;   // 这一段有没有回顾过
  #openingQuiet = false; // 开场这一句是不是"没人也应"的，允许不回
  #onBusy = null;        // 她声明「在忙什么」时往外交（见 doing.mjs）
  #paused = false;       // 他在跟她说话，这一段的表先停住
  #pausedAt = 0;         // 从什么时候起停的
  #pausedTotal = 0;      // 这一段一共停了多久（给 status 看）

  constructor({ cfg, brain, send, logger, queue, room, recent, roomState, interests, drafts, onUsage, onBusy }) {
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
    // 她自己声明「在忙什么」时往外递（(任务, 分钟) 或 (null) 表示忙完）
    this.#onBusy = onBusy || null;
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
      paused: this.#paused,
      pausedMs: this.#pausedTotal + (this.#paused ? Date.now() - this.#pausedAt : 0),
      // 观测用：咽回去几次、平均每拍想多久——这两个数偏大就该把拍调短
      swallowed: this.#swallowed,
      swallowWhy: this.#swallowWhy,
      avgThinkMs: this.#beats ? Math.round(this.#thinkMs / this.#beats) : 0,
      draft: this.#draft ? { text: String(this.#draft.text).slice(0, 80), why: this.#draft.why, at: this.#draft.at } : null,
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
    this.#draft = null;
    this.#swallowed = 0;
    this.#swallowWhy = '';
    this.#thinkMs = 0;
    this.#paused = false;
    this.#pausedAt = 0;
    this.#pausedTotal = 0;
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
    this.#paused = false;
    this.#pausedAt = 0;
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; }
    const secs = Math.round((Date.now() - this.#startedAt) / 1000);
    const p = this.#pausedTotal ? `，中间他占用 ${Math.round(this.#pausedTotal / 1000)} 秒（已顺延）` : '';
    this.#log('free', `自由活动结束（${reason}）：${secs} 秒${p}，${this.#beats} 拍，说了 ${this.#messages} 句`);
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

    // 他在跟她私聊：这一段的表先停住。
    //
    // 以前只是"这一拍让开路"，可他要是不停地说，她的自由时间就一直在流走——
    // 聊十分钟，她那半小时就少了三分之一，而她那半小时的用处本来就是
    // 「他不在的时候她有自己的日子」。所以现在真停表，他安静下来再把时间顺延回来。
    if (this.#paused) {
      if (this.#ownerTalking()) return this.#pause();
      return this.#resume();
    }
    if (this.#ownerTalking()) return this.#pause();

    if (Date.now() >= this.#endsAt) return this.#finish('时间到');
    // 这一拍不占"说话锁"——锁只管真要发出去那一下（见 #say）。
    //
    // 以前整拍都排在锁里：这一拍想 90-150 秒，他那句话就在后面等 90-150 秒，
    // 连"在呢"都垫不出来。想事情不打扰任何人，不该让人等。
    // 会不会撞车？这一拍回来要发之前会再看一眼房间（#yieldBecause），
    // 他在这拍里说过话就咽回去，所以并发想、串行说，不会两个声音。
    this.#beat().then(() => { this.#errors = 0; }).catch((e) => {
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
  }

  /**
   * 他是不是正在这个房间说话。
   *
   * 只对私聊生效：群里的 lastDir 是"在这个群里最后说话的有人"，谁开口都算，
   * 那样她一整段都别想动。私聊里那是他一个人，才算"他在占用这段时间"。
   * 判据用 skipIfActiveMs（默认 5 分钟）：他安静满这么久才算聊完。
   */
  #ownerTalking() {
    const f = this.#cfg.freeTime || {};
    if (f.pauseWhileOwnerChats === false) return false;
    if (!String(this.#room).startsWith('private:')) return false;
    const activeMs = Number(f.skipIfActiveMs ?? 300_000);
    if (!(activeMs > 0) || !this.#roomState) return false;
    let st = {};
    try { st = this.#roomState() || {}; } catch { return false; }
    const lastTs = Number(st.lastTs) || 0;
    return st.lastDir === 'in' && lastTs > 0 && Date.now() - lastTs < activeMs;
  }

  #pause() {
    if (!this.#paused) {
      this.#paused = true;
      this.#pausedAt = Date.now();
      this.#log('free', '他在跟她说话：这一段先停表（他占的时间不算她的）');
    }
    // 每 30 秒回来看一眼他安静了没有——比拍子便宜，也别用 beatMs
    // （pauseCheckMs 只给自测用，面板不暴露）
    const f = this.#cfg.freeTime || {};
    this.#schedule(Number(f.pauseCheckMs) || Math.min(30_000, this.#beatMs()));
  }

  #resume() {
    const gap = Math.max(0, Date.now() - this.#pausedAt);
    this.#paused = false;
    this.#pausedAt = 0;
    this.#pausedTotal += gap;
    // 顺延：停表这段时间不算她的。她说"这一段多长"就该真是多长，
    // 不能因为他正好在跟她聊天，就把她自己的日子扣掉一块。
    this.#endsAt += gap;
    this.#log('free', `他安静下来了：这一段顺延 ${Math.round(gap / 1000)} 秒`);
    this.#schedule(2000);
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

    // 上一拍被咽回去的那句，摆到这一拍开头。递一次就清掉——
    // 她这回回 <pass/> 就是"这句不要了"，不该下一拍再问一遍。
    const draftBlock = draftLines(this.#draft, this.#roomState ? this.#roomState() : null);
    if (draftBlock) {
      this.#log('free', '上一拍咽回去的那句，这拍还给她了');
      this.#draft = null;
    }

    const prompt = [
      '【自由活动】',      `现在是 ${hhmm}，这一段还剩 ${fmtMs(left)}。`,
      `权限：${perm}`,
      said || null,
      opening
        ? (quiet
          ? `这一段刚开始，不过房间里这会儿没人：${quiet.why}。开场不用硬开——没人应的时候，一句问候也只是落在空房间里。想说话就说，不想就 <pass/>，安静地待着也算这一拍。`
          : '这一段刚开始。先主动跟他说一句话——不用等他说什么，随便一句真的想说的就行（这会儿在做什么、想到什么、或者单纯打个招呼）。这一句不算在额度里。')
        : null,
      quota > 0 ? `这段时间你还能主动说 ${quota} 句话。` : '这一段时间的话已经说完了，剩下的时间只能自己待着，不能再发消息。',
      this.#last ? `你上一拍：${this.#last}` : null,
      draftBlock,
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
    const beatStart = t0;
    const r = await this.#brain.run({ prompt, sessionId: this.#sid });
    try { this.#onUsage?.(this.#room, r, 'free'); } catch { /* 记账失败不影响她说话 */ }
    if (!this.#running) return;
    if (r?.sessionId) this.#sid = r.sessionId;
    let text = String(r?.text ?? '').trim();
    this.#beats += 1;
    this.#thinkMs += Date.now() - t0;

    // 她自己声明「手头在忙什么」：<busy:洗澡:20/>，或 <busy:done/> 收工。
    // 只认她写出来的这一句，不从语气里猜——猜属于「词表碰状态」，那条线不越。
    // 声明本身不算说话：剥完什么都不剩就安静接下一拍，不硬凑一句。
    let busyTask = '';
    {
      const hit = text.match(/<busy:\s*([^<>:/]{1,24})\s*(?::\s*(\d{1,3}))?\s*\/?>/i);
      if (hit) {
        busyTask = /^done$/i.test(hit[1].trim()) ? '' : hit[1].trim();
        this.#onBusy?.(busyTask || null, Number(hit[2]) || 0);
        text = text.replace(/<busy:[^<>]*>/gi, '').trim();
      }
    }
    if (!text) {
      this.#log('free', `这一拍只声明了状态：${busyTask ? `要去「${busyTask}」` : '忙完了'}`);
      this.#last = busyTask ? `你刚说要去「${busyTask}」` : '你刚忙完手头的事';
      this.#schedule(this.#beatMs());
      return;
    }

    this.#log('free', `第 ${this.#beats} 拍 ${Date.now() - t0}ms：${text.slice(0, 60).replace(/\s+/g, ' ')}`);

    // 这一拍想得久，他中途已经开口了：这句话是按开口前的状态想的，不当场发。
    //
    // 12:31:48 那次就是这么撞上的：这一拍从 12:30:16 想了一分半，中间他 12:30:42
    // 说了「今天别人下载了我的项目…」，我 12:31:48 还在说「评审那批复跑过了」，
    // 桥隔了 21 秒又回一句「丢给我嘛，我一条条对过去」——两个声音，两份状态。
    // 发之前再看一眼房间：他带着新信息插进来了，这句就按旧状态了。
    // 不是丢掉——存成草稿，下一拍开头摆回她眼前，让她自己决定还发不发。
    // （他说「嗯」「继续」这种催她的话不算打断；群里别人说话、没叫她也不算。）
    const verdict = this.#yieldBecause(beatStart);
    const isTalk = !/^(<pass\s*\/?>|pass|<wait:\s*\d+\s*\/?>|<done\s*\/?>)$/i.test(text);

    // 结束
    //
    // 她回 <done/> 就是"这段到此为止"，别再自作主张补一句"我先收工啦"——
    // 每一段都以同一句话结尾，比不说话更像机器。只有她自己在 <done/>
    // 前后真说了什么（比如"我去睡了"），才把那句发出去；他刚好在说话就也不发。
    if (/<done\s*\/?>/i.test(text)) {
      const said = text.replace(/<done\s*\/?>/gi, '').trim();
      if (!said) {
        this.#last = '她说这一段弄完了（没说话，安静结束）。';
        return this.#finish('她说完了');
      }
      if (verdict.yield) {
        this.#last = `她想说「${said.slice(0, 40)}」再收工，但他刚开口，这句不发了。`;
        this.#log('free', `收工那句不发了：${verdict.why}`);
        return this.#finish('她说完了');
      }
      this.#last = `她说完了：${said.slice(0, 60)}`;
      await this.#say(said, { free: true });
      return this.#finish('她说完了');
    }

    if (isTalk && verdict.yield) {
      this.#draft = { text, why: 'turn', at: Date.now(), sentParts: [] };
      this.#swallowed += 1;
      this.#swallowWhy = verdict.why;
      this.#last = `他刚好在这一拍里带着新话进来了（${verdict.why}），这句按旧状态想的，咽回去了（下拍看还发不发）。`;
      this.#log('free', `这句不发：${verdict.why}`);
      this.#schedule(this.#beatMs());
      return;
    }
    if (isTalk && !verdict.yield && verdict.why && this.#himSpokeSince(beatStart)) {
      this.#log('free', `他这会儿也说话了，但${verdict.why}——照发`);
    }

    // 结束
    if (/<done\s*\/?>/i.test(text)) {
      this.#last = '她说这一段弄完了（没说话）。';
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

    const sent = await this.#say(text, {
      free: opening && !this.#openingQuiet,
      // 分几条发的时候，中间那几秒里他可能插话——每发下一条之前再问一次。
      // 同样按"算不算打断"判：他只是在催，就继续说下去。
      guard: () => !this.#yieldBecause(beatStart).yield,
    });
    if (sent?.yielded) {
      // 排到说话锁了才发现他插过话：跟"想完就发现"一样处理——咽回去，存草稿。
      const why = this.#yieldBecause(beatStart).why || '他中途开口了';
      this.#draft = { text, why: 'turn', at: Date.now(), sentParts: [] };
      this.#swallowed += 1;
      this.#swallowWhy = why;
      this.#last = `排到说话锁的这会儿他带着新话进来了（${why}），这句咽回去了（下拍看还发不发）。`;
      this.#log('free', `排队时他插话，这句不发：${why}`);
      this.#schedule(this.#beatMs());
      return;
    }
    if (sent?.aborted) {
      const why = this.#yieldBecause(beatStart).why || '他中途开口了';
      this.#swallowed += 1;
      this.#swallowWhy = why;
      this.#last = `发到一半他带着新话进来了（${why}），剩下的几句没发（下拍看还接不接）。`;
      this.#log('free', `发到第 ${sent.sentParts.length} 段他插话（${why}），后面咽回去`);
    } else {
      this.#last = sent ? `她跟他说：「${text.slice(0, 50)}」` : '她说了句，但没发出去。';
    }
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

  /** 从 ts 到现在，他有没有在这个房间里开过口。 */
  #himSpokeSince(ts) {
    if (!this.#roomState) return false;
    try {
      const st = this.#roomState() || {};
      // 用 >= 不用 >：同一毫秒里发生的算"赶上了"。
      // 宁可多咽一句（草稿还留着，下拍会摆回眼前），也别把一句按旧状态想的话发出去。
      return st.lastDir === 'in' && Number(st.lastTs || 0) >= Number(ts || 0);
    } catch {
      return false;
    }
  }

  /** 他这一拍里说的话，算不算"打断"（要不要因此咽回这句）。 */
  #yieldBecause(ts) {
    if (!this.#himSpokeSince(ts)) return { yield: false, why: '' };
    try {
      return shouldYield(this.#roomState() || {}, { room: this.#room });
    } catch {
      return { yield: true, why: '他开口了' }; // 判断不了就保守：宁可咽
    }
  }

  /**
   * 说一句。
   *
   * guard：分条发送时，每条之间再确认一次"还要不要发"。返回 false 就停，
   * 已经发出去的那几段会留在返回值里（sentParts），剩下的存成草稿。
   */
  async #say(text, { free = false, guard = null } = {}) {
    const opts = {};
    if (guard) opts.shouldContinue = guard;
    const doSend = async () => {
      // 排到锁了才真发。等锁的这段时间里他可能已经插话了，
      // 所以在这儿再问一次 guard —— 该咽就咽，别把按旧状态想的话发出去。
      if (guard && !guard()) return { yielded: true };
      await this.#send(text, opts);
      return { aborted: !!opts.aborted };
    };
    // 发出去这一下才排队：保证"一个我一次只说一句"。
    // 排在前面的是他的一句话（前景优先），那就等这一轮说完再说——反正
    // 等的时候 guard 还会再问一次"他刚才是不是插话了"，该咽就咽。
    let out;
    try {
      out = this.#queue
        ? await this.#queue.push(doSend, `${this.#room}::say`)
        : await doSend();
    } catch (e) {
      this.#log('free', `发不出去：${e?.message ?? e}`);
      return null;
    }
    // 队列吞掉异常时给的是 undefined：跟"没发出去"一样处理
    if (!out) {
      this.#log('free', '发不出去（队列没返回结果）');
      return null;
    }
    if (out.yielded) return { yielded: true };
    if (out.aborted) {
      if (!free) this.#messages += 1; // 说出去了半句，也算说过
      this.#draft = { text, why: 'mid', at: Date.now(), sentParts: opts.sentParts || [] };
      return { aborted: true, sentParts: opts.sentParts || [] };
    }
    if (!free) this.#messages += 1;
    return { aborted: false, sentParts: [text] };
  }
}
