// 入口：装配身体，接上脑子，开始听。
// 默认只监听不开口（brain.kind=none），要真回话再改 config.local.json。
import path from 'node:path';
import fs from 'node:fs';

import { loadConfig, ensureDirs, ROOT, interestFile, personaFile, notebookDir, workerDir } from './config.mjs';
import { log } from './util/log.mjs';
import { OneBotClient } from './onebot/client.mjs';
import { ensureSnowLuma } from './snowluma/launch.mjs';
import { Sender } from './onebot/sender.mjs';
import { EventLog } from './memory/events.mjs';
import { SelfDrafts } from './memory/selfdrafts.mjs';
import { normalizeEvent, renderTranscript, segmentsToText } from './body/room.mjs';
import { isPoke, pokedMe, pokeRoom, decidePoke, PokeCooldown } from './body/poke.mjs';
import { renderForwardNodes, pickNodes } from './body/forward.mjs';
import { buildPrompt, buildFollowup, NOPOWER_HINT, renderStickers, setHints, ruleOf } from './body/prompt.mjs';
import { judgeFull, chatRules } from './body/rules.mjs';
import { setWorkspaceRoots, underWorkspace } from './safety/rules.mjs';
import { SessionMap } from './memory/sessions.mjs';
import { RoomNames } from './onebot/roomnames.mjs';
import { NotesStore } from './memory/notes.mjs';
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
import { startAutoFree } from './body/freetime-auto.mjs';
import { SerialQueue } from './body/queue.mjs';
import { createBrain } from './brain/index.mjs';
import { Gate, classify } from './safety/gate.mjs';
import { acquireLock } from './util/lock.mjs';
import os from 'node:os';
import { watchParent } from './util/parent.mjs';
import { startWeb } from './web/server.mjs';
import { cleanupImages } from './media/cleanup.mjs';
import { StickerLibrary } from './stickers/library.mjs';
import { isYes, isNo } from './util/yesno.mjs';
import { auditReply } from './safety/audit.mjs';
import { resolveQuote } from './body/room.mjs';

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
{
  const beat = () => { try { fs.writeFileSync(heartbeatFile, String(Date.now()), 'utf8'); } catch { /* ignore */ } };
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
const queue = new SerialQueue({ logger: L });
const pokeCooldown = new PokeCooldown(cfg.poke?.cooldownMs ?? 30000);
const brain = createBrain(cfg, L);
const sessions = new SessionMap({ file: path.join(cfg.dataDir, 'sessions.json') });
const roomNames = new RoomNames({ file: path.join(cfg.dataDir, 'rooms.json') });
const notes = new NotesStore({ file: path.join(cfg.dataDir, 'memory', 'notes.jsonl') });
const cursorFile = path.join(cfg.dataDir, 'memory', 'cursor.json');
const pending = new PendingStore({ file: path.join(cfg.dataDir, 'memory', 'pending.json') });

// 自由活动：她自己待一段时间的那个循环
function freeRoomKey() {
  return cfg.freeTime?.room || `private:${cfg.owner.userIds[0] ?? 'owner'}`;
}
async function freeSay(text) {
  const room = freeRoomKey();
  const qq = String(room).replace(/^private:/, '').replace(/^group:/, '');
  const ids = String(room).startsWith('group:')
    ? await sender.sendGroup(qq, text)
    : await sender.sendPrivate(qq, text);
  // free: true —— 这句是自由活动里她自己主动说的，不走房间会话。
  // 装配背景时要按这个标记补给她，否则她下次就真当没说过。
  events.append({
    dir: 'out',
    room,
    kind: String(room).startsWith('group:') ? 'group' : 'private',
    id: qq,
    msgId: ids?.[0] ?? null,
    text,
    free: true,
  });
  L('out', `${room} → ${text.slice(0, 60)}`);
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
const usagePrice = cfg.usage?.price || null;
const usageCurrency = cfg.usage?.currency || '¥';
try {
  const selfText = fs.readFileSync(personaFile(cfg, 'self'), 'utf8');
  const synced = interests.sync(selfText);
  if (synced.added.length) L('interests', `从 self.md 收进 ${synced.added.length} 条：${synced.added.join('、')}`);
  L('interests', `清单 ${synced.total} 条`);
} catch (e) {
  L('interests', `同步失败（不影响说话）：${e?.message ?? e}`);
}

const freeTime = new FreeTime({
  onUsage: recordUsage,
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
    return {
      lastTs: last?.ts ?? 0,
      lastDir: last?.dir ?? '',
      lastInTs: lastIn?.ts ?? 0,
      lastInText: String(lastIn?.text ?? ''),
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

let lastSeenTs = Date.now();
// 每个房间「上一轮动过手没有」。只认上一轮——用 20 分钟窗口会让一次 web_fetch
// 把后面半小时全判成干活，闲聊就永远回到精简体。
const lastRoundTouched = new Map();
// 拼给提示词的那一句「今天花了多少」：全局 + 这个房间
function usageLineFor(roomKey) {
  try {
    const t = usageStore.today(undefined, { price: usagePrice });
    if (!t.turns) return '';
    const all = describeUsage(t, { price: usagePrice, currency: usageCurrency });
    const mine = t.rooms.find((r) => r.room === roomKey);
    const mineText = mine ? `；这个房间 ${describeUsage(mine, { price: usagePrice, currency: usageCurrency })}` : '';
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
    usageStore.add({ room: roomKey, usage: u, model: cfg.brain?.model || '', kind });
    L('usage', `${kind} ${roomKey} 用了 ${u.totalTokens} token（缓存 ${u.cacheReadTokens}）`);
  } catch (e) {
    L('usage', `记账失败：${e?.message ?? e}`);
  }
}

const REMEMBER_RE = /(记住|记一下|记下|别忘了|remember)/i;
const debounce = new Debounce(cfg.debounceMs, (roomKey, msgs) => {
  queue.push(() => handleBatch(roomKey, msgs), roomKey);
});

// 人格三层都从项目里的 persona/ 读，按场合拼进提示词：
// core 每轮都带；group 只在群里带；self 每轮都带。
const PERSONA_DIR = path.join(ROOT, 'persona');
function personaOf(name) {
  try { return fs.readFileSync(path.join(PERSONA_DIR, name), 'utf8').trim(); } catch { return ''; }
}
function personaNoteFor(isGroup) {
  // 三层人设都由这里拼进提示词。核心卡以前以为“DSH 会按工作区 AGENTS.md 自动加载”，
  // 但工作区搬进项目之后，那儿的 AGENTS.md 只有干活规矩，一个人设字都没有——
  // 结果她一直没读到 core.md（2026-10-22 她自己翻出来的）。
  const parts = [];
  const core = personaOf('core.md');
  if (core) parts.push(`【核心人设】
${core}`);
  if (isGroup) {
    const g = personaOf('group.md');
    if (g) parts.push(`【群聊手册】
${g}`);
  }
  const mine = personaOf('self.md');
  if (mine) parts.push(`【我自己的部分】
${mine}`);
  return parts.join(String.fromCharCode(10) + String.fromCharCode(10));
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
setHints({ browser: browserReady });

L('boot', `root=${ROOT}`);
L('boot', `onebot ws=${cfg.onebot.wsUrl} http=${cfg.onebot.httpUrl} token=${cfg.onebot.accessToken ? 'yes' : 'no'}`);
L('boot', `brain=${brain.kind} dry=${cfg.send.dryRun} owners=[${cfg.owner.userIds.join(',')}] 聚批=${cfg.debounceMs}ms`);
L('boot', `浏览器工具：${browserReady ? '有（browser-skill）' : '没有，提示词里不提'}`);

// ── 收 ───────────────────────────────────────────────────
function selfNames() {
  return [client.selfName, ...(cfg.group?.names || [])].filter(Boolean);
}

/** 看头几个字节认图片格式，认不出就 null（交给调用方兜底）。 */
function sniffImage(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

/** 把收到的图存到本地 —— 存不下的就跳过，不能因为一张图把消息丢了。 */
async function saveImages(msg) {
  const dir = path.join(cfg.dataDir, 'images');
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  for (const [i, url] of msg.images.entries()) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      // 按文件头定扩展名：QQ 给的地址后缀经常是假的（.png 里装 jpg），
      // 名字错了 read_image 会直接拒读，所以宁可自己嗅一遍。
      const ext = sniffImage(buf) || (url.match(/\.(png|jpe?g|gif|webp)/i)?.[1] || 'png').toLowerCase();
      const file = path.join(dir, `${msg.msgId || Date.now()}-${i}.${ext}`);
      fs.writeFileSync(file, buf);
      files.push(file);
    } catch { /* ignore */ }
  }
  return files;
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
 *  理由：别人（群里任何人）让她干活，一律推掉；要动手只能由特权号开口。 */
function makeDenyAllOnEvent(room) {
  return (ev) => {
    if (ev?.type !== 'tool_call') return;
    auditRoom = room;
    const v = classify(ev.tool, ev.input);
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
    queue.push(() => handleBatch(room, [msg]), room);
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

  // 合并转发只来个空壳，内容得按外层消息的 message_id 去取
  if (msg.hasForward) {
    try {
      const res = await client.call('get_forward_msg', { message_id: Number(msg.msgId) });
      const ex = renderForwardNodes(pickNodes(res));
      if (ex) {
        msg.text = String(msg.text).replace('[合并转发]', ex.text);
        L('forward', `${msg.room} 展开了 ${ex.shown}/${ex.count} 条`);
      } else {
        L('forward', '取回来是空的，保留占位');
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
        const text = segs ? segmentsToText(segs) : String(data?.raw_message ?? '');
        if (String(text).trim()) {
          msg.quoteText = String(text).trim();
          msg.quoteName = String(data?.sender?.card || data?.sender?.nickname || data?.sender?.user_id || '某人');
          L('quote', `取回被引用的一条：${msg.quoteText.slice(0, 40)}`);
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
      queue.push(() => rerunApproved(a), a.roomKey);
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
  // 手边有什么表情，摆出来她才想得起来用
  const stickerLine = renderStickers(stickerLib.search({ limit: 8 }), cfg.sticker?.style);
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
  // 规程按需挂：闲聊只留四句，像要派活才挂全套。
  // 判错不要紧——规程不是权限，工具每轮都在，没挂说明她也照样能调。
  const verdict = judgeFull({
    isGroup,
    messages: msgs,
    addressed,
    toolsJustUsed: touchedPrevRound,
  });
  const rulesText = verdict.full ? ruleOf(isGroup) : chatRules(isGroup);
  // 工具也按需：闲聊走轻装 profile（工具少，每步省两万 token），要动手才切全量
  const chatProfile = cfg.brain?.headless?.chatProfile || '';
  const turnProfile = verdict.full || !chatProfile ? null : chatProfile;
  if (chatProfile) L('brain', turnProfile ? `轻装（${chatProfile}）` : '全量（要动手）');
  L('rules', verdict.full ? `全套规程 ← ${verdict.reason}` : `精简规程 ← ${verdict.reason}`);
  const promptFresh = buildPrompt({ roomKey, messages: msgs, recent, background, isGroup, selfNames: names, stickerLine, personaNote: personaNoteFor(isGroup), extra: draftsLine, rules: rulesText, usageLine: usageLineFor(roomKey) });
  let prompt = sid
    ? buildFollowup(msgs, {
      delta, isGroup, addressed, selfNames: names, stickerLine,
      personaNote: personaNoteFor(isGroup),
      rules: verdict.full ? rulesText : '',
      usageLine: usageLineFor(roomKey),
    })
    : promptFresh;

  const fromOwnerEarly = isRoot(last.from);
  if (!fromOwnerEarly) prompt += '\n\n' + NOPOWER_HINT;

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
  const onEvent = trusted ? makeAuditOnEvent(roomKey) : makeDenyAllOnEvent(roomKey);
  if (trusted) L('gate', `特权直通：${roomKey}（${msgs.length} 条），只记账不拦`);
  else if (fromOwner) L('gate', `这一批里混了别人的话：${roomKey} 这一轮只能用嘴`);
  else L('gate', `没有特权号：${roomKey} 这一轮只能用嘴`);

  let result = null;
  // 真干起来要时间（尤其她翻文件、画图的时候），先给一句话，别让人干等着。
  // 说什么、说不说都写在 config 里（ack.private / ack.group），不再写死在代码里。
  const ackCfg = cfg.ack ?? {};
  const ackList = (isGroup ? ackCfg.group : ackCfg.private) ?? [];
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
      if (ackTimer) {
        clearTimeout(ackTimer);
        ackTimer = null;
        L('ack', '她动手了，这句不垫');
      }
    }
    return onEvent(ev);
  };
  try {
    result = await brain.run({ prompt, sessionId: sid, room: roomKey, onEvent: onEventAcked, profile: turnProfile });
  } catch (err) {
    if (err?.code === 'GATE_BLOCKED' && gate.blocked) {
      const b = gate.blocked;
      awaiting = {
        roomKey, msgs, last, prompt, sid,
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
    // 会话可能被删了或对不上，重开一次，别让这一条石沉大海
    L('brain', `会话 ${sid} 用不了（${err?.message ?? err}），给 ${roomKey} 重开一个`);
    sessions.clear(roomKey);
    try {
      result = await brain.run({
        prompt: promptFresh,
        sessionId: null,
        room: roomKey,
        onEvent,
        profile: turnProfile,
      });
    } catch (err2) {
      if (err2?.code === 'GATE_BLOCKED' && gate.blocked) {
        const b = gate.blocked;
        awaiting = {
          roomKey, msgs, last,
          prompt: promptFresh,
          sid: null,
          tool: b.tool, input: b.input, verdict: b.verdict, at: Date.now(),
        };
        L('gate', `停在这一步，等他点头：${b.verdict.why}`);
        clearTimeout(ackTimer);
        await askApproval(last, b);
        return;
      }
      L('brain', `重开也失败：${err2?.message ?? err2}`);
      clearTimeout(ackTimer);
      return;
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
    const result = await brain.run({ prompt: a.prompt, sessionId: a.sid, room: a.roomKey, onEvent });
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
    const r = await upkeep({ brain: worker, notes, pending, logger: L });
    // 先把候选过一遍眼：像不像表情，看图说话，不按文件大小判
    const scored = await screenStickers({ brain: worker, stickers: stickerLib, logger: L, maxOps: 4 });
    if (scored.checked) L('sticker', `筛了 ${scored.checked} 张：收 ${scored.kept} / 退 ${scored.rejected} / 跳过 ${scored.skipped}`);
    // 收下的那些如果还没标签，按当时的语境补
    await upkeepStickers({ brain: worker, stickers: stickerLib, logger: L });
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
    return await distill({ brain: worker, notes, events, cursorFile, pending, logger: L });
  } catch (err) {
    L('distill', `异常：${err?.message ?? err}`);
    return null;
  }
}

if (worker) {
  const everyMs = Number(process.env.QAD_DISTILL_MS || cfg.distillMs || 30 * 60 * 1000);  L('memory', `已记 ${notes.all().length} 条，待确认 ${pending.all().filter((p) => p.status !== 'closed').length} 条，整理间隔 ${Math.round(everyMs / 60000)} 分钟`);
  // 后台活跟"回话"共用一条队列（必须如此，一个我一次只能说一句），
  // 所以有人刚说完话的时候不许它们占着——体检一次能跑五分钟，
  // 那五分钟里她一个字都说不出来，看起来就是"不回消息"。
  const pushWhenIdle = (fn, label, { quiet = 120000 } = {}) => () => {
    const quietFor = Date.now() - lastActivityAt;
    if (quietFor < quiet) {
      L('queue', `${label} 让路：${Math.round(quietFor / 1000)}s 前刚有人说话`);
      // 隔一会儿再看，别一路排着等——期间他要是又说话，就继续让
      setTimeout(pushWhenIdle(fn, label, { quiet }), Math.min(60000, quiet)).unref?.();
      return;
    }
    const t0 = Date.now();
    queue.push(async () => {
      const waited = Date.now() - t0;
      if (waited > 10000) L('queue', `${label} 排了 ${Math.round(waited / 1000)}s 才轮到`);
      return fn();
    }, label);
  };
  // 开机也走"闲了才跑"：以前是定时直接 push，重启一次就把她的回话堵在后面好几分钟
  setTimeout(pushWhenIdle(runDistill, 'distill'), 15000).unref?.();
  setInterval(pushWhenIdle(runDistill, 'distill'), everyMs).unref?.();

  // 体检：跟新流水无关，看的是“已经记着的有没有记坏”
  const upkeepMs = Number(process.env.QAD_UPKEEP_MS || cfg.upkeepMs || 6 * 3600 * 1000);
  L('memory', `记忆体检间隔 ${Math.round(upkeepMs / 60000)} 分钟`);
  // 体检最重（记忆 + 看图筛表情 + 补标签），要闲得更久才准它上
  setTimeout(pushWhenIdle(runUpkeep, 'upkeep', { quiet: 300000 }), 90000).unref?.();
  setInterval(pushWhenIdle(runUpkeep, 'upkeep', { quiet: 300000 }), upkeepMs).unref?.();
}

// ── 收图清理：按天数 + 容量，删最旧的 ─────────────────────
const imageDir = path.join(cfg.dataDir, 'images');
const cleanImages = () => {
  try { cleanupImages(imageDir, cfg.images || {}, L); } catch (err) { L('media', `清理失败：${err?.message ?? err}`); }
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
async function idleSay(roomKey, mode = 'idle') {
  if (brain.kind === 'none') return;
  const gid = roomKey.split(':')[1];
  if (!gid) return;

  const ask = mode === 'idle'
    ? '【屋里安静了一会儿】你想接一句吗？想就自然地说一句短的（别问"还有人吗"这种）；不想就只回 PASS。'
    : '【这个群安静很久了】你想主动开个话题吗？自然一点，别像客服开场白；不想就只回 PASS。';

  const recent = events.readRecent({ room: roomKey, limit: 8 });
  const body = renderTranscript(recent.filter((e) => e.text));
  const prompt = `${ask}\n\n【最近的对话】\n${body || '（没什么内容）'}`;
  const sid = sessions.get(roomKey);
  // 没人在场（冷场/自己开话题）：她可以说话，但一个工具都不许用。
  const onEvent = makeDenyAllOnEvent(roomKey);

  try {
    const result = await brain.run({ prompt, sessionId: sid, room: roomKey, onEvent });
    await finishTurn(roomKey, { kind: 'group', id: gid, text: '', msgId: null }, result, [], []);
  } catch (err) {
    if (err?.code === 'GATE_BLOCKED' && gate.blocked) {
      L('gate', `冷场开口时被拦：${gate.blocked.verdict.why}`);
      gate.reject();
      return;
    }
    L('social', `没说出来：${err?.message ?? err}`);
  }
}

if (cfg.group?.enabled !== false && social.enabled !== false && brain.kind !== 'none') {
  const idleEvery = Math.max(15000, Number(social.idleWindowMs ?? 360000) / 6);
  setInterval(() => {
    for (const room of groupRooms()) {
      const what = router.idleCheck(room);
      if (what === 'retire') L('social', `${room} 退场，回观望`);
      else if (what === 'idle-probe') {
        L('social', `${room} 冷场，试探一句`);
        queue.push(() => idleSay(room, 'idle'), `${room}::idle`);
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
        if (!router.proactiveCheck(room)) continue;
        L('social', `${room} 安静很久，主动开个话题`);
        queue.push(() => idleSay(room, 'proactive'), `${room}::proactive`);
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

// ── 面板接口 ─────────────────────────────────────────
startWeb({
  usageStore, cfg, logger: { info: L, warn: (tag, msg) => L(tag, msg) }, notes, pending, events, sessions, router, gate, brain, roomNames, freeTime, stickerLib });

// ── 起 ───────────────────────────────────────────────────
client.connect();

let closing = false;
async function shutdown(sig) {
  if (closing) return;
  closing = true;
  L('exit', `收到 ${sig}，收尾中…`);
  try { await debounce.drain(); } catch { /* ignore */ }
  try { await queue.drain(); } catch { /* ignore */ }
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
