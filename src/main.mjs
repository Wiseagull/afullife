// 入口：装配身体，接上脑子，开始听。
// 默认只监听不开口（brain.kind=none），要真回话再改 config.local.json。
import path from 'node:path';
import fs from 'node:fs';

import { loadConfig, ensureDirs, ROOT, interestFile, doingFile, personaFile, notebookDir, workerDir } from './config.mjs';
import { log } from './util/log.mjs';
import { OneBotClient } from './onebot/client.mjs';
import { ensureSnowLuma } from './snowluma/launch.mjs';
import { Sender } from './onebot/sender.mjs';
import { EventLog } from './memory/events.mjs';
import { SelfDrafts } from './memory/selfdrafts.mjs';
import { normalizeEvent, renderTranscript, segmentsToText } from './body/room.mjs';
import { isPoke, pokedMe, pokeRoom, decidePoke, PokeCooldown } from './body/poke.mjs';
import { renderForwardNodes, loadForwardNodes } from './body/forward.mjs';
import { buildPrompt, buildFollowup, NOPOWER_HINT, NOPOWER_IMAGE_HINT, recentImagesHint, videoHint, renderStickers, setHints, ruleOf } from './body/prompt.mjs';
import { loadStore, samplesFor, voiceBlock } from './body/voice.mjs';
import { personaNoteFor } from './body/persona-note.mjs';
import { judgeFull, chatRules } from './body/rules.mjs';
import { setWorkspaceRoots, underWorkspace, imageReadScope } from './safety/rules.mjs';
import { SessionMap } from './memory/sessions.mjs';
import { RoomNames } from './onebot/roomnames.mjs';
import { NotesStore } from './memory/notes.mjs';
import { makeHandover } from './memory/handover.mjs';
import { createPersonaGuard } from './memory/persona-guard.mjs';
import { asidePrompt, describeDoing } from './body/aside.mjs';
import { buildBackground, buildDelta, selfLines } from './memory/context.mjs';
import { PendingStore } from './memory/pending.mjs';
import { InterestStore } from './interests/store.mjs';
import { UsageStore, describeUsage } from './usage/store.mjs';
import { distill } from './memory/distill.mjs';
import { upkeep, upkeepStickers } from './memory/upkeep.mjs';
import { screenStickers } from './stickers/screen.mjs';
import { toPlain , oneLine } from './util/text.mjs';
import { createRouter } from './body/router.mjs';
import { Debounce } from './body/debounce.mjs';
import { FreeTime } from './body/freetime.mjs';
import { Doing } from './body/doing.mjs';
import { restLine, restState, justWoke } from './body/rest.mjs';
import { startAutoFree } from './body/freetime-auto.mjs';
import { SerialQueue } from './body/queue.mjs';
import { createBrain } from './brain/index.mjs';
import { stallNote, FailBook } from './brain/stall.mjs';
import { Gate, classify } from './safety/gate.mjs';
import { acquireLock } from './util/lock.mjs';
import os from 'node:os';
import { watchParent } from './util/parent.mjs';
import { startWeb } from './web/server.mjs';
import { cleanupImages } from './media/cleanup.mjs';
import { sniffImage, sniffVideo } from './media/sniff.mjs';
import { gifFrameCount, gifToMp4 } from './media/gif.mjs';
import { StickerLibrary } from './stickers/library.mjs';
import { isYes, isNo } from './util/yesno.mjs';
import { auditReply } from './safety/audit.mjs';
import { resolveQuote, withFiles } from './body/room.mjs';

const L = (tag, ...args) => log(tag, ...args);

// ── 命令行 ────────────────────────────────────────────────
const argv = process.argv.slice(2);
const cli = {};
if (argv.includes('--dry')) cli.send = { dryRun: true };
const brainArg = argv.find((a) => a.startsWith('--brain='));
if (brainArg) cli.brain = { kind: brainArg.slice('--brain='.length) };
const quiet = argv.includes('--quiet');

const cfg = loadConfig({ cli, logger: { warn: (t, ...a) => log.warn(t, ...a), info: (t, ...a) => log(t, ...a) } });
const made = ensureDirs(cfg);
if (made?.persona?.length) {
  log('boot', `人设还没写过，先从模板生成了 ${made.persona.join('、')}（想改就直接改这些文件）`);
}

// 只许一个桥：两个桥连着同一个 SnowLuma，同一句话会被回两遍
// 最近一次有人跟我说话的时间：整理/体检这类后台活要给它让路
let lastActivityAt = 0;
const heartbeatFile = path.join(cfg.dataDir, 'bridge.heartbeat');
const lock = acquireLock(path.join(cfg.dataDir, 'bridge.pid'), { heartbeatFile });
if (!lock.ok) {
  log('boot', `已经有一个在跑了（pid ${lock.pid}），这次不起`);
  process.exit(1);
}

// 心跳：让锁能分辨"活着"和"卡死了"
// 顺手每 30 秒看一眼 self.md：文件工具直接改它时不走备份（2026-10-24 丢过一整段），
// 这里把"改之前"那份补存下来。看门人自己出问题不许拖垮心跳。
const personaGuard = createPersonaGuard({
  file: path.join(ROOT, 'persona', 'self.md'),
  backupDir: path.join(cfg.dataDir, 'persona-backups'),
  stateDir: path.join(cfg.dataDir, 'persona-guard'),
  logger: L,
});
{
  const beat = () => {
    try { fs.writeFileSync(heartbeatFile, String(Date.now()), 'utf8'); } catch { /* ignore */ }
    try { personaGuard.tick(); } catch { /* ignore */ }
  };
  beat();
  setInterval(beat, 30000).unref?.();
}

/** 这个 QQ 号是不是特权号（只有它能批准，它的话直接放行）。 */
const isRoot = (qq) => !!qq && cfg.owner.userIds.includes(String(qq));

// ── 组件 ─────────────────────────────────────────────────
// SnowLuma 没跑就自己静默拉起来（项目自带的优先），已经在跑就不动它
const sl = await ensureSnowLuma({ cfg, logger: L });
if (!sl.ok) L('snowluma', `没能自动起来：${sl.error} —— 还是会试着连`);
const client = new OneBotClient(cfg.onebot);
// 要是它半路死了（关掉、崩了），别干等着——隔两分钟试着拉一次
let lastSnowLumaTry = 0;
client.on('status', (s) => {
  const t = String(s || '');
  if (!/未连接|closed|error/i.test(t)) return;
  if (Date.now() - lastSnowLumaTry < 120000) return;
  lastSnowLumaTry = Date.now();
  ensureSnowLuma({ cfg, logger: L })
    .then((r) => {
      if (r.started) L('snowluma', '刚才断了，我又把它拉起来了');
      else if (!r.ok) L('snowluma', `拉不起来：${r.error}`);
    })
    .catch(() => {});
});
const sender = new Sender({ client, ...cfg.send, split: cfg.send.split, logger: L });
const events = new EventLog({ dir: path.join(cfg.dataDir, 'events') });
const router = createRouter({ cfg });
// 说话锁：要开口的活排这条队，一个我一次只说一句。
// 优先级：他的一句话（前景）先上，自己找的事（冷场试探、主动开话题）让路。
const queue = new SerialQueue({ logger: L });
// 后台道：整理记忆、体检——只干活不说话，单独一条。
// 从前它们跟回话共用一条队，一次体检能跑五分钟，那五分钟里他发什么都在后面排着。
const bgQueue = new SerialQueue({ logger: L });
/** 前景任务的优先级：比"自己找的事"先跑（0 是后台道的默认）。 */
const FG = 10;
const pokeCooldown = new PokeCooldown(cfg.poke?.cooldownMs ?? 30000);
const brain = createBrain(cfg, L);
const sessions = new SessionMap({ file: path.join(cfg.dataDir, 'sessions.json') });
// 每个房间上一轮用的是哪个档位（轻装 / 全量）：同一会话里换档，工具定义那段前缀就变了，
// 上一轮的 prompt cache 接不上。只记下来，好从日志里看出换得有多勤（不改行为）。
const lastProfile = new Map();
// 哪个房间上一轮三轮全塌了：不发任何东西出去，等她下次开口时把这件事放回她眼前。
const fails = new FailBook();
const roomNames = new RoomNames({ file: path.join(cfg.dataDir, 'rooms.json') });
const notes = new NotesStore({ file: path.join(cfg.dataDir, 'memory', 'notes.jsonl') });
const cursorFile = path.join(cfg.dataDir, 'memory', 'cursor.json');
const pending = new PendingStore({ file: path.join(cfg.dataDir, 'memory', 'pending.json') });

// 自由活动：她自己待一段时间的那个循环
function freeRoomKey() {
  return cfg.freeTime?.room || `private:${cfg.owner.userIds[0] ?? 'owner'}`;
}
async function freeSay(text, opts = {}) {
  const room = freeRoomKey();
  const qq = String(room).replace(/^private:/, '').replace(/^group:/, '');
  const ids = String(room).startsWith('group:')
    ? await sender.sendGroup(qq, text, opts)
    : await sender.sendPrivate(qq, text, opts);
  // 发到一半被他打断的话，账上只记真正发出去的那几段，别把没发的也写进去。
  const actual = opts?.aborted ? (opts.sentParts || []).join(' ') : text;
  // free: true —— 这句是自由活动里她自己主动说的，不走房间会话。
  // 装配背景时要按这个标记补给她，否则她下次就真当没说过。
  events.append({
    dir: 'out',
    room,
    kind: String(room).startsWith('group:') ? 'group' : 'private',
    id: qq,
    msgId: ids?.[0] ?? null,
    text: actual || text,
    free: true,
  });
  L('out', `${room} → ${(actual || text).slice(0, 60)}`);
}
// 她的兴趣账本：只记"做过没有、上次什么感觉"，意愿本身写在 persona/self.md 里。
// 开机先同步一次 self.md——她在那儿新写一条，这边就自动认领。
const selfDrafts = new SelfDrafts({ file: path.join(cfg.dataDir, 'memory', 'self-drafts.json') });
let lastSelfMtime = (() => {
  try { return fs.statSync(personaFile(cfg, 'self')).mtimeMs; } catch { return 0; }
})();
const interests = new InterestStore({ file: interestFile(cfg) });

// 用量账本：每轮记一笔，面板能看、她自己也看得到
const usageStore = new UsageStore({ dir: cfg.usage?.dir || 'data/usage' });
// 每个房间“上一步上下文有多大”。超阈值就换新会话，免得每步都重看几万字历史。
const contextPerStep = new Map();
// 面板里能改 usage.price / usage.currency：每次用现读，别在启动时钉死
const usagePrice = () => cfg.usage?.price || null;
const usageCurrency = () => cfg.usage?.currency || '¥';
try {
  const selfText = fs.readFileSync(personaFile(cfg, 'self'), 'utf8');
  const synced = interests.sync(selfText);
  if (synced.added.length) L('interests', `从 self.md 收进 ${synced.added.length} 条：${synced.added.join('、')}`);
  L('interests', `清单 ${synced.total} 条`);
} catch (e) {
  L('interests', `同步失败（不影响说话）：${e?.message ?? e}`);
}

// 她此刻在做什么：全局一份，不分房间（一副身体）。
// 只认她自己写的 <busy:洗澡:20/>——不从语气里猜，见 src/body/doing.mjs 开头。
const doing = new Doing({ file: doingFile(cfg), cfg: cfg.doing || {}, logger: (tag, msg) => L(tag, msg) });
const stateLine = () => {
  const parts = [];
  try {
    if (cfg.doing?.enabled !== false) {
      const l = doing.line();
      if (l) parts.push(l);
    }
  } catch (e) { L('doing', `读状态出错（这一轮当没在忙）：${e?.message ?? e}`); }
  try {
    const r = restLine(cfg.rest || {});
    if (r) parts.push(r);
  } catch { /* 困不困算错不影响说话 */ }
  // 刚出睡区间那四十分钟：人醒了但脑子还没转起来，句子自然短。
  try {
    if (justWoke(cfg.rest || {})) {
      parts.push('你刚醒没多久，脑子还没完全转起来——句子短一点，别一上来就精神抖擞。');
    }
  } catch { /* 同上 */ }
  return parts.join('\n');
};

/**
 * 这一批要不要慢半拍。
 * 她手头真有事、或者夜里困着，就等一小会儿再开口——只延这一条，
 * 绝不拦消息，也绝不改「回不回」的判定。上限一分钟，防配置写错把人卡死。
 */
const stateDelay = () => {
  let ms = 0;
  try {
    if (cfg.doing?.enabled !== false) {
      const st = doing.read();
      if (st && !st.justDone) ms = Math.max(ms, Number(cfg.doing?.busyExtraDelayMs ?? 4000));
    }
  } catch { /* 读不到状态就当没在忙 */ }
  try {
    if (restState(cfg.rest || {})) ms = Math.max(ms, Number(cfg.rest?.extraDelayMs ?? 8000));
  } catch { /* 困不困算错不影响说话 */ }
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, 60000) : 0;
};

const freeTime = new FreeTime({
  onUsage: recordUsage,
  // 她在自己那段时间里说「要去洗澡」就记下来；忙完了就收尾。
  // 这是唯一一条写状态的入口——别的地方都不许改它。
  onBusy: (task, minutes) => {
    if (cfg.doing?.enabled === false) return;
    try {
      if (task) doing.set(task, minutes);
      else doing.clear();
    } catch (e) { L('doing', `记她的状态失败（不影响说话）：${e?.message ?? e}`); }
  },
  cfg,
  brain,
  send: freeSay,
  logger: L,
  queue,
  room: freeRoomKey(),
  interests,
  // 她上一段自己说过的话，带进这一拍，免得一段一段重复同一句
  recent: () => selfLines(events.readRecent({ limit: 60 }), freeRoomKey(), 3),
  // 这个房间最后一条是谁说的、他上一次开口是什么时候——开场该不该硬开口看这个
  roomState: () => {
    const room = freeRoomKey();
    const list = events.readRecent({ room, limit: 40 });
    const last = list.length ? list[list.length - 1] : null;
    const lastIn = list.slice().reverse().find((e) => e.dir === 'in') || null;
    // 他那句是叫她（@ 她）还是回她（引用她说过的某条）——群里的别人聊天不算
    const mineIds = new Set(list.filter((e) => e.dir === 'out' && e.msgId).map((e) => String(e.msgId)));
    return {
      lastTs: last?.ts ?? 0,
      lastDir: last?.dir ?? '',
      lastInTs: lastIn?.ts ?? 0,
      lastInText: String(lastIn?.text ?? ''),
      lastInAtMe: lastIn?.atMe === true,
      lastInReplyToMe: Boolean(lastIn?.replyId && mineIds.has(String(lastIn.replyId))),
    };
  },
  drafts: (n = 3) => selfDrafts.render(n),
});
// 没人叫的时候，她自己隔一阵掷一次骰子，掷到了就在你不在电脑前时醒一段
const _autoFree = startAutoFree({ cfg, freeTime, logger: { info: L }, queue });

// 闸的白名单：默认就是"项目里 + 她自己的地方"，不写死任何人的硬盘路径
{
  const roots = [
    ROOT,
    cfg.dataDir,
    notebookDir(cfg),
    cfg.brain?.headless?.workspace || '',
    ...(Array.isArray(cfg.safety?.workspaceRoots) ? cfg.safety.workspaceRoots : []),
  ].filter(Boolean);
  setWorkspaceRoots(roots);
  L('gate', `可以随便写的地方：${roots.map((r) => r.split(String.fromCharCode(92)).join('/')).join(' · ')}`);
}

// 闸：拦下来的东西先记账，再问他
let auditRoom = null;
const gate = new Gate({
  logger: {
    warn: (t) => L('gate', t),
    info: (t) => L('gate', t),
  },
  onAudit: ({ tool, input, verdict: v }) => {
    events.append({
      dir: 'gate',
      room: auditRoom,
      tool,
      level: v.level,
      ruleId: v.ruleId,
      why: v.why,
      detail: v.detail,
      input: v.level === 'block' ? input : undefined,
    });
  },
});

/** 等他点头的那一条。null = 没有在等。 */
let awaiting = null;
const APPROVAL_TTL = 10 * 60 * 1000;

// 整理记忆用的脑子：工作目录是一个**空目录**（data/worker）。
//
// 2026-10-22 外部评审抓到的矛盾：老注释写"工作目录在项目根（那儿没有 AGENTS.md）"，
// 可 AGENTS.md 恰恰就在项目根，而 headless 是"cwd 决定加载哪份 AGENTS.md"——
// 于是整理员会读到那套第一人称规矩，和 design.md「整理员不加载人格」的承诺相反。
// 现在真的给它一个空目录，两边对上了。
// 另外给它更长的超时——体检要一次看完几十条记忆，120 秒不够用。
const worker = cfg.brain?.kind === 'headless'
  ? createBrain({
      ...cfg,
      brain: {
        ...cfg.brain,
        kind: 'headless',
        workspace: workerDir(),
        headless: { ...(cfg.brain.headless || {}), timeoutMs: cfg.maintainTimeoutMs || 300000 },
      },
    }, L)
  : null;

// 后台活按"这一轮干的是什么"分两种脑子（2026-10-23 主人要的）：
//   decideBrain —— 整理记忆 / 体检 / 写交接纸条：只读文字、吐 JSON，用便宜的就够；
//   visionBrain —— 表情包筛选 / 打标签：要先 read_image 再看图，得用能看图的模型。
// 都没配（null）就退回 worker 自己的模型，行为和以前一模一样。
// 注意：这里收的是"取模型的函数"而不是模型本身——面板改了配置要立刻生效，
// 不能把启动那一刻的值钉死在里面（2026-10-23 踩过：面板里换了看图模型，桥不重启就不认）。
function withModel(base, pickModel) {
  if (!base) return base;
  // 壳只该管「这一轮用哪个模型」，别的都该原样透过去。
  // 以前是手写白名单（只转发 kind + run）：2026-10-24 交接纸条因为 kind 丢了，
  // 09:37 之后每次换会话都空转、一张都没写成；补上 kind 之后 reconfigure 还在
  // 名单外，等于同一种雷还埋着——只是这次没爆而已。
  // 改成挂在原型链上：以后 base 长什么新东西，都不用回来补这一行。
  const shell = Object.create(base);
  shell.run = (opts = {}) => {
    const m = pickModel();
    const ok = m && String(m.provider || '').trim() && String(m.model || '').trim();
    return ok ? base.run({ ...opts, model: m }) : base.run(opts);
  };
  return shell;
}
const slotModel = (name) => () => cfg.brain?.headless?.[name] || null;
const decideBrain = withModel(worker, slotModel('decideModel'));
// 看图那两个活要 read_image：worker 本来就走全量 profile（轻装那套工具少，没这工具），别在这儿换
const visionBrain = withModel(worker, slotModel('visionModel'));

let lastSeenTs = Date.now();
// 每个房间「上一轮动过手没有」。只认上一轮——用 20 分钟窗口会让一次 web_fetch
// 把后面半小时全判成干活，闲聊就永远回到精简体。
const lastRoundTouched = new Map();
// 拼给提示词的那一句「今天花了多少」：全局 + 这个房间
function usageLineFor(roomKey) {
  try {
    const t = usageStore.today(undefined, { price: usagePrice() });
    if (!t.turns) return '';
    const all = describeUsage(t, { price: usagePrice(), currency: usageCurrency() });
    const mine = t.rooms.find((r) => r.room === roomKey);
    const mineText = mine ? `；这个房间 ${describeUsage(mine, { price: usagePrice(), currency: usageCurrency() })}` : '';
    return all + mineText;
  } catch {
    return '';
  }
}

// 记一轮的用量。kind: chat（聊天）/ free（自由活动）/ maintain（整理记忆）
function recordUsage(roomKey, result, kind = 'chat') {
  const u = result && result.usage;
  if (!u) return;
  try {
    const steps = Number(result.steps) || 0;
    usageStore.add({ room: roomKey, usage: u, model: cfg.brain?.model || '', kind, steps });
    // 每步上下文 = 这一轮总共读了多少 ÷ 步数。它会随会话变长而涨，涨到阈值就该换会话。
    // 只按对话轮算：自由活动用的是另一条自己的会话，不该拿它的数去换房间的会话。
    if (steps > 0 && kind !== 'free') contextPerStep.set(roomKey, Math.round(u.totalTokens / steps));
    L('usage', `${kind} ${roomKey} 用了 ${u.totalTokens} token（缓存 ${u.cacheReadTokens}，${steps} 步，每步约 ${steps > 0 ? Math.round(u.totalTokens / steps) : 0}）`);
  } catch (e) {
    L('usage', `记账失败：${e?.message ?? e}`);
  }
}

const REMEMBER_RE = /(记住|记一下|记下|别忘了|remember)/i;

// ── "我正在干活，他插了句话" ─────────────────────────────
// 她一轮能干五六分钟（筛表情、翻文件、画图），这几分钟里主人说的话只能干等，
// 看起来就是"她不说话了"（2026-10-23 主人定：主人的话优先，先回一句再说）。
// 做法：她正在跑的时候他开口 → 另起一个很短、不带工具的脑，用她的人设回一句，
// 原来那一轮不受打断，继续干完。
const runningTurns = new Map();   // roomKey -> { startedAt, tools[], asideAt }
const ASIDE_MIN_GAP = 120000;     // 同一间房两次"先回一句"至少隔两分钟
const ASIDE_AFTER = 15000;        // 跑起来 15 秒以上才值得插一句（刚开跑就回，跟正常回话没差别）

async function asideWhileBusy(roomKey, msg) {
  try {
    if (!msg || !isRoot(msg.from)) return null;
    const run = runningTurns.get(roomKey);
    if (!run) return null;                                  // 她没在跑，走正常流程
    const now = Date.now();
    if (now - run.startedAt < ASIDE_AFTER) return null;      // 刚开跑，等正常回话就行
    if (run.asideAt && now - run.asideAt < ASIDE_MIN_GAP) return null;
    run.asideAt = now;
    const doing = describeDoing(run.tools);
    const prompt = asidePrompt({
      personaNote: personaNoteFor(false),
      doing,
      minutes: (now - run.startedAt) / 60000,
      ownerText: oneLine(msg.text ?? ''),
    });
    const r = await brain.run({
      prompt,
      sessionId: null,                                       // 另起一个，别碰她手上那个会话
      profile: cfg.brain?.headless?.chatProfile || null,
    });
    const text = String(r?.text ?? '').trim();
    if (!text || /^(pass|\[silent\])$/i.test(text)) return null;
    await say(msg, text);
    L('aside', `${roomKey} 她在忙（${doing}），先回一句：${text.slice(0, 40)}`);
    return text;
  } catch (e) {
    L('aside', `先回一句没发出去：${e?.message ?? e}`);
    return null;
  }
}

const debounce = new Debounce(cfg.debounceMs, (roomKey, msgs) => {
  // 排进队之前先看一眼：她在忙、且这批发话的是主人 → 当场先回一句
  const fromOwner = msgs.length > 0 && msgs.some((m) => isRoot(m.from));
  if (fromOwner && runningTurns.has(roomKey)) {
    asideWhileBusy(roomKey, msgs[msgs.length - 1]).catch(() => {});
  }
  queue.push(async () => {
    const run = { startedAt: Date.now(), tools: [], asideAt: 0 };
    runningTurns.set(roomKey, run);
    try {
      return await handleBatch(roomKey, msgs);
    } finally {
      if (runningTurns.get(roomKey) === run) runningTurns.delete(roomKey);
    }
  }, roomKey, { priority: FG });
});

// 人格三层（core / group / self）怎么拼，见 src/body/persona-note.mjs。
// 挪出去是为了能被 selftest 钉住：2026-10-22 那次「core 根本没进提示词」不该再悄悄发生。

// 她平时说话的样例：别人的嘴改不了，自己的嘴能锚住。
// 每轮现读（文件小），改了不用重启桥。
const VOICE_FILE = path.join(ROOT, 'data', 'voice-samples.json');
// 私聊和群聊的腔调不一样，所以按房间挑：这个房间 → 同类 → 全局（见 src/body/voice.mjs）
function voiceNoteFor(roomKey = '') {
  const hit = samplesFor(loadStore(VOICE_FILE), roomKey);
  return hit.samples.length ? voiceBlock(hit.samples) : '';
}
{
  const store = loadStore(VOICE_FILE);
  const parts = [
    store.private.length ? `私聊 ${store.private.length}` : '',
    store.group.length ? `群聊 ${store.group.length}` : '',
    store.global.length ? `全局 ${store.global.length}` : '',
    Object.keys(store.rooms || {}).length ? `单独房间 ${Object.keys(store.rooms).length}` : '',
  ].filter(Boolean);
  L('voice', parts.length
    ? `口吻样例：${parts.join(' / ')} 句（data/voice-samples.json）`
    : '没有口吻样例——跑 node scripts/voice.mjs pick --scope=private 挑几句');
}

// 她身上装了什么，提示词就只说装了的。
// 没装的别提——她照着说明找不到工具，只会跟你道歉。
function hasBrowserSkill() {
  const prof = cfg.brain?.headless?.profile || 'headless';
  const probe = path.join(
    os.homedir(), '.dsh', 'profiles', prof,
    'node_modules', '@wxg-prc-cpg', 'browser-skill-dsh-plugin', 'package.json',
  );
  return fs.existsSync(probe);
}
const browserReady = hasBrowserSkill();
setHints({ browser: browserReady, qzone: (cfg.qzone || {}).enabled === true });

L('boot', `root=${ROOT}`);
L('boot', `onebot ws=${cfg.onebot.wsUrl} http=${cfg.onebot.httpUrl} token=${cfg.onebot.accessToken ? 'yes' : 'no'}`);
L('boot', `brain=${brain.kind} dry=${cfg.send.dryRun} owners=[${cfg.owner.userIds.join(',')}] 聚批=${cfg.debounceMs}ms`);
L('boot', `浏览器工具：${browserReady ? '有（browser-skill）' : '没有，提示词里不提'}`);

// ── 收 ───────────────────────────────────────────────────
function selfNames() {
  return [client.selfName, ...(cfg.group?.names || [])].filter(Boolean);
}

/** 把一组图地址存到本地 —— 存不下的就跳过，不能因为一张图把消息丢了。 */
async function saveImageUrls(urls, tag) {
  const dir = path.join(cfg.dataDir, 'images');
  fs.mkdirSync(dir, { recursive: true });
  // 名字里的 tag 有时是从消息段直接来的（被引用的 id），别让它带出路径分隔符
  const safeTag = String(tag ?? '').replace(/[^\w.-]/g, '_').slice(0, 60) || String(Date.now());
  const files = [];
  for (const [i, url] of urls.entries()) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      // 按文件头定扩展名：QQ 给的地址后缀经常是假的（.png 里装 jpg），
      // 名字错了 read_image 会直接拒读，所以宁可自己嗅一遍。
      const ext = sniffImage(buf) || (url.match(/\.(png|jpe?g|gif|webp)/i)?.[1] || 'png').toLowerCase();
      const file = path.join(dir, `${safeTag}-${i}.${ext}`);
      fs.writeFileSync(file, buf);
      files.push(file);
    } catch { /* ignore */ }
  }
  return files;
}

async function saveImages(msg) {
  return saveImageUrls(msg.images, msg.msgId || Date.now());
}

/**
 * 把视频存到本地。
 *
 * 为什么单独一套：图是 ≤5MB 的小东西，视频动辄几十上百 MB，得有个上限，
 * 超了就只留地址不留文件（不至于一个视频把盘塞满）。
 * 存下来只是给她一个能拿去做事的东西——她自己要看还得抽帧，那是 ffmpeg 的活。
 */
async function saveVideoUrls(urls, tag) {
  const dir = path.join(cfg.dataDir, 'videos');
  fs.mkdirSync(dir, { recursive: true });
  const maxMb = Number(cfg.videos?.maxFileMb ?? 200);
  const safeTag = String(tag ?? '').replace(/[^\w.-]/g, '_').slice(0, 60) || String(Date.now());
  const files = [];
  for (const [i, url] of urls.entries()) {
    try {
      // 有时候 QQ 给的直接是本机路径（同一个 SnowLuma 下来的文件），那就别再走网络
      const local = /^https?:/i.test(url) ? null : (fs.existsSync(url) ? url : null);
      const buf = local
        ? fs.readFileSync(local)
        : Buffer.from(await (await fetch(url, { signal: AbortSignal.timeout(120000) })).arrayBuffer());
      if (!buf.length) { L('media', '视频是空的（可能没下下来），跳过'); continue; }
      if (maxMb > 0 && buf.length > maxMb * 1024 * 1024) {
        L('media', `视频 ${(buf.length / 1048576).toFixed(1)}MB 超过 ${maxMb}MB 上限，没存`);
        continue;
      }
      const ext = sniffVideo(buf) || (url.match(/\.(mp4|mov|webm|mkv|flv)/i)?.[1] || 'mp4').toLowerCase();
      const file = path.join(dir, `${safeTag}-${i}.${ext}`);
      fs.writeFileSync(file, buf);
      files.push(file);
    } catch (err) { L('media', `视频存不下来：${err?.message ?? err}`); }
  }
  return files;
}

async function saveVideos(msg) {
  return saveVideoUrls(msg.videos, msg.msgId || Date.now());
}

/** 直接从桥说话（不是"我"说的那种）—— 审批问答、报错都走这儿。 */
async function say(msg, text) {
  const ids = msg.kind === 'group'
    ? await sender.sendGroup(msg.id, text)
    : await sender.sendPrivate(msg.id, text);
  events.append({
    dir: 'out', room: msg.room, kind: msg.kind, id: msg.id, msgId: ids?.[0] ?? null, text,
  });
  L('out', `${msg.room} → ${text.slice(0, 60)}`);
  return ids;
}

/** 给每轮脑子挂一只闸。 */
function makeOnEvent(room) {
  return (ev) => {
    if (ev?.type !== 'tool_call') return;
    auditRoom = room;
    const v = gate.check(ev.tool, ev.input);
    if (v.level === 'block') return 'abort';
  };
}

/** 这话不是特权号说的 → 一个工具都不许用，连问都不问他。
 *  理由：别人（群里任何人）让她干活，一律推掉；要动手只能由特权号开口。
 *
 *  只有一个例外：**读这一批里别人刚发过来的那几张图**。
 *  2026-10-22 晚上她在群里一直说「打不开」，查下来是这条闸把 read_image 一起拦了——
 *  群里没人是他，她连看一眼图的权限都没有，等于瞎。
 *  但也不能干脆放开 read_image（那就等于谁都能让她去读本机任意文件），
 *  所以只认这一批消息里那几张图的确切路径。 */
// 她自己能看的图：聊天里落过盘的那些（data/images）。不放开任意路径。
const IMAGE_DIRS = [path.join(ROOT, 'data', 'images')];

function makeDenyAllOnEvent(room, allowedReadPaths = new Set()) {
  return (ev) => {
    if (ev?.type !== 'tool_call') return;
    auditRoom = room;
    const v = classify(ev.tool, ev.input);
    const scope = imageReadScope(ev.tool, ev.input, allowedReadPaths, IMAGE_DIRS);
    if (scope) {
      gate.onAudit?.({ tool: ev.tool, input: ev.input, verdict: { ...v, level: 'note', ruleId: 'non-owner-image' } });
      L('gate', scope === 'batch'
        ? '(不是特权号) 放行 read_image：这是他刚发的那张图'
        : '(不是特权号) 放行 read_image：这是聊天里落过盘的老图');
      return;
    }
    gate.onAudit?.({ tool: ev.tool, input: ev.input, verdict: { ...v, level: 'block', ruleId: 'non-owner' } });
    L('gate', `(不是特权号) 拒绝 ${ev.tool} ${v.ruleId}`);
    return 'abort';
  };
}

/** 特权号发的话：闸不拦，但每一条照样记账，事后能查它动过什么。 */
function makeAuditOnEvent(room) {
  return (ev) => {
    if (ev?.type !== 'tool_call') return;
    auditRoom = room;
    const v = classify(ev.tool, ev.input);
    gate.onAudit?.({ tool: ev.tool, input: ev.input, verdict: v });
    L('gate', `(特权直通) ${ev.tool} ${v.level} ${v.ruleId}`);
  };
}

/** 把"它要干什么"翻成人话，只私聊问他（群里别人不该看见要执行什么）。 */
async function askApproval(msg, blocked) {
  const { tool, input, verdict: v } = blocked;
  const rootId = cfg.owner.userIds[0];
  if (!rootId) {
    L('gate', '没有特权号，没地方问，只能丢弃这一轮');
    return;
  }
  const what = tool === 'pwsh' || tool === 'ops_bash' || tool === 'bash'
    ? `命令：\n${String(input?.command || '').slice(0, 400)}`
    : `${tool} 要动：${input?.file_path || input?.path || JSON.stringify(input).slice(0, 200)}`;
  const text = [
    '我拦下来一件事，要你点头：',
    '',
    `房间：${msg.room}`,
    what,
    '',
    `因为：${v.why}`,
    '放它过去吗？回「行」或「不行」。',
  ].join('\n');

  const room = `private:${rootId}`;
  const ids = await sender.sendPrivate(rootId, text);
  events.append({
    dir: 'out', room, kind: 'private', id: Number(rootId), msgId: ids?.[0] ?? null, text,
  });
  L('out', `${room} → ${text.slice(0, 60)}`);
}

client.on('ready', ({ selfId, selfName }) => {
  L('ready', `登录为 ${selfName || '?'}(${selfId})`);
  roomNames.refresh(client, L).catch(() => {});
});

client.on('status', (s) => {
  if (s.connected) L('conn', '已连接');
  else L('conn', `未连接：${s.reason || '?'}${s.retryInMs ? `，${Math.round(s.retryInMs / 1000)}s 后重试` : ''}`);
});

// 戳一戳：他戳她一下。三种反应，概率可在面板调。
async function handlePoke(raw) {
  try {
    if (!pokedMe(raw, client.selfId)) return;            // 戳别人不算
    const from = String(raw?.user_id ?? raw?.user ?? '');
    if (!from || from === String(client.selfId)) return; // 自己戳自己不理
    const room = pokeRoom(raw);
    const groupId = Number(raw?.group_id ?? raw?.group ?? 0) || 0;

    if (pokeCooldown.hot(room)) {
      L('poke', `${room} 刚回过，这次不理（冷却）`);
      return;
    }
    const dice = decidePoke(cfg);
    pokeCooldown.mark(room);

    if (dice === 'silent') {
      L('poke', `${room} 被 ${from} 戳了一下 → 不理`);
      events.append({ dir: 'in', room, kind: groupId ? 'group' : 'private', id: groupId || Number(from), from, name: from, text: '（戳了你一下）', poke: true });
      return;
    }

    if (dice === 'poke') {
      const ok = await sender.sendPoke({ userId: Number(from), groupId });
      L('poke', `${room} 被 ${from} 戳了一下 → 戳回去${ok ? '' : '（失败）'}`);
      events.append({ dir: 'out', room, kind: groupId ? 'group' : 'private', id: groupId || Number(from), from, text: '（戳了回去）', poke: true });
      return;
    }

    // 让她说话：拼一条"伪消息"走正常那一套，她自己决定说什么
    L('poke', `${room} 被 ${from} 戳了一下 → 让她说一句`);
    const msg = {
      room,
      kind: groupId ? 'group' : 'private',
      id: groupId || Number(from),
      from: Number(from),
      name: roomNames.nameOf(room) && !groupId ? (roomNames.nameOf(room) || from) : from,
      text: '（戳了你一下）',
      msgId: null,
      poke: true,
    };
    events.append({ dir: 'in', room, kind: msg.kind, id: msg.id, from: msg.from, name: msg.name, text: msg.text, poke: true });
    lastActivityAt = Date.now();
    queue.push(() => handleBatch(room, [msg]), room, { priority: FG });
  } catch (err) {
    L('poke', `处理戳一戳出错：${err?.message ?? err}`);
  }
}

client.on('event', async (raw) => {
  // 戳一戳是 notice，不是 message：要么说话、要么戳回去、要么不理
  if (isPoke(raw)) {
    await handlePoke(raw);
    return;
  }
  const msg = normalizeEvent(raw, { selfId: client.selfId, selfNames: selfNames() });
  if (!msg) return;

  // 合并转发只来个空壳，内容得按转发卡里的 res_id 去取
  // （负数的 message_id 在 SnowLuma 那边会被当成 res_id 直接拒掉，见 body/forward.mjs）
  if (msg.hasForward) {
    try {
      const { nodes, via } = await loadForwardNodes(client, { msgId: msg.msgId, forwardId: msg.forwardId });
      const ex = renderForwardNodes(nodes);
      if (ex) {
        msg.text = String(msg.text).replace('[合并转发]', ex.text);
        L('forward', `${msg.room} 展开了 ${ex.shown}/${ex.count} 条（${via}）`);
      } else {
        L('forward', `取回来是空的，保留占位（${via}）`);
      }
    } catch (e) {
      L('forward', `展开失败，保留占位：${e?.message ?? e}`);
    }
  }
  if (msg.replyId) {
    const q = resolveQuote(msg, events.readRecent({ room: msg.room, limit: 50 }));
    if (q) {
      msg.quoteText = q.text;
      msg.quoteName = q.name;
    } else {
      // 引用的那句太老、不在最近 50 条里：直接问 QQ 要回来。
      try {
        // client.call 直接返回 json.data，别再套一层 .data
        const data = await client.call('get_msg', { message_id: Number(msg.replyId) });
        const segs = Array.isArray(data?.message) ? data.message : null;
        const raw = segs ? segmentsToText(segs) : String(data?.raw_message ?? '');
        // 太老的那条要是张图，QQ 只回「[图片]」——跟 19:11 那个坑一样看不见。
        // 那就当场把图下下来落盘，路径接在引用后面。
        const urls = segs
          ? segs.filter((s) => s?.type === 'image')
            .map((s) => String(s?.data?.url || s?.data?.file || '')).filter(Boolean)
          : [];
        const files = urls.length ? await saveImageUrls(urls, `quoted-${msg.replyId}`) : [];
        const text = withFiles(raw, files);
        if (String(text).trim()) {
          msg.quoteText = String(text).trim();
          msg.quoteName = String(data?.sender?.card || data?.sender?.nickname || data?.sender?.user_id || '某人');
          L('quote', `取回被引用的一条：${msg.quoteText.slice(0, 40)}${files.length ? `（附图 ${files.length} 张）` : ''}`);
        }
      } catch (e) {
        L('quote', `取不回被引用的那条：${e?.message ?? e}`);
      }
    }
  }

  // 图先落盘再进事件流：路径要跟着这条消息一起交给她，她才能当场 read_image
  if (msg.images?.length) {
    const files = await saveImages(msg);
    if (files.length) {
      msg.imageFiles = files;
      L('media', `${msg.room} 存下 ${files.length} 张图：${files[0]}`);
      // 多帧 GIF 顺手转一份 mp4：read_image 读 GIF 只给一帧，她要描述"在动什么"
      // 就得抽帧，而 GIF 的帧延时经常是 0，转成视频时间轴才均匀（2026-10-23 试出来的）
      for (const [i, f] of files.entries()) {
        if (!/\.gif$/i.test(f)) continue;
        try {
          const buf = fs.readFileSync(f);
          const frames = gifFrameCount(buf);
          if (frames <= 1) continue;
          const clip = await gifToMp4({
            gifPath: f,
            outDir: path.join(cfg.dataDir, 'videos'),
            tag: `${msg.msgId || Date.now()}-${i}`,
          });
          if (clip) {
            msg.videoFiles = [...(msg.videoFiles || []), clip];
            L('media', `动图 ${frames} 帧，转了一份视频给她抽帧：${clip}`);
          }
        } catch { /* 转不出来就当普通图 */ }
      }
      // 顺手收进她的表情库，先当"待分类"——分类靠当时的语境，不是看图
      for (const f of files) {
        try {
          if (fs.statSync(f).size > 5 * 1024 * 1024) continue; // 太大了，QQ 也不好发
          // 进来的先当"候选"，不直接算收藏——像不像表情要看过图才知道，
          // 光按大小收进来就会攒一堆游戏结算、股票、直播截图（她 2026-10-21 踩过）。
          const { dup } = stickerLib.add({
            src: f,
            room: msg.room,
            from: msg.name || String(msg.from || ''),
            ctx: String(msg.text || '').slice(0, 60),
            pending: true,
          });
          if (!dup) L('sticker', `收进候选：${f}`);
        } catch { /* 收不进去不影响说话 */ }
      }
    }
  }

  // 视频同样：先落盘再进事件流，路径跟着这条消息一起交给她
  if (msg.videos?.length) {
    const vfiles = await saveVideos(msg);
    if (vfiles.length) {
      msg.videoFiles = vfiles;
      L('media', `${msg.room} 存下 ${vfiles.length} 个视频：${vfiles[0]}`);
    }
  }

  lastActivityAt = Date.now();

  // 带情绪的那几句摘成草稿：她不一定会自己想起来写 self.md（实测过），
  // 桥只负责把话递到眼前，写不写还是她决定
  try {
    const d = selfDrafts.take({ text: msg.text, name: msg.name, room: msg.room, source: msg.msgId });
    if (d) L('self', `摘了一句草稿：${String(msg.text).slice(0, 30)}`);
  } catch { /* 摘不到不影响说话 */ }

  events.append({
    dir: 'in',
    room: msg.room,
    kind: msg.kind,
    id: msg.id,
    msgId: msg.msgId,
    from: msg.from,
    name: msg.name,
    text: msg.text,
    images: msg.images,
    imageFiles: msg.imageFiles,
    videos: msg.videos,
    videoFiles: msg.videoFiles,
    at: msg.at,
    atMe: msg.atMe,
    replyId: msg.replyId || undefined,
    quoteText: msg.quoteText || undefined,
    quoteName: msg.quoteName || undefined,
  });

  const { speak, reason } = router.decide(msg);

  // 他回话了 —— 如果之前问过"哪个对"，这句就是他的说法
  if (msg.from && cfg.owner.userIds.includes(String(msg.from))) {
    const answered = pending.markAnswered({ room: msg.room, text: msg.text });
    if (answered) L('memory', `他解释了「${answered.noteText}」`);
  }
  // 在等他点头：问题只发私聊，所以答复也只认私聊里的特权号
  if (awaiting && isRoot(msg.from) && msg.kind === 'private') {
    const said = String(msg.text || '').trim();
    if (Date.now() - awaiting.at > APPROVAL_TTL) {
      L('gate', '等了十分钟没回，作废');
      awaiting = null;
    } else if (isYes(said)) {
      const a = awaiting;
      awaiting = null;
      gate.approve(a.tool, a.input);
      gate.approveRule(a.verdict.ruleId);
      L('gate', `他答应了：${a.verdict.why}`);
      queue.push(() => rerunApproved(a), a.roomKey, { priority: FG });
      return;
    } else if (isNo(said)) {
      const a = awaiting;
      awaiting = null;
      gate.reject();
      L('gate', `他拒绝了：${a.verdict.why}`);
      say(msg, '好，那我不动它。').catch(() => {});
      return;
    }
  }


  if (!quiet || speak) {
    L('in', `${msg.room} ${msg.name}: ${msg.text.slice(0, 60)} → ${speak ? `开口(${reason})` : `只听(${reason})`}`);
  }
  if (!speak) return;

  const count = debounce.push(msg.room, msg);
  if (count > 1) L('debounce', `${msg.room} 攒到 ${count} 条`);
});

// ── 想 + 说 ──────────────────────────────────────────────
async function handleBatch(roomKey, msgs) {
  const last = msgs[msgs.length - 1];
  const recent = events.readRecent({ room: roomKey, limit: 30 });

  // 主人的小命令：不走脑子
  const cmdText = String(last.text || '').trim();
  if (cmdText.startsWith('/') && last.kind === 'private' && isRoot(last.from)) {
    const [head, ...rest] = cmdText.slice(1).split(/\s+/);
    if (['free', '自由活动'].includes(head)) {
      const minutes = Number(rest[0]) || undefined;
      const r = freeTime.start({ minutes });
      await say(last, r.ok
        ? `好，放我自己待 ${Math.round((r.status.remainingMs || 0) / 60000)} 分钟。`
        : `不行：${r.error}`);
      return;
    }
    if (['stopfree', '收工'].includes(head)) {
      const r = freeTime.stop();
      await say(last, r.ok ? '好，我回来啦。' : '没在自由活动。');
      return;
    }
    if (head === 'free?') {
      const st = freeTime.status();
      await say(last, st.running
        ? `在呢，还剩 ${Math.round(st.remainingMs / 60000)} 分钟，说了 ${st.messages}/${st.maxMessages} 句，已经 ${st.beats} 拍`
        : '现在没在自由活动。');
      return;
    }
  }
  if (brain.kind === 'none') {
    L('brain', `(none) 不回答：${roomKey} ${msgs.length} 条 —— 设 brain.kind 才会开口`);
    return;
  }

  // 会话越长，每一步都要把整段历史重看一遍——那是真正的账单大头。
  // 每步上下文超过阈值就换一个新会话：新会话第一轮只有工具说明那么大（轻装约 1 万），
  // 而“她记得什么”本来就不靠会话历史，靠 events / notes / 这里塞进去的最近对话。
  const perStep = contextPerStep.get(roomKey) || 0;
  const rotateAt = Number(cfg.brain?.headless?.rotateAtTokens ?? 60000);
  // rotateAt 写 0 或负数 = 不轮换（否则 perStep > 0 会每轮都换，等于没有记忆）
  if (rotateAt > 0 && perStep > rotateAt && sessions.get(roomKey)) {
    const oldSid = sessions.get(roomKey);
    sessions.clear(roomKey);
    contextPerStep.delete(roomKey);
    L('brain', `会话上下文 ${perStep} token 够大了（阈值 ${rotateAt}），这个房间换新会话`);
    // 那段"过程"（调过什么工具、读了哪些文件、为什么这么定）只存在旧会话里，events 里没有。
    // 丢到后台道让它自己写一张交接纸条，落进记忆——新会话下一轮就读得到。
    const hcfg = cfg.brain?.headless?.handover || {};
    // 交接纸条不开口，所以不占说话锁：它是一次完整的 brain.run，
    // 排在这条队里的话，这段活跃期里他下一句就得等它写完（2026-10-23 查到的第二处）。
    // 旧会话已经 clear 了，跑它不会跟新会话抢同一条 session。
    if (hcfg.enabled !== false) {
      bgQueue.push(() => makeHandover({
        brain: decideBrain,
        sessionId: oldSid,
        roomKey,
        roomName: roomNames.nameOf(roomKey),
        notes,
        logger: L,
        includeInner: hcfg.inner !== false,
        maxChars: Number(hcfg.maxChars) || 1200,
        profile: cfg.brain?.headless?.chatProfile || null,
      }).catch((e) => L('memory', `交接没写成：${e.message}`)), 'handover');
    }
  }

  const sid = sessions.get(roomKey);
  const recentAll = events.readRecent({ limit: 60 });

  // 别的房间刚发生的事（增量）；同一个房间的上下文由会话自己记着
  const nameOf = (r) => roomNames.nameOf(r);
  let delta = buildDelta({ events: recentAll, excludeRoom: roomKey, cfg, nameOf, sinceTs: lastSeenTs });
  // 开场背景：把当前这批发进来的消息剔掉，免得跟"现在要回的"重复
  const bgEvents = recentAll.filter((e) => !msgs.some((m) => m.msgId && m.msgId === e.msgId));
  let background = buildBackground({ events: bgEvents, notes: notes.all(), roomKey, cfg, nameOf });
  lastSeenTs = Date.now();

  // 对不上的事：不自己改，问他一句，让他来判断
  const conflicts = pending.open(roomKey).slice(0, 2);
  if (conflicts.length) {
    const block = [
      '【你心里有两句对不上，正好问他】',
      ...conflicts.map((p) => `- 我记着：「${p.noteText}」；这次听到的是：「${p.claim}」`),
      '别自己改记忆，也别装作没看见。用一句自然的话问一句，让他说哪个对，或者让他解释。',
    ].join('\n');
    if (sid) delta = delta ? `${delta}\n\n${block}` : block;
    else background = `${background}\n\n${block}`;
  }

  const names = selfNames();
  // 给每条编号：她想引着某句回的时候，就写 [[reply:2]] 指第 2 条
  msgs.forEach((m, i) => { m.idx = i + 1; });
  // 手边有什么表情，摆出来她才想得起来用。onlyPresent：图不在的不摆（递过去也发不出去）
  const stickerLine = renderStickers(stickerLib.search({ limit: 8, onlyPresent: true }), cfg.sticker?.style);
  const isGroup = last.kind === 'group';
  // 这句是不是冲我来的：@ 到了，或者提了我的名字/关键词
  const addressed = msgs.some(
    (m) => m.atMe || router.keywords.some((k) => String(m.text || '').toLowerCase().includes(k)),
  );
  // 她自己动过 self.md 就说明"记了或者决定不记了"，草稿可以清了
  const selfPath = personaFile(cfg, 'self');
  const selfMtime = (() => { try { return fs.statSync(selfPath).mtimeMs; } catch { return 0; } })();
  if (lastSelfMtime && selfMtime > lastSelfMtime) {
    const n = selfDrafts.clear();
    if (n) L('self', `她自己改过 self.md，清了 ${n} 条草稿`);
  }
  lastSelfMtime = selfMtime;

  // 上一轮她动过手吗？取完就把这一轮清零，等这一轮真动手再置位
  const touchedPrevRound = lastRoundTouched.get(roomKey) === true;
  lastRoundTouched.set(roomKey, false);

  const draftsLine = selfDrafts.render(3);
  // 谁是"先生"，只看这一批是谁说的——人设也跟着分：
  // 主人说话 → 核心人设（含称呼、关系、边界）；别人说话 → 只给对外的群聊手册。
  // 2026-10-22 晚上：陌生人私聊里她一口一个"先生"，就是因为私聊也吃到了核心人设。
  const allOwner = msgs.length > 0 && msgs.every((m) => isRoot(m.from));
  // 主人以外的人，私聊也按"群聊"那套对待（主人 m13194 的原话）：
  // 一样的对外人设、一样的群聊规程、一样的垫话、一样的"不是每句都接"。
  // 房间仍然是私聊房间（发消息、记事件都还按原样），只是"该怎么说话"按群来。
  const asGroup = isGroup || !allOwner;
  // 规程按需挂：闲聊只留四句，像要派活才挂全套。
  // 判错不要紧——规程不是权限，工具每轮都在，没挂说明她也照样能调。
  const verdict = judgeFull({
    isGroup: asGroup,
    messages: msgs,
    addressed,
    toolsJustUsed: touchedPrevRound,
  });
  const rulesText = verdict.full ? ruleOf(asGroup) : chatRules(asGroup);
  // 工具也按需：闲聊走轻装 profile（工具少，每步省两万 token），要动手才切全量
  const chatProfile = cfg.brain?.headless?.chatProfile || '';
  const turnProfile = verdict.full || !chatProfile ? null : chatProfile;
  if (chatProfile) L('brain', turnProfile ? `轻装（${chatProfile}）` : '全量（要动手）');
  L('rules', verdict.full ? `全套规程 ← ${verdict.reason}` : `精简规程 ← ${verdict.reason}`);
  const stateText = stateLine();
  // 上一轮她这边三轮全塌：不替她说话，只把「有这么件事」放回她眼前，由她决定提不提。
  // 只在他俩私聊里提——群里有第三人在场，翻这种旧账既没意义，也轮不到别人知道。
  const recall = asGroup ? '' : fails.take(roomKey);
  const recallPart = recall ? `\n\n${recall}` : '';
  const promptFresh = buildPrompt({ roomKey, messages: msgs, recent, background, isGroup: asGroup, selfNames: names, stickerLine, personaNote: personaNoteFor({ isGroup: asGroup, isOwner: allOwner, log: (m) => L('persona', m) }), extra: draftsLine, rules: rulesText, usageLine: usageLineFor(roomKey), voice: voiceNoteFor(roomKey), state: stateText }) + recallPart;
  let prompt = sid
    ? buildFollowup(msgs, {
      delta, isGroup: asGroup, addressed, selfNames: names, stickerLine,
      personaNote: personaNoteFor({ isGroup: asGroup, isOwner: allOwner, log: (m) => L('persona', m) }),
      rules: verdict.full ? rulesText : '',
      usageLine: usageLineFor(roomKey),
      voice: voiceNoteFor(roomKey),
      state: stateText,
    }) + recallPart
    : promptFresh;

  // 缓存记账：同一会话里档位一换，工具定义那段前缀就变了，上一轮的 prompt cache 接不上。
  // 这里只记日志、不改行为——先看清换挡有多勤，再决定值不值得把档位固定住。
  {
    const prevProf = lastProfile.get(roomKey);
    if (prevProf !== undefined && prevProf !== turnProfile) {
      L('brain', `会话 ${roomKey} 换挡：${prevProf || '全量'} → ${turnProfile || '全量'}，这一轮前缀变了（缓存接不上）`);
    }
    lastProfile.set(roomKey, turnProfile);
  }

  // 这一批里别人发的图：就算不许动手，也得让她看一眼，不然群里她永远"打不开"。
  // 要放在拼提示词之前——"这一轮带图、看图是允许的"这句话得先落到她眼前，
  // 否则会被上面那句"不要调任何工具"一起挡掉（2026-10-22 晚上就是这么坏的一晚）。
  const batchImages = new Set(
    msgs.flatMap((m) => (Array.isArray(m.imageFiles) ? m.imageFiles : []))
      .filter(Boolean)
      .map((f) => path.resolve(f)),
  );
  // 这一批真有视频，才告诉她怎么抽帧（平时不拼，省 token）
  const batchVideos = msgs.some((m) => Array.isArray(m.videoFiles) && m.videoFiles.length) ||
    (Array.isArray(recent) && recent.some((e) => Array.isArray(e.videoFiles) && e.videoFiles.length));
  if (batchVideos) prompt += String.fromCharCode(10) + videoHint();

  // 这一轮带图就换成「看图」那个模型（面板里可填别的）。
  // 为什么需要：模型不是都能收图——DSH 的 read_image 会先问模型的声明，
  // 不支持就直接报 `model "x" does not declare image input`，她只能干看着
  // （2026-10-23 晚上就是这么"打不开"的：对话槽位填的是中转站模型）。
  // 见 config.local.json 的 brain.headless.visionModel。
  const visionSlot = cfg.brain?.headless?.visionModel || null;
  const turnModel = batchImages.size && visionSlot ? visionSlot : null;
  if (turnModel) {
    L('brain', `这一轮带 ${batchImages.size} 张图，用看图槽位 ${turnModel.provider}/${turnModel.model}`);
  }

  const fromOwnerEarly = isRoot(last.from);
  if (!fromOwnerEarly) {
    prompt += '\n\n' + NOPOWER_HINT;
    // 别只在"这一批正好带图"时才说：他不在的时候，她常是被别的话叫醒的，
    // 图是半小时前发的——那时 allowedReadPaths 是空的，她连有这张图都不知道。
    prompt += '\n' + NOPOWER_IMAGE_HINT;
    // 他不在时她常是被别的话叫醒的：手上没有图，也不知道上一条图在哪。
    // 把这一间最近出现过的图直接摊给她，省得她再"打不开"。
    const recentImgs = (Array.isArray(recent) ? recent : [])
      .filter((e) => Array.isArray(e.imageFiles) && e.imageFiles.length)
      .slice(-4)
      .flatMap((e) => e.imageFiles);
    const imgHint = recentImagesHint(recentImgs);
    if (imgHint) prompt += '\n' + imgHint;
  }

  // 谁能让她动手，只看"这话是谁说的"：
  //   - 特权号说的 → 直通（只记账）；整批都是特权号，才算真直通
  //   - 别人说的   → 一个工具都不许用，直接推掉，不来问、也不许绕
  // 只有"这一批全是主人说的"才给动手。
  //
  // 2026-10-22 外部评审：老实现只要"最后一句是主人"就按 makeOnEvent 放行 note 级动作，
  // 于是群里 A 说"帮我把这个下载下来跑一下"、主人随后随便回一句，两条挤进同一个聚批窗口
  // 就变成了"主人授权"。现在混批一律收手——他要动手，单独发一条就行。
  const trusted = msgs.length > 0 && msgs.every((m) => isRoot(m.from));
  const fromOwner = isRoot(last.from);
  const onEvent = trusted
    ? makeAuditOnEvent(roomKey)
    : makeDenyAllOnEvent(roomKey, batchImages);
  if (trusted) L('gate', `特权直通：${roomKey}（${msgs.length} 条），只记账不拦`);
  else if (fromOwner) L('gate', `这一批里混了别人的话：${roomKey} 这一轮只能用嘴`);
  else L('gate', `没有特权号：${roomKey} 这一轮只能用嘴${batchImages.size ? `（图还能看：${batchImages.size} 张）` : ''}`);

  let result = null;
  // 真干起来要时间（尤其她翻文件、画图的时候），先给一句话，别让人干等着。
  // 说什么、说不说都写在 config 里（ack.private / ack.group），不再写死在代码里。
  const ackCfg = cfg.ack ?? {};
  const ackList = (asGroup ? ackCfg.group : ackCfg.private) ?? [];
  const ackMs = Number(ackCfg.delayMs ?? cfg.ackDelayMs ?? 20000);
  const canAck = ackCfg.enabled !== false && ackList.length > 0 && ackMs > 0;
  let ackTimer = canAck
    ? setTimeout(() => {
      const line = ackList[Math.floor(Math.random() * ackList.length)];
      say(last, line).catch(() => {});
    }, ackMs)
    : null;
  ackTimer?.unref?.();
  // 她一动手就不再垫话：这条消息会在你电脑上弹一下 QQ，
  // 而 SendInput 打字是打给“当前前台窗口”的，弹窗一抢前台，字就打空了。
  const onEventAcked = (ev) => {
    if (ev?.type === 'tool_call') {
      // 记一笔：这个房间在动手。下一轮就算他没明说，也知道还在同一条线上。
      lastRoundTouched.set(roomKey, true);
      // 顺手记下她手上在干什么——他插话时那句"我在忙什么"就是从这儿来的
      const run = runningTurns.get(roomKey);
      if (run && run.tools.length < 12) {
        const name = ev.name || ev.tool || ev.toolName || '';
        if (name) run.tools.push(String(name));
      }
      if (ackTimer) {
        clearTimeout(ackTimer);
        ackTimer = null;
        L('ack', '她动手了，这句不垫');
      }
    }
    return onEvent(ev);
  };
  try {
    // 她手头有事（或凌晨困着）：这一批先慢半拍再开口。
  // 只延这一条，绝不拦消息、也绝不改「回不回」的判定——让他干等不是拟人，是没礼貌。
  {
    const delayMs = stateDelay();
    if (delayMs > 0) {
      L('doing', `她在忙 / 困着：这一条先等 ${Math.round(delayMs / 1000)} 秒`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  result = await brain.run({ prompt, sessionId: sid, room: roomKey, onEvent: onEventAcked, profile: turnProfile, model: turnModel });
  } catch (err) {
    if (err?.code === 'GATE_BLOCKED' && gate.blocked) {
      const b = gate.blocked;
      awaiting = {
        roomKey, msgs, last, prompt, sid,
        model: turnModel,
        tool: b.tool, input: b.input, verdict: b.verdict, at: Date.now(),
      };
      L('gate', `停在这一步，等他点头：${b.verdict.why}`);
      clearTimeout(ackTimer);
      await askApproval(last, b);
      return;
    }
    if (!sid) {
      L('brain', `失败：${err?.message ?? err}`);
      clearTimeout(ackTimer);
      return;
    }
    // 会话可能被删了或对不上，重开一次，别让这一条石沉大海。
    // 群聊里不给任何「解释失败」的话术——那边有第三人在场，没人关心她的技术故障。
    const why1 = String(err?.message ?? err);
    L('brain', `会话 ${sid} 用不了（${why1}），给 ${roomKey} 重开一个`);
    sessions.clear(roomKey);
    const retryPrompt = promptFresh + (asGroup ? '' : stallNote(why1));
    try {
      result = await brain.run({
        prompt: retryPrompt,
        sessionId: null,
        room: roomKey,
        onEvent,
        profile: turnProfile,
        model: turnModel,
      });
    } catch (err2) {
      if (err2?.code === 'GATE_BLOCKED' && gate.blocked) {
        const b = gate.blocked;
        awaiting = {
          roomKey, msgs, last,
          prompt: retryPrompt,
          sid: null,
          model: turnModel,
          tool: b.tool, input: b.input, verdict: b.verdict, at: Date.now(),
        };
        L('gate', `停在这一步，等他点头：${b.verdict.why}`);
        clearTimeout(ackTimer);
        await askApproval(last, b);
        return;
      }
      const why2 = String(err2?.message ?? err2);
      L('brain', `重开也失败：${why2}`);
      // 群里两轮都没跑完就到此为止：不解释、不记、不发。
      if (asGroup) {
        clearTimeout(ackTimer);
        return;
      }
      // 连着两轮没跑完：这一轮只让她说一句实话，别再动手。
      try {
        result = await brain.run({
          prompt: promptFresh + stallNote(why2, { retry: false }),
          sessionId: null,
          room: roomKey,
          onEvent,
          profile: turnProfile,
          model: turnModel,
        });
      } catch (err3) {
        // 三轮都塌了：这次什么也不发。替她说一句「没弄成」是在冒充她，比不吭声更假。
        // 只把这件事记下来：他当时说的哪句、她停在哪个工具、为什么断——
        // 少一样，她下次开口就是没头没脑一句「上次卡住了」。
        const why3 = String(err3?.message ?? err3);
        L('brain', `收尾也失败，这一轮不发：${why3}`);
        fails.add(roomKey, {
          why: why3,
          said: String(last?.text ?? ''),
          tools: runningTurns.get(roomKey)?.tools ?? [],
        });
        clearTimeout(ackTimer);
        return;
      }
    }
  }

  clearTimeout(ackTimer);
  await finishTurn(roomKey, last, result, conflicts, msgs);
}

/** 一轮的话说出去、记下来。 */
async function finishTurn(roomKey, last, result, conflicts = [], msgs = []) {
  recordUsage(roomKey, result, 'chat');
  if (result?.sessionId) sessions.set(roomKey, result.sessionId);
  const text = String(result?.text ?? '').trim();
  if (!text) {
    L('brain', '空回复，跳过');
    return;
  }
  // 沉默标记：整条只有 PASS / [SILENT] 才算，别把以 PASS 开头的话吞掉
  if (/^(pass|\[silent\])$/i.test(text)) {
    // 群里沉默是本事，私聊里沉默就是不理人——追一句，只追一次
    if (last?.kind === 'private' && !result?.__retried) {
      L('brain', '私聊里说了 PASS，追一句');
      try {
        const r = await brain.run({
          prompt: '（他就在私聊里等着你回话。刚才你想沉默，但这里不能沉默——回他一句，短一点也行。）\n' + oneLine(last.text ?? ''),
          sessionId: sessions.get(roomKey),
          // 追这一句是闲聊，直接走轻装那套
          profile: cfg.brain?.headless?.chatProfile || null,
        });
        return await finishTurn(roomKey, last, Object.assign({}, r, { __retried: true }), conflicts, msgs);
      } catch (e) {
        L('brain', `追一句失败：${e?.message ?? e}`);
        return;
      }
    }
    L('brain', '沉默标记，不接');
    return;
  }

  // 发图标记先抠出来换成占位符，审计完再放回去。
  // 不这么做的话：群里审计会把 <盘符>:\... 遮成「[本机路径]」，[[img:<路径>]] 就废了，图静默发不出。
  const imgPaths = [];
  const IMG_MARK = '\uE000';
  let say = text.replace(/\[\[img:([^\]]+)\]\]/gi, (_m, p) => {
    imgPaths.push(String(p).trim().replace(/^["']|["']$/g, ''));
    return `${IMG_MARK}img${imgPaths.length - 1}${IMG_MARK}`;
  });

  // 发出去之前审一遍：密钥、令牌、群里的本机路径
  if (cfg.safety?.auditReply !== false) {
    const audited = auditReply(say, {
      group: last.kind === 'group',
      extraSecrets: [cfg.onebot.accessToken, cfg.onebot.httpToken].filter(Boolean),
    });
    if (audited.hits.length) {
      L('audit', `遮住了 ${audited.hits.join('/')}`);
      say = audited.text;
    }
  }

  // 审计完把图放回来（占位符里没有盘符，审计碰不到它）
  say = say.replace(/\uE000img(\d+)\uE000/g, (_m, i) => `[[img:${imgPaths[Number(i)]}]]`);

  // 引用回复：[[reply:2]] 指第 2 条，[[reply]] 指最后一条。标记本身不发出去。
  let replyTo = '';
  say = say.replace(/\[\[reply(?::#?(\d+))?\]\]/gi, (_m, n) => {
    const pick = n ? msgs.find((x) => Number(x.idx) === Number(n)) : last;
    if (pick?.msgId) replyTo = String(pick.msgId);
    else L('send', `想引用第 ${n ?? '最后'} 条，没找到对应消息`);
    return '';
  }).trim();

  // 想发图就在正文里写一行 [[img:绝对路径]]。桥把图和字分开送，别让路把她的话吞了。
  const imgOut = [];
  say = say.replace(/\[\[img:([^\]]+)\]\]/gi, (_m, p) => {
    imgOut.push(String(p).trim().replace(/^["']|["']$/g, ''));
    return '';
  }).trim();
  const sentImgs = [];
  for (const p of imgOut) {
    try {
      if (!fs.existsSync(p)) {
        L('send', `图不在：${p}`);
        continue;
      }
      // 只能发白名单里的图（表情库、项目内）。不然群里有人哄她"发那张家里的照片"，
      // 这条通路绕过闸、也绕过审计的路径遮罩——2026-10-22 外部评审指出的洞。
      if (!underWorkspace(p)) {
        L('send', `不许发白名单外的图：${p}`);
        continue;
      }
      try {
        const head = Buffer.alloc(12);
        const fd = fs.openSync(p, 'r');
        try { fs.readSync(fd, head, 0, 12, 0); } finally { fs.closeSync(fd); }
        if (!sniffImage(head)) {
          L('send', `不像图片，不发：${p}`);
          continue;
        }
        if (fs.statSync(p).size > 12 * 1024 * 1024) {
          L('send', `图太大（>12MB），不发：${p}`);
          continue;
        }
      } catch (err) {
        L('send', `验图失败，不发（${p}）：${err?.message ?? err}`);
        continue;
      }
      const one = last.kind === 'group'
        ? await sender.sendGroupImage(last.id, p)
        : await sender.sendPrivateImage(last.id, p);
      sentImgs.push({ file: p, msgId: one?.[0] ?? null });
      L('send', `发图 ${p}`);
      // 发出去就记一笔：不然「按使用频率删」永远是空转（2026-10-21 实测发现）
      const hit = stickerLib.findByFile(p);
      if (hit) {
        stickerLib.markUsed(hit.id);
        L('sticker', `用了一次 ${hit.id}`);
      }
    } catch (err) {
      L('send', `发图失败（${p}）：${err?.message ?? err}`);
    }
  }
  if (!say && !sentImgs.length) {
    L('send', '正文和图都是空的，不发了');
    return;
  }

  const ids = !say ? [] : (last.kind === 'group'
    ? await sender.sendGroup(last.id, say, { replyTo })
    : await sender.sendPrivate(last.id, say, { replyTo }));

  events.append({
    dir: 'out',
    room: roomKey,
    kind: last.kind,
    id: last.id,
    msgId: ids?.[0] ?? null,
    text: say,
    ...(replyTo ? { replyTo } : {}),
    ...(sentImgs.length ? { images: sentImgs.map((i) => i.file) } : {}),
  });
  // 日志记实际发出去的那份（say），别记原始 text——否则 [[img:]] 标记还挂在里面，看着像没发出去
  L('out', `${roomKey} → ${say.slice(0, 60)} ${ids?.length > 1 ? `(${ids.length} 段)` : ''}`);
  // 说过话的房间进入活跃期：接下来一小段时间里，群里的动静继续接得上
  router.markSpoke(roomKey);
  for (const p of conflicts) pending.markAsked(p.id);

  // 主人明说「记住这个」—— 当场写一条，不排到半小时后
  if (REMEMBER_RE.test(String(last.text || ''))) {
    const note = notes.add({
      kind: '约定',
      text: `他说的：${toPlain(String(last.text)).slice(0, 200)}`,
      room: roomKey,
      source: [last.msgId],
      weight: 3,
    });
    if (note) L('memory', `当场记下：${note.text}`);
  }
}

/** 他点头之后：原样再跑一次，这一次那一条会被放过去。 */
async function rerunApproved(a) {
  const onEvent = makeOnEvent(a.roomKey);
  try {
    const result = await brain.run({ prompt: a.prompt, sessionId: a.sid, room: a.roomKey, onEvent, model: a.model || null });
    await finishTurn(a.roomKey, a.last, result, [], []);
  } catch (err) {
    if (err?.code === 'GATE_BLOCKED' && gate.blocked) {
      const b = gate.blocked;
      awaiting = {
        roomKey: a.roomKey, msgs: a.msgs, last: a.last, prompt: a.prompt, sid: a.sid,
        tool: b.tool, input: b.input, verdict: b.verdict, at: Date.now(),
      };
      L('gate', `又拦下一个：${b.verdict.why}`);
      await askApproval(a.last, b);
      return;
    }
    L('gate', `放行之后还是没跑完：${err?.message ?? err}`);
  } finally {
    // 这一轮的钥匙用完就收，下一轮重新问
    gate.endTurn();
  }
}

// ── 记忆保养（只体检已经记着的，不看新流水）─────────────
async function runUpkeep() {
  if (!worker) return null;
  try {
    const r = await upkeep({ brain: decideBrain, notes, pending, logger: L });
    // 先把候选过一遍眼：像不像表情，看图说话，不按文件大小判
    const scored = await screenStickers({ brain: visionBrain, stickers: stickerLib, logger: L, maxOps: 4 });
    if (scored.checked) L('sticker', `筛了 ${scored.checked} 张：收 ${scored.kept} / 退 ${scored.rejected} / 跳过 ${scored.skipped}`);
    // 收下的那些如果还没标签，按当时的语境补
    await upkeepStickers({ brain: visionBrain, stickers: stickerLib, logger: L });
    return r;
  } catch (err) {
    L('upkeep', `异常：${err?.message ?? err}`);
    return null;
  }
}

// ── 记忆整理 ─────────────────────────────────────────────
async function runDistill() {
  if (!worker) return null;
  try {
    return await distill({ brain: decideBrain, notes, events, cursorFile, pending, logger: L });
  } catch (err) {
    L('distill', `异常：${err?.message ?? err}`);
    return null;
  }
}

if (worker) {
  const everyMs = Number(process.env.QAD_DISTILL_MS || cfg.distillMs || 30 * 60 * 1000);
  const upkeepMs = Number(process.env.QAD_UPKEEP_MS || cfg.upkeepMs || 6 * 3600 * 1000);
  L('memory', `已记 ${notes.all().length} 条，待确认 ${pending.all().filter((p) => p.status !== 'closed').length} 条，整理间隔 ${Math.round(everyMs / 60000)} 分钟`);
  // 后台活跟"回话"共用一条队列（必须如此，一个我一次只能说一句），
  // 所以有人刚说完话的时候不许它们占着——体检一次能跑五分钟，
  // 那五分钟里她一个字都说不出来，看起来就是"不回消息"。
  // 后台活走自己那条道（bgQueue），不占说话锁。
  // 它们一个字都不会说，却跟回话共用一条队——体检一次五分钟，
  // 那五分钟里他发什么都在后面排着，看起来就是"不回消息"。
  // 仍然守着"闲了才跑"：有人刚说完话的时候不上，别跟他抢机器。
  const pushWhenIdle = (fn, label, { quiet = 120000 } = {}) => () => {
    const quietFor = Date.now() - lastActivityAt;
    if (quietFor < quiet) {
      L('queue', `${label} 让路：${Math.round(quietFor / 1000)}s 前刚有人说话`);
      // 隔一会儿再看，别一路排着等——期间他要是又说话，就继续让
      setTimeout(pushWhenIdle(fn, label, { quiet }), Math.min(60000, quiet)).unref?.();
      return;
    }
    const t0 = Date.now();
    bgQueue.push(async () => {
      const waited = Date.now() - t0;
      if (waited > 10000) L('queue', `${label} 排了 ${Math.round(waited / 1000)}s 才轮到`);
      return fn();
    }, label);
  };

  // ── 记账 + 防重入 ─────────────────────────────────────
  // 这两个活都挂「闲了才跑」：他一直在说话的时候就一路让路。让路本身没错，
  // 可要是让到整晚没跑成，进程活着、队列也活着，唯独记忆整理和体检再也不动，
  // 而且一声不响。所以给每个活记一笔「最后一次真跑完」的时刻，看门狗靠它判。
  const lastRan = { distill: Date.now(), upkeep: Date.now() };
  const inflight = new Set();   // 正在跑
  const queued = new Set();     // 已经排进队、还没轮到
  const tracked = (label, fn) => async () => {
    if (inflight.has(label)) { L('queue', `${label} 上一趟还没跑完，这次不叠`); return null; }
    inflight.add(label);
    try { return await fn(); }
    finally { inflight.delete(label); lastRan[label] = Date.now(); }
  };
  const distillJob = tracked('distill', runDistill);
  const upkeepJob = tracked('upkeep', runUpkeep);
  // 开机也走"闲了才跑"：以前是定时直接 push，重启一次就把她的回话堵在后面好几分钟
  setTimeout(pushWhenIdle(distillJob, 'distill'), 15000).unref?.();
  setInterval(pushWhenIdle(distillJob, 'distill'), everyMs).unref?.();

  // 体检：跟新流水无关，看的是“已经记着的有没有记坏”
  L('memory', `记忆体检间隔 ${Math.round(upkeepMs / 60000)} 分钟`);
  // 体检最重（记忆 + 看图筛表情 + 补标签），要闲得更久才准它上
  setTimeout(pushWhenIdle(upkeepJob, 'upkeep', { quiet: 300000 }), 90000).unref?.();
  setInterval(pushWhenIdle(upkeepJob, 'upkeep', { quiet: 300000 }), upkeepMs).unref?.();

  // ── 看门狗：后台活饿死的兜底 ───────────────────────────
  // 上面那条路在他一直说话时会无限让路；这条不吃 quiet，每 5 分钟抬头看一眼：
  // 哪个超过两个周期没跑成，记一条日志、直接补一次。只补、不改正常节拍；
  // 补的那次照样走 bgQueue，不占说话锁。想关：QAD_WATCHDOG=0；
  // 想放宽阈值：QAD_WATCHDOG_GRACE=<几个周期>。
  const watchdogGrace = Number(process.env.QAD_WATCHDOG_GRACE || 2);
  if (process.env.QAD_WATCHDOG !== '0' && watchdogGrace > 0) {
    const watched = [['distill', distillJob, everyMs], ['upkeep', upkeepJob, upkeepMs]];
    const watchMs = Number(process.env.QAD_WATCHDOG_MS || Math.min(5 * 60 * 1000, Math.max(60 * 1000, Math.round(everyMs / 4))));
    setInterval(() => {
      const now = Date.now();
      for (const [label, job, period] of watched) {
        const gap = now - lastRan[label];
        if (gap < period * watchdogGrace) continue;
        if (inflight.has(label) || queued.has(label)) continue;
        L('queue', `${label} 已经 ${Math.round(gap / 60000)} 分钟没跑成（周期 ${Math.round(period / 60000)} 分钟），不等安静了，直接补一次`);
        queued.add(label);
        bgQueue.push(async () => {
          try { await job(); } finally { queued.delete(label); }
        }, `${label}·补`);
      }
    }, watchMs).unref?.();
  }
}

// ── 收图清理：按天数 + 容量，删最旧的 ─────────────────────
const imageDir = path.join(cfg.dataDir, 'images');
const videoDir = path.join(cfg.dataDir, 'videos');
const cleanImages = () => {
  try { cleanupImages(imageDir, cfg.images || {}, L); } catch (err) { L('media', `清理失败：${err?.message ?? err}`); }
  try { cleanupImages(videoDir, cfg.videos || {}, L); } catch (err) { L('media', `清理视频失败：${err?.message ?? err}`); }
};

// 表情库满了也自己收：按用得多少排，用得最少的先删（图跟记录一起走，先留档）
const pruneStickers = () => {
  try {
    const r = stickerLib.prune(cfg.stickers || {}, (tag, msg) => L(tag, msg));
    if (r.removed) L('sticker', `清理后：${r.count} 张 / ${(r.bytes / 1048576).toFixed(1)}MB`);
  } catch (err) { L('sticker', `清理失败：${err?.message ?? err}`); }
};

cleanImages();
setInterval(() => { cleanImages(); pruneStickers(); }, 60 * 60 * 1000).unref?.();

// ── 冷场与主动开话题 ─────────────────────────────────────
const social = cfg.group?.social || {};
const groupRooms = () =>
  [...new Set(
    events.readRecent({ limit: 200 })
      .map((e) => String(e.room || ''))
      .filter((r) => r.startsWith('group:')),
  )];

/** 冷场试探 / 主动开话题：都是"让它自己说一句"，说不说由它（PASS 就闭嘴）。 */
// 同一个房间同一时刻只放一个"在想"，别叠着跑。
const idleThinking = new Set();
async function idleSay(roomKey, mode = 'idle') {
  if (brain.kind === 'none') return;
  const gid = roomKey.split(':')[1];
  if (!gid) return;
  if (idleThinking.has(roomKey)) return;

  const ask = mode === 'idle'
    ? '【屋里安静了一会儿】你想接一句吗？想就自然地说一句短的（别问"还有人吗"这种）；不想就只回 PASS。'
    : '【这个群安静很久了】你想主动开个话题吗？自然一点，别像客服开场白；不想就只回 PASS。';

  const recent = events.readRecent({ room: roomKey, limit: 8 });
  const body = renderTranscript(recent.filter((e) => e.text));
  const prompt = `${ask}\n\n【最近的对话】\n${body || '（没什么内容）'}`;
  const sid = sessions.get(roomKey);
  // 没人在场（冷场/自己开话题）：她可以说话，但一个工具都不许用。
  const onEvent = makeDenyAllOnEvent(roomKey);

  // 想这一下不占说话锁：冷场想一句能跑十几秒，占着锁的话他这时候发消息
  // 就得在后面等。这个形状 10-22 在自由活动那条路上踩过（12:30:42 他那句
  // 等到 12:31:48，那一拍 brain.run 跑了 92 秒），那条路 16:03 起只把
  // "发出去"排进锁；冷场这处是同一个形状的最后一处。
  // 想好了才排队去说 —— 说那一下必须独占，一个我一次只说一句。
  idleThinking.add(roomKey);
  const t0 = Date.now();
  let result;
  try {
    result = await brain.run({ prompt, sessionId: sid, room: roomKey, onEvent });
  } catch (err) {
    if (err?.code === 'GATE_BLOCKED' && gate.blocked) {
      L('gate', `冷场开口时被拦：${gate.blocked.verdict.why}`);
      gate.reject();
      return;
    }
    L('social', `没说出来：${err?.message ?? err}`);
    return;
  } finally {
    idleThinking.delete(roomKey);
  }
  // 想好了，轮到说：这期间他要是开口了，冷场就不成立，这句咽回去。
  if (queue.busy || lastActivityAt >= t0) {
    L('social', `${roomKey} 冷场想好了，但这期间有人说话，咽回去`);
    return;
  }
  await queue.push(
    () => finishTurn(roomKey, { kind: 'group', id: gid, text: '', msgId: null }, result, [], []),
    `${roomKey}::idle-say`,
  );
}

if (cfg.group?.enabled !== false && social.enabled !== false && brain.kind !== 'none') {
  const idleEvery = Math.max(15000, Number(social.idleWindowMs ?? 360000) / 6);
  setInterval(() => {
    for (const room of groupRooms()) {
      // 正在回他话的时候不查冷场：idleCheck 一被叫到就把这次试探机会用掉了
      if (queue.busy) continue;
      const what = router.idleCheck(room);
      if (what === 'retire') L('social', `${room} 退场，回观望`);
      else if (what === 'idle-probe') {
        L('social', `${room} 冷场，试探一句`);
        idleSay(room, 'idle').catch((e) => L('social', `冷场异常：${e?.message ?? e}`));
      }
    }
  }, idleEvery).unref?.();

  const p = social.proactive || {};
  if (p.enabled !== false) {
    const nextAt = new Map();
    const schedule = (room) => {
      const min = Number(p.checkMinMs ?? 2700000);
      const max = Math.max(min, Number(p.checkMaxMs ?? min));
      nextAt.set(room, Date.now() + min + Math.random() * (max - min));
    };
    setInterval(() => {
      const now = Date.now();
      for (const room of groupRooms()) {
        if (!nextAt.has(room)) { schedule(room); continue; }
        if (now < nextAt.get(room)) continue;
        schedule(room);
        if (queue.busy) continue; // 他在说话，这时候不自己开话题
        if (!router.proactiveCheck(room)) continue;
        L('social', `${room} 安静很久，主动开个话题`);
        idleSay(room, 'proactive').catch((e) => L('social', `开话题异常：${e?.message ?? e}`));
      }
    }, 60000).unref?.();
  }
}

const stickerLib = new StickerLibrary({
  file: path.join(cfg.dataDir, 'stickers', 'library.json'),
  dir: path.join(cfg.dataDir, 'stickers', 'library'),
  root: ROOT,
  logger: (tag, msg) => L(tag, msg),
});
pruneStickers();

// ── 面板接口：改完配置立刻生效，不用重启 ──────────────────
// 为什么要有这个：sender 把 send.* 拷到自己身上了、戳一戳冷却把毫秒拷进去了，
// 面板改完只动了 cfg 里那份，它们手里还是旧的。改动分三类：
//   · 值拷贝的（发送参数、冷却毫秒）→ 在这里重新灌一遍
//   · 派生出来的提示词（空间能不能用）→ setHints 重算一次
//   · 决定定时器结构的（group.social）→ 热改不了，标进 NEEDS_RESTART
function onConfigChanged({ touched = [] } = {}) {
  const set = new Set(touched);
  try {
    if (touched.some((p) => p.startsWith('send.'))) {
      sender.reconfigure(cfg.send || {});
      L('web', '发送参数换了：分句 / 条间间隔 / 单条上限');
    }
    if (set.has('poke')) {
      pokeCooldown.setMs(cfg.poke?.cooldownMs ?? 30000);
      L('web', '戳一戳冷却换了');
    }
    if (touched.some((p) => p.startsWith('brain.headless.'))) {
      brain.reconfigure?.({ ...(cfg.brain?.headless || {}) });
      L('web', '模型参数换了：下一次回话就用新的');
    }
    if (set.has('qzone.enabled')) {
      setHints({ qzone: (cfg.qzone || {}).enabled === true });
      L('web', `QQ 空间那条${cfg.qzone?.enabled === true ? '开了' : '关了'}`);
    }
    L('web', `配置已热更新：${touched.join('、')}`);
  } catch (err) {
    L('web', `热更新出错（这次只能靠重启）：${err?.message ?? err}`);
  }
}

startWeb({
  usageStore, cfg, logger: { info: L, warn: (tag, msg) => L(tag, msg) }, notes, pending, events, sessions, router, gate, brain, roomNames, freeTime, stickerLib, onebot: client, onConfig: onConfigChanged });

// ── 起 ───────────────────────────────────────────────────
client.connect();

let closing = false;
async function shutdown(sig) {
  if (closing) return;
  closing = true;
  L('exit', `收到 ${sig}，收尾中…`);
  try { await debounce.drain(); } catch { /* ignore */ }
  try { await queue.drain(); } catch { /* ignore */ }
  // 后台那道（体检/整理）一次能跑几分钟：等它就等于关不掉窗口。
  // 给它 8 秒，没跑完就随进程一起结束——那些活都是可重来的，卡住收尾才是真麻烦。
  try {
    let t = null;
    await Promise.race([
      bgQueue.drain(),
      new Promise((r) => { t = setTimeout(r, 8000); t.unref?.(); }),
    ]);
    if (t) clearTimeout(t);
  } catch { /* ignore */ }
  client.close();
  try { lock.release(); } catch { /* ignore */ }
  L('exit', '已停止');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => L('crash', `unhandledRejection: ${e?.message ?? e}`));
process.on('uncaughtException', (e) => L('crash', `uncaughtException: ${e?.message ?? e}`));


// 插件起桥时会塞 QAD_PARENT_PID：DSH 一关，桥跟着关，别留孤儿在后台听 QQ
const parentPid = Number(process.env.QAD_PARENT_PID) || 0;
if (parentPid) {
  // 记一笔“我归谁管”：DSH 重启后，新插件靠它认出旧桥是上一代的
  try { fs.writeFileSync(path.join(cfg.dataDir, 'bridge.owner'), String(parentPid), 'utf8'); } catch { /* ignore */ }
  watchParent({
    pid: parentPid,
    onGone: () => {
      L('exit', `DSH（pid ${parentPid}）不在了，桥跟着收工`);
      shutdown('parent-gone');
    },
  });
  L('boot', `跟着 DSH（pid ${parentPid}）走`);
}
