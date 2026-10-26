// 自测：不用真的连 QQ，把合成事件喂进管道看判断对不对。
// node scripts/selftest.mjs
import { normalizeEvent, resolveQuote, shortenQuote, renderTranscript, withFiles } from '../src/body/room.mjs';
import { createRouter } from '../src/body/router.mjs';
import { toPlain, splitMessage } from '../src/util/text.mjs';
import { StickerLibrary } from '../src/stickers/library.mjs';
import { FreeTime, openingMood, draftLines, shouldYield, stripMarks } from '../src/body/freetime.mjs';
import { UsageStore, describeUsage } from '../src/usage/store.mjs';
import { buildPrompt, buildTriggerLines, videoHint, LIGHT_HINT } from '../src/body/prompt.mjs';
import { wantsFullTools } from '../src/body/rules.mjs';
import { sniffImage, sniffVideo } from '../src/media/sniff.mjs';
import { gifFrameCount, isAnimatedGif } from '../src/media/gif.mjs';
import { selfLines, agoLabel, refTag, buildBackground } from '../src/memory/context.mjs';
import { SerialQueue } from '../src/body/queue.mjs';
import { ROOT } from '../src/config.mjs';
import { handoverPrompt, cleanHandover } from '../src/memory/handover.mjs';
import { createPersonaGuard } from '../src/memory/persona-guard.mjs';
import { personaNoteFor } from '../src/body/persona-note.mjs';
import { EventLog } from '../src/memory/events.mjs';
import { Sender } from '../src/onebot/sender.mjs';
import { PokeCooldown } from '../src/body/poke.mjs';
import { HeadlessBrain, finishedDespiteExit } from '../src/brain/headless.mjs';
import { restState, restLine } from '../src/body/rest.mjs';
import { Doing } from '../src/body/doing.mjs';
import { dedupe } from '../src/memory/upkeep.mjs';
import { stallNote, FailBook } from '../src/brain/stall.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const fails = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass += 1; return; }
  fails.push(`${name}\n    期望 ${e}\n    实际 ${a}`);
}

function ok(name, cond) {
  if (cond) { pass += 1; return; }
  fails.push(name);
}

// ── normaliseEvent ──────────────────────────────────────
const SELF = '3000000001';  // 虚构的 bot 号

const priv = normalizeEvent({
  post_type: 'message', message_type: 'private', user_id: 1000000001,
  message_id: 111, time: 1700000000,
  sender: { user_id: 1000000001, nickname: '测试者' },
  message: [{ type: 'text', data: { text: '在吗' } }],
}, { selfId: SELF });

check('私聊房间号', priv.room, 'private:1000000001');
check('私聊文本', priv.text, '在吗');
check('私聊不是@我', priv.atMe, false);

const grpAt = normalizeEvent({
  post_type: 'message', message_type: 'group', group_id: 900, user_id: 42,
  message_id: 222, time: 1700000001,
  sender: { user_id: 42, card: '路人' },
  message: [
    { type: 'at', data: { qq: SELF, name: '测试bot' } },
    { type: 'text', data: { text: ' 今天吃啥' } },
  ],
}, { selfId: SELF });

check('群房间号', grpAt.room, 'group:900');
check('群里@我', grpAt.atMe, true);
check('群文本带@名', grpAt.text, '@测试bot 今天吃啥');

const grpPlain = normalizeEvent({
  post_type: 'message', message_type: 'group', group_id: 900, user_id: 42,
  message_id: 223, time: 1700000002, sender: { user_id: 42 },
  message: [{ type: 'text', data: { text: '随便聊聊' } }],
}, { selfId: SELF, selfNames: ['测试bot'] });

check('群里没叫我', grpPlain.atMe, false);

const grpName = normalizeEvent({
  post_type: 'message', message_type: 'group', group_id: 900, user_id: 42,
  message_id: 224, time: 1700000003, sender: { user_id: 42 },
  message: [{ type: 'text', data: { text: '测试bot你说呢' } }],
}, { selfId: SELF, selfNames: ['测试bot'] });

check('群里叫名字算叫我', grpName.atMe, true);

check('自己说的话不回流', normalizeEvent({
  post_type: 'message', message_type: 'private', user_id: 3000000001,
  message_id: 1, sender: { user_id: 3000000001 }, message: 'x',
}, { selfId: SELF }), null);

check('非消息事件返回 null', normalizeEvent({ post_type: 'meta_event' }, { selfId: SELF }), null);

// ── 路由 ────────────────────────────────────────────────
const cfg = {
  owner: { userIds: ['1000000001'], privatePolicy: 'all' },
  group: { enabled: true, keywords: ['测试bot'] },
};
const router = createRouter({ cfg });

check('主人在私聊', router.decide({ kind: 'private', from: '1000000001' }).speak, true);
// 陌生人的私聊从 2026-10-22 起按群聊那套走（主人 m13194）：
// 不再"是私聊就每句都应"，而是进社交状态机——第一次来的生人，先听着。
const strangerRoom = 'private:999';
check('陌生人私聊不再恒回', router.decide({ kind: 'private', room: strangerRoom, from: '999', text: '你好' }).speak, false);
// 但被点名／问到关键词，照样接
check('陌生人私聊里提到关键词', router.decide({ kind: 'private', room: strangerRoom, from: '999', text: '测试bot在吗' }).speak, true);
// 主人的私聊不受影响，随时都应
check('主人私聊仍然恒回', router.decide({ kind: 'private', room: 'private:1000000001', from: '1000000001', text: '嗯' }).speak, true);
// 每个用例给不同房间号：社交状态是「按房间」记的，同一个房间连着测会互相干扰
// （@ 我之后那个房间进活跃期，下一条没叫我的也会被接上）。
check('群里@我', router.decide({ kind: 'group', room: 'g1', from: '42', atMe: true }).speak, true);
check('群里没叫我', router.decide({ kind: 'group', room: 'g2', from: '42', atMe: false, text: '哈哈' }).speak, false);
check('群里提到关键词', router.decide({ kind: 'group', room: 'g3', from: '42', atMe: false, text: '测试bot呢' }).speak, true);

// 社交状态机：用固定的随机源测，不然 20% 的概率会让这一行时过时不过
// 社交参数平时由 config.mjs 的默认值补上；这里直接给，测试不依赖全局默认
const socialCfg = {
  ...cfg,
  group: { ...cfg.group, social: { enabled: true, triggerProbability: 0.2, activeDurationMs: 60000, skipProbability: 0 } },
};
const lucky = createRouter({ cfg: socialCfg, random: () => 0.01 });
check('观望期被点着（随机撞上）', lucky.decide({ kind: 'group', room: 'g4', from: '42', atMe: false, text: '哈哈' }).speak, true);
const unlucky = createRouter({ cfg: socialCfg, random: () => 0.99 });
check('观望期没撞上就不接', unlucky.decide({ kind: 'group', room: 'g5', from: '42', atMe: false, text: '哈哈' }).speak, false);
check('活跃期里接着说话', lucky.decide({ kind: 'group', room: 'g4', from: '43', atMe: false, text: '嗯' }).reason, 'active');

const noOwner = createRouter({ cfg: { ...cfg, owner: { userIds: [], privatePolicy: 'owner-only' } } });
check('没配主人时不私聊乱回', noOwner.decide({ kind: 'private', from: '1' }).speak, false);

// ── 文本 ────────────────────────────────────────────────
check('去加粗', toPlain('**你好**'), '你好');
check('去链接', toPlain('看[这里](https://a.b)'), '看这里');
check('留代码', toPlain('```js\nlet a = 1;\n```'), 'let a = 1;');
check('去标题', toPlain('## 标题'), '标题');
check('去引用', toPlain('> 引用'), '引用');

const long = '第一句。'.repeat(600);
const parts = splitMessage(long, 1200);
ok('长文被切分', parts.length > 1);
ok('每段不超长', parts.every((p) => p.length <= 1200));
ok('切分不丢字', parts.join('').replace(/\s/g, '') === long.replace(/\s/g, ''));

check('短消息不切', splitMessage('在吗', 1200), ['在吗']);

// ── 群里也要看得见图 ────────────────────────────────────
// 2026-10-22：群里走 buildTriggerLines，那儿原先只给一个 [图片] 占位，
// ── 按文件头认格式：名字不可信，工具认内容 ──────────────────
{
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom', 'latin1'), Buffer.alloc(8)]);
  const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]);
  const flv = Buffer.from('FLV\x00\x00\x00	', 'latin1');
  check('认 mp4', sniffVideo(mp4), 'mp4');
  check('认 webm', sniffVideo(webm), 'webm');
  check('认 flv', sniffVideo(flv), 'flv');
  check('认不出就返回 null，别瞎猜', sniffVideo(Buffer.from('hello world!')), null);
  check('图还是老的判断', sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpg');
}

// ── 视频：也得把落盘路径交给她（图能直接看，视频得她自己抽帧）──────
{
  const raw = {
    post_type: 'message', message_type: 'group', group_id: 123, user_id: 456,
    message_id: 789, time: 1700000000,
    sender: { card: '某某', nickname: '某某' },
    message: [
      { type: 'text', data: { text: '你看这个' } },
      { type: 'video', data: { url: 'https://x/v.mp4' } },
    ],
  };
  const msg = normalizeEvent(raw, { selfId: '999', selfNames: ['小鲸鱼'] });
  check('视频段被认出来', msg.videos, ['https://x/v.mp4']);

  const line = renderTranscript([
    { name: '某某', text: '你看这个 [视频]', videoFiles: ['E:/ws/data/videos/789-0.mp4'] },
  ]);
  ok('对话记录里带视频路径', line.includes('视频1：E:/ws/data/videos/789-0.mp4'));

  const trig = buildTriggerLines([
    { idx: 1, name: '某某', text: '[视频]', videoFiles: ['E:/ws/data/videos/789-0.mp4'], atMe: true },
  ], { selfNames: ['小鲸鱼'] });
  ok('群里那句也带视频路径', String(trig).includes('789-0.mp4'));

  const hint = videoHint();
  ok('视频提示里有抽帧的办法', hint.includes('ffmpeg') && hint.includes('read_image'));
  ok('视频提示里说了动图会转成 -anim.mp4', hint.includes('-anim.mp4'));
}

// 动图：read_image 只给一帧，得知道它是不是动图才值得转视频
{
  const gif = Buffer.from('GIF89a' + '\x00'.repeat(8) + '!ù' + '\x00'.repeat(4) + '!ù', 'latin1');
  ok('数得出 GIF 有几帧', gifFrameCount(gif) === 2);
  ok('两帧以上算动图', isAnimatedGif(gif) === true);
  ok('单帧 GIF 不算动图', isAnimatedGif(Buffer.from('GIF89a' + '!ù' + '\x00'.repeat(8), 'latin1')) === false);
  ok('jpg 当 GIF 数帧返回 0', gifFrameCount(Buffer.from('ÿØÿá', 'latin1')) === 0);
  ok('空内容不炸', gifFrameCount(null) === 0 && isAnimatedGif(Buffer.alloc(0)) === false);
}

// 没有路径，她等于看不见图。私聊走 renderTranscript 一直是对的。
{
  const group = buildTriggerLines([
    { idx: 1, name: '某某', text: '[图片]', imageFiles: ['E:/x/img1.jpg'], atMe: false },
    { idx: 2, name: '某某', text: '你看这个', imageFiles: ['E:/x/img2.gif'], atMe: false },
    { idx: 3, name: '某某', text: '没有图', atMe: false },
  ], { selfNames: ['小鲸鱼'] });
  ok('群里带图的消息给了真实路径', group[0].includes('E:/x/img1.jpg'));
  ok('群里带图的消息不再只剩 [图片] 占位', !group[0].includes('[图片]'));
  ok('群里带文字又带图，两样都在', group[1].includes('你看这个') && group[1].includes('E:/x/img2.gif'));
  ok('群里没图的消息不被乱加括号', !group[2].includes('图片1'));
}

// ── 表情库 ──────────────────────────────────────────────
// 用临时目录，绝不碰 data/stickers 里真那些图。
{
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-selftest-lib-'));
  const tmpDir = path.join(tmpRoot, 'library');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpRoot, 'library.json');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const jpeg = Buffer.from(
    'ffd8ffe000104a46494600010100000100010000ffdb004300ffc00011080001000103012200021101031101feffd9',
    'hex',
  );
  const blurp = (name, buf) => { const p = path.join(tmpRoot, name); fs.writeFileSync(p, buf); return p; };

  const lib = new StickerLibrary({ file: tmpFile, dir: tmpDir, root: tmpRoot });
  // 1. QQ 下来的图都叫 .png，里头可能是 jpg —— 存的时候得按文件头取名
  const a = lib.add({ src: blurp('fake.png', jpeg), tags: ['猫'] }).item;
  check('按文件头取名', a.file.endsWith('.jpg'), true);
  const b = lib.add({ src: blurp('real.png', png), tags: ['重复'] }).item;
  const pngB = Buffer.concat([png, Buffer.from('b')]);
  const pngC = Buffer.concat([png, Buffer.from('c')]);
  const c = lib.add({ src: blurp('b.png', pngB), tags: ['可爱'] }).item;
  const d = lib.add({ src: blurp('c.png', pngC), tags: ['呆'] }).item;

  // 1.5 内容一样、名字不一样 = 重复。QQ 转发会换文件名，老判据（同名同大小）拦不住；
  //     2026-10-22 库里那 6 组重复全是这种（k0328=k0008 等，字节完全相同）。
  const twin = lib.add({ src: blurp('renamed.png', pngB) });
  check('同内容不同名算重复', twin.dup, true);
  check('重复的指回原来那张', twin.item.id, c.id);
  check('库里没多出一条', lib.stats().count, 4);

  // 2. prune 删掉的不能从盘上复活（换实例再读、再存一次都不行）
  const out = lib.prune({ maxCount: 2, maxMb: 200 }, () => {});
  check('prune 先删标重复的', out.removed, 2);
  const again = new StickerLibrary({ file: tmpFile, dir: tmpDir, root: tmpRoot });
  again.markUsed(c.id);
  const third = new StickerLibrary({ file: tmpFile, dir: tmpDir, root: tmpRoot });
  check('删掉的不复活', third.stats().count, 2);
  ok('删掉的图真从盘上没了', !fs.existsSync(path.resolve(tmpRoot, a.file)));
  ok('留下的还在', [b, c, d].filter((x) => third.get(x.id)).length === 2);

  // 3. reject 也要写墓碑：图被别的程序占着、挪不走也删不掉时，记录不能爬回来
  const keep = third.all()[0];
  const bad = third.add({ src: blurp('shot.png', png), tags: [] }).item;
  const badAbs = path.resolve(third.abs(bad));
  const realRename = fs.renameSync;
  const realUnlink = fs.unlinkSync;
  fs.renameSync = (x, y) => { if (path.resolve(x) === badAbs) throw new Error('EBUSY'); return realRename(x, y); };
  fs.unlinkSync = (x) => { if (path.resolve(x) === badAbs) throw new Error('EPERM'); return realUnlink(x); };
  try { third.reject(bad.id, '截图'); } finally { fs.renameSync = realRename; fs.unlinkSync = realUnlink; }
  third.markUsed(keep.id);
  ok('reject 掉的不复活', !new StickerLibrary({ file: tmpFile, dir: tmpDir, root: tmpRoot }).get(bad.id));

  // 4. 记录在、图不在：默认还查得到（doctor 的「缺文件」警告靠它），
  //    但递给提示词时必须滤掉 —— 缺图的路径她照着发只会撞上 send 的「图不在」。
  {
    const lostDir = path.join(tmpRoot, 'lost');
    fs.mkdirSync(lostDir, { recursive: true });
    const lost = new StickerLibrary({ file: path.join(tmpRoot, 'lost.json'), dir: lostDir, root: tmpRoot });
    const ghost = lost.add({ src: blurp('ghost.png', png), tags: ['旧'] }).item;
    fs.unlinkSync(path.resolve(tmpRoot, ghost.file));
    check('缺图的记录默认还查得到', lost.search({ limit: 10 }).length, 1);
    check('缺图的不递进提示词', lost.search({ limit: 10, onlyPresent: true }).length, 0);
  }

  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

// ── 自由活动的开场 ──────────────────────────────────────
// 06:31 那次：他 05:39 说了晚安去睡，我六点半醒来，协议硬要我先说一句话。
// 现在房间里没人就不硬开这个口。
{
  const at = (h, m = 0) => new Date(2026, 9, 22, h, m, 0).getTime();
  const now = at(14, 0);
  const inAt = (t, text, dir = 'in') => ({ lastTs: t, lastDir: dir, lastInTs: t, lastInText: text });

  check('没人说过话就不硬开', openingMood({}, { now }).quiet, true);
  check('他刚说了晚安', openingMood(inAt(at(13, 58), '晚安～抱抱'), { now }).quiet, true);
  check('他十分钟前刚说话', openingMood(inAt(at(13, 50), '在干嘛'), { now }).quiet, false);
  check('他三小时没出声了', openingMood(inAt(at(10, 30), '吃了吗'), { now }).quiet, true);
  check('大半夜没人', openingMood(inAt(at(22, 30), '今天好累'), { now: at(23, 40) }).quiet, true);
  check('白天正常开口', openingMood(inAt(at(13, 20), '刚吃完饭'), { now }).quiet, false);
  // 最后一句是我说的也算：只要他隔了够久
  check('我说完他就没影了', openingMood({ lastTs: at(9, 0), lastDir: 'out', lastInTs: at(8, 50), lastInText: '早' }, { now }).quiet, true);
}

// ── 自由活动的标记别被她原样发出去 ──────────────────────
// 2026-10-25 13:38：她先说了「小憩还没醒透……先站起来走两步。」，又单独写一行
// <pass/>，那行跟着一起发进了群里。整段只有标记的情形各分支早处理了，漏的是「话 + 标记」。
{
  ok('标记：话后面跟 <pass/> → 剥掉', stripMarks('小憩还没醒透，先站起来走两步。\n<pass/>') === '小憩还没醒透，先站起来走两步。');
  ok('标记：<pass /> 带空格也剥', stripMarks('好的\n<pass />') === '好的');
  ok('标记：话中间夹 <done/> 也剥', stripMarks('我去睡了<done/>') === '我去睡了');
  ok('标记：只剩标记 → 空，当作这一拍不说话', stripMarks('<pass/>') === '');
  ok('标记：空行和残渣不留下', stripMarks('好\n\n\n<pass/>\n\n') === '好');
  ok('标记：正常的话一个字不动', stripMarks('今天天气不错') === '今天天气不错');
  ok('标记：<busy:洗澡:20/> 也别漏出去', stripMarks('我去洗澡\n<busy:洗澡:20/>') === '我去洗澡');
}

// ── 自由活动说过的话，接话时要摆回她眼前 ────────────────
// 12:32 那次她明明在背景里看见了自己那句，还是回了「丢给我，我一条条对过去」。
// 所以现在每句带时间，让「刚刚」这个词提醒她这事刚发生。
{
  const room = 'private:7';
  const now = Date.parse('2026-10-22T12:40:00+08:00');
  const ev = (agoMs, text, extra = {}) => ({ ts: now - agoMs, room, dir: 'out', text, ...extra });
  const events = [
    ev(3 * 3600_000, '早', { free: true }),
    ev(2 * 3600_000, '午饭吃了', { free: true }),
    ev(60_000, '评审那批我复跑过了', { free: true }),
    { ts: now - 30_000, room, dir: 'out', text: '普通回复不该出现在这儿' },
    { ts: now - 10_000, room: 'private:8', dir: 'out', text: '别的房间', free: true },
  ];
  const block = selfLines(events, room, 3, { now });
  check('自由活动的话补进背景', block.includes('评审那批我复跑过了'), true);
  check('普通回复不重复列', block.includes('普通回复不该出现在这儿'), false);
  check('别的房间不串进来', block.includes('别的房间'), false);
  check('刚说过的话写「刚刚」', block.includes('刚刚你说过'), true);
  check('两小时前的写清多久', block.includes('2 小时前你说过'), true);
  check('agoLabel：刚刚', agoLabel(now - 30_000, now), '刚刚');
  check('agoLabel：分钟', agoLabel(now - 5 * 60_000, now), '5 分钟前');
  const only = selfLines(events, room, 1, { now });
  check('limit 只留最近一条', only.includes('2 小时前你说过'), false);
}

// ── 门牌：记忆后面拖着的号 ───────────────────────────────
{
  check('refTag：一条', refTag({ source: ['ev_abc12345'] }), '（据 ev_abc12345）');
  check('refTag：三条', refTag({ source: ['ev_a', 'ev_b', 'ev_c'] }), '（据 ev_a ev_b ev_c）');
  check('refTag：超过三条只列三条', refTag({ source: ['ev_a', 'ev_b', 'ev_c', 'ev_d'] }), '（据 ev_a ev_b ev_c 等 4 条）');
  check('refTag：没出处就不写', refTag({ source: [] }), '');
  check('refTag：老条目没有 source 也不炸', refTag({}), '');
  const dated = buildBackground({
    cfg: { memory: { rooms: {} } },
    roomKey: 'private:1',
    events: [],
    notes: [{ kind: '约定', text: '他要求叫他先生', room: null, source: ['ev_9717e7f0'], weight: 3 }],
    nameOf: null,
  });
  check('背景里带出门牌', dated.includes('（据 ev_9717e7f0）'), true);
  check('背景里还有那句话', dated.includes('他要求叫他先生'), true);
}

// ── 用量账本 ─────────────────────────────────────────────
{
  const dir = path.join(ROOT, 'tmp', 'selftest-usage');
  fs.rmSync(dir, { recursive: true, force: true });
  const store = new UsageStore({ dir });
  store.add({ room: 'private:1', usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 4000, totalTokens: 5100 } });
  store.add({ room: 'group:2', usage: { inputTokens: 500, outputTokens: 50, cacheReadTokens: 2000, totalTokens: 2550 } });
  const today = store.today();
  check('账本：轮数', today.turns, 2);
  check('账本：token 累加', today.totalTokens, 7650);
  check('账本：房间拆开', today.rooms.length, 2);
  const d0 = new Date();
  const p2 = (x) => String(x).padStart(2, '0');
  const localDay = `${d0.getFullYear()}-${p2(d0.getMonth() + 1)}-${p2(d0.getDate())}`;
  check('账本：落盘一天一个文件', fs.existsSync(path.join(dir, 'usage-' + localDay + '.jsonl')), true);
  const d = describeUsage(today);
  check('描述里有轮数', d.includes('2 轮'), true);
  check('描述里有缓存', d.includes('缓存'), true);
  check('没填单价就不报钱', today.cost, null);

  const priced = store.today(undefined, { price: { inputPerM: 2, outputPerM: 8, cacheReadPerM: 0.5 } });
  // 新输入 1500 * 2/M + 输出 150 * 8/M + 缓存 6000 * 0.5/M = 0.003 + 0.0012 + 0.003 = 0.0072
  check('填了单价就能算钱', Math.round((priced.cost || 0) * 10000) / 10000, 0.0072);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 提示词里的用量块 ─────────────────────────────────────
{
  const withUsage = buildPrompt({
    roomKey: 'private:1',
    messages: [{ kind: 'private', from: '1', fromName: '先生', text: '在吗' }],
    usageLine: '2 轮 / 3.8 万 token',
  });
  check('提示词带用量', withUsage.includes('【今天的量】'), true);
  check('用量里有数字', withUsage.includes('3.8 万'), true);
  const noUsage = buildPrompt({
    roomKey: 'private:1',
    messages: [{ kind: 'private', from: '1', fromName: '先生', text: '在吗' }],
  });
  check('没用量就不写这一段', noUsage.includes('【今天的量】'), false);
}

// ── 咽回去的那句，下一拍要还给她 ────────────────────────
{
  const now = Date.parse('2026-10-22T15:00:00+08:00');
  const hi = { lastInText: '今天别人下载了我的项目，你也看看？' };

  // 想的时候他开口了
  const turn = draftLines({ text: '评审那批复跑过了', why: 'turn', at: now - 50_000 }, hi, { now });
  check('咽回去的句子会带回提示词', turn.includes('评审那批复跑过了'), true);
  check('说清是多久前的', turn.includes('刚刚'), true);
  check('带上他那句做对照', turn.includes('今天别人下载了我的项目'), true);
  check('给她判断权（可发也可丢）', turn.includes('<pass/>'), true);
  check('放久了就说几分钟前', draftLines({ text: 'x', why: 'turn', at: now - 600_000 }, hi, { now }).includes('10 分钟前'), true);

  // 发到一半被打断：要交代已经发出去的是哪半截
  const mid = draftLines({ text: '第一句 第二句 第三句', why: 'mid', at: now - 300_000, sentParts: ['第一句'] }, hi, { now });
  check('半截的要说清发了几段', mid.includes('前 1 段已经发出去了'), true);
  check('半截的不再提他那句（他已经看过了）', mid.includes('发到一半他开口了'), true);

  // 没有草稿就不写这一段
  check('没草稿就不提', draftLines(null, hi, { now }), null);
  check('空句子不算草稿', draftLines({ text: '   ', why: 'turn', at: now }, hi, { now }), null);
}

// ── 他这一句算不算"打断" ────────────────────────────────
{
  const priv = 'private:1';
  const grp = 'group:9';
  const say = (text, extra = {}) => ({ lastDir: 'in', lastTs: 1, lastInText: text, ...extra });

  check('嗯不算打断', shouldYield(say('嗯'), { room: priv }).yield, false);
  check('继续不算打断', shouldYield(say('继续'), { room: priv }).yield, false);
  check('然后呢 不算打断', shouldYield(say('然后呢'), { room: priv }).yield, false);
  check('嗯嗯嗯 不算打断', shouldYield(say('嗯嗯嗯'), { room: priv }).yield, false);
  check('带新信息才打断', shouldYield(say('评审那批我看过了'), { room: priv }).yield, true);
  check('群里别人聊天不算打断', shouldYield(say('这游戏好玩', { lastInAtMe: false, lastInReplyToMe: false }), { room: grp }).yield, false);
  check('群里叫他算打断', shouldYield(say('这游戏好玩', { lastInAtMe: true }), { room: grp }).yield, true);
  check('群里回他也算打断', shouldYield(say('这游戏好玩', { lastInAtMe: false, lastInReplyToMe: true }), { room: grp }).yield, true);
  check('他没说话就不管', shouldYield({ lastDir: 'out', lastInText: '随便' }, { room: priv }).yield, false);
}

// ── 队列：他的一句话先上，自己找的事让路 ──────────────────
{
  // 优先级只管"排队的先后"：晚到的高优先级插到已经在等的后台任务前面
  const q = new SerialQueue();
  const order = [];
  let release;
  const hold = new Promise((r) => { release = r; });
  q.push(async () => { await hold; order.push('bg1'); }, 'bg1');
  q.push(async () => { order.push('bg2'); }, 'bg2');
  q.push(async () => { order.push('fg'); }, 'fg', { priority: 10 });
  release();
  await q.drain();
  check('前景插到排队的后台任务前面', order, ['bg1', 'fg', 'bg2']);

  // 但已经在跑的那个不会被抢断：优先级不是抢占
  const q2 = new SerialQueue();
  const o2 = [];
  let release2;
  const hold2 = new Promise((r) => { release2 = r; });
  q2.push(async () => { o2.push('bg-start'); await hold2; o2.push('bg-end'); }, 'bg');
  q2.push(async () => { o2.push('fg'); }, 'fg', { priority: 10 });
  await new Promise((r) => setTimeout(r, 10));
  check('高优先级不抢断正在跑的', o2, ['bg-start']);
  release2();
  await q2.drain();
  check('等正在跑的那个结束才轮到它', o2, ['bg-start', 'bg-end', 'fg']);

  // 一个任务炸了不许把后面的一起埋掉
  const q3 = new SerialQueue();
  const ran = [];
  const bad = q3.push(async () => { throw new Error('炸了'); }, 'bad');
  q3.push(async () => { ran.push('next'); }, 'next');
  const third = await q3.push(async () => 'ok', 'third');
  check('失败的任务不抛给调用方', await bad, undefined);
  check('一个任务炸了后面的照跑', ran, ['next']);
  check('排队的任务能把结果拿回来', third, 'ok');

  // 空队列 drain 要立刻返回，不能挂着
  const t0 = Date.now();
  await new SerialQueue().drain();
  ok('空队列 drain 立刻返回', Date.now() - t0 < 50);
}

// ── 换会话时写交接 ──────────────────────────────────────
{
  const p = handoverPrompt({ roomName: '阿拜多斯' });
  check('交接提示词带房间名', p.includes('阿拜多斯'), true);
  check('交接要四行', ['干了什么', '为什么这么定', '卡在哪', '下一步'].every((k) => p.includes(k)), true);
  check('要写心里话', handoverPrompt({ includeInner: true }).includes('我心里'), true);
  check('关掉内心就不写', handoverPrompt({ includeInner: false }).includes('我心里'), false);
  check('提醒别复述记录', p.includes('别复述聊天记录'), true);
  check('清掉代码块', cleanHandover(['```js', 'x', '```', '好'].join(String.fromCharCode(10))), '好');
  check('超长按句子截断', cleanHandover('甲。乙。丙。', { maxChars: 3 }), '甲。乙');
  check('没句号就硬切', cleanHandover('甲乙丙丁', { maxChars: 2 }).length <= 2, true);
}

// ── 人设看门人：文件工具改 self.md 时补一份"改之前"的 ──────
// 2026-10-24 13:02 「改动日志」整段没了，备份目录里没有那一份——说明是文件工具
// 直接写的（self.mjs 和面板都会先备份）。看门人只做一件事：变了就存上一版。
{
  const dir0 = fs.mkdtempSync(path.join(os.tmpdir(), 'qad-pguard-'));
  const pfile = path.join(dir0, 'self.md');
  const bdir = path.join(dir0, 'backups');
  const sdir = path.join(dir0, 'state');
  const g = createPersonaGuard({ file: pfile, backupDir: bdir, stateDir: sdir });
  fs.writeFileSync(pfile, '# A\n\n## 喜欢\n\n- 一\n', 'utf8');
  check('头一次只见基线不备份', g.tick().seeded, true);
  check('文件没变不动手', g.tick().changed, false);

  fs.writeFileSync(pfile, '# A\n\n## 讨厌\n\n- 二\n', 'utf8');   // 整份写入，喜欢那节没了
  const r = g.tick();
  check('变了会留上一版', Boolean(r.backedUpTo), true);
  const kept = r.backedUpTo ? fs.readFileSync(r.backedUpTo, 'utf8') : '';
  check('留下的是变之前那份', kept.includes('- 一'), true);
  check('留下的不是新那份', kept.includes('- 二'), false);

  fs.writeFileSync(pfile, '# A\n\n## 讨厌\n\n- 三\n', 'utf8');
  g.tick();
  const bodies = fs.readdirSync(bdir).map((f) => fs.readFileSync(path.join(bdir, f), 'utf8'));
  check('备份之间不重复', new Set(bodies).size, bodies.length);
  fs.rmSync(dir0, { recursive: true, force: true });
}

// ── headless 超时：要说清卡在哪儿 ────────────────────────
// 三天里 6 次体检超时，日志只有一句「headless 超时（300000ms）」，
// 分不出是模型慢、CLI 卡住，还是一条事件都没起来。现在错误里带最后一条事件。
{
  const { HeadlessBrain } = await import('../src/brain/headless.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qad-selftest-hl-'));
  try {
    const fake = path.join(dir, 'fake-cli.mjs');
    fs.writeFileSync(fake, [
      "process.stdin.resume();",
      "console.log(JSON.stringify({ type: 'session', sessionId: 'fake-1' }));",
      "setTimeout(() => {}, 60000);",
    ].join('\n'), 'utf8');
    process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'selftest-key';
    const brain = new HeadlessBrain({ node: process.execPath, cli: fake, workspace: dir, timeoutMs: 1200 });
    let msg = '';
    try {
      await brain.run({ prompt: '随便' });
    } catch (err) {
      msg = String(err?.message || err);
    }
    ok('假 cli 挂住会超时', msg.includes('headless 超时'));
    ok('超时说得出最后一条事件', msg.includes('最后一条事件 session'));
    ok('超时带停顿秒数和条数', /在 \d+s 前，共 1 条/.test(msg));
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ── 引用的是张图：路径得摆出来 ──────────────────────────
// 19:11 他发了张图问「你知道我说的是哪一张吗」——被引用的图只写「[图片]」，
// 她等于没看见。现在把落盘路径一起带进引用行，而且不截断。
{
  const recent = [
    { msgId: '100', name: '先生', text: '[图片]', imageFiles: ['E:/ws/data/images/a-0.jpg'] },
    { msgId: '101', name: '先生', text: '看这张' },
  ];
  const q = resolveQuote({ replyId: '100' }, recent);
  ok('引用图时带上落盘路径', Boolean(q && q.text.includes('E:/ws/data/images/a-0.jpg')));
  ok('引用图不再只写 [图片]', Boolean(q && !q.text.includes('[图片]')));
  check('引用普通话原样返回', resolveQuote({ replyId: '101' }, recent).text, '看这张');
  check('引用捞不到返回 null', resolveQuote({ replyId: '999' }, recent), null);

  const longPath = `（附图：${'E:/ws/data/images/'.repeat(3)}a-0.jpg）`;
  const long = `看这张 ${longPath}`;
  check('带路径的引用不截断', shortenQuote(long), long);
  check('普通长引用仍截到 60', shortenQuote('x'.repeat(100)).length, 60);

  const line = renderTranscript([{ name: '她', text: '这是哪张', quoteText: long, quoteName: '先生' }]);
  ok('对话记录里路径完整没被切', line.includes(longPath));
}

// ── 被引用的是很老的图：兜底也要落盘带路径 ──────────────────
// 不在最近 50 条时走 get_msg，QQ 只回「[图片]」。现在当场下下来落盘，
// 用 withFiles 把路径接上去——跟最近 50 条那条路一样能 read_image。
{
  check('没图就原样返回', withFiles('看这张', []), '看这张');
  check('空正文带图只留附图', withFiles('[图片]', ['E:/ws/q-0.jpg']), '（附图：E:/ws/q-0.jpg）');
  check('多张图去重占位', withFiles('[图片][图片]', ['a.jpg', 'b.gif']), '（附图：a.jpg；b.gif）');
  check('有字有图空格分开', withFiles('看这个[图片]', ['a.jpg']), '看这个 （附图：a.jpg）');
  check('正文为空也能拼', withFiles('', ['a.jpg']), '（附图：a.jpg）');
}

// ── 群里别人发的图：闸放行 read_image，但只放行那几张 ──────────
// 2026-10-22 晚上她在群里一直说「打不开」：不是没路径，是闸把 read_image 也拦了。
{
  const { allowImageRead } = await import('../src/safety/rules.mjs');
  // 用例里的路径一律运行期拼：源码里不留字面盘符（2026-10-24 他要求
  // 「推送不要出现任何本机地址」）。被测函数内部全走 path.resolve，分支覆盖不变。
  const FIX = path.join(os.tmpdir(), 'img');
  const PROJ = path.join(os.tmpdir(), 'proj');
  const IMG_DIR = path.join(PROJ, 'data', 'images');
  const SECRET = path.join(os.tmpdir(), 'secret', 'x.jpg');
  const slash = (p) => p.replace(/\\/g, '/');
  const allowed = new Set([path.join(FIX, 'a.jpg')]);
  ok('别人发的图可以看', allowImageRead('read_image', { file_path: path.join(FIX, 'a.jpg') }, allowed));
  ok('换成正斜杠也认得', allowImageRead('read_image', { file_path: slash(path.join(FIX, 'a.jpg')) }, allowed));
  ok('别的路径不给看', !allowImageRead('read_image', { file_path: SECRET }, allowed));
  ok('别的工具一样不给', !allowImageRead('pwsh', { command: 'dir' }, allowed));
  ok('没给路径就当不给', !allowImageRead('read_image', {}, allowed));

  // 2026-10-23：他不在的时候她仍读不了群里的图——被概率唤醒时这一批没有图，
  // 而图是半小时前发的，早不在 allowed 里了。所以补一条：data/images 里的都能看。
  const { imageReadScope } = await import('../src/safety/rules.mjs');
  const dirs = [IMG_DIR];
  ok('这一批里的图：判成 batch',
    imageReadScope('read_image', { file_path: path.join(FIX, 'a.jpg') }, allowed, dirs) === 'batch');
  ok('老图在 data/images 里：判成 dir',
    imageReadScope('read_image', { file_path: path.join(IMG_DIR, '123-0.jpg') }, new Set(), dirs) === 'dir');
  ok('正斜杠写的老图也认',
    imageReadScope('read_image', { file_path: slash(path.join(IMG_DIR, '123-0.jpg')) }, new Set(), dirs) === 'dir');
  ok('data/images 之外的老图不给', imageReadScope('read_image', { file_path: path.join(PROJ, 'data', 'stickers', 'x.jpg') }, new Set(), dirs) === '');
  ok('名字蹭前缀的不给', imageReadScope('read_image', { file_path: path.join(PROJ, 'data', 'images2', 'x.jpg') }, new Set(), dirs) === '');
  ok('目录本身不算一张图', imageReadScope('read_image', { file_path: IMG_DIR }, new Set(), dirs) === '');
  ok('别的工具就算在 data/images 里也不放',
    imageReadScope('pwsh', { file_path: path.join(IMG_DIR, '1-0.jpg') }, new Set(), dirs) === '');
}


// ── 口吻样例：从她自己的旧话里挑短的、像人话的 ────────────────
// 人设漂走的机制是「照着最近的自己继续说」；把好的旧话钉在眼前就是解药。
{
  const { isSample, pickSamples, voiceBlock } = await import('../src/body/voice.mjs');
  ok('短句能当样例', isSample('早呀 (˘ω˘)'));
  ok('太长不要（小作文会把她带成小作文）', !isSample('x'.repeat(120)));
  ok('带列表不要', !isSample('- 一二三'));
  ok('带路径不要', !isSample('存在 data/art 里了呀'));
  ok('带代码不要', !isSample('跑 `node x.mjs` 就行'));
  const picked = pickSamples([
    { dir: 'out', text: '早呀' },
    { dir: 'in', text: '这是别人说的' },
    { dir: 'out', text: '我先收工啦。' },
    { dir: 'out', text: 'y'.repeat(200) },
  ], { n: 2 });
  ok('只挑她自己说的、且短', picked.length === 2 && picked.every((x) => x.length < 50));
  ok('没有样例就不拼这一段', voiceBlock([]) === '');
  ok('样例段落带标题', voiceBlock(['早呀']).includes('你平时说话的样子'));

  // 私聊 / 群聊分开挑，别打架：房间 → 同类 → 全局，逐级兜底
  const v = await import('../src/body/voice.mjs');
  const store = { global: ['全局一句'], private: ['私聊一句'], group: ['群聊一句'], rooms: { 'group:42': ['这个房间专属'] } };
  ok('群房间优先用房间自己的', v.samplesFor(store, 'group:42').samples[0] === '这个房间专属');
  ok('别的群用群聊那份', v.samplesFor(store, 'group:99').samples[0] === '群聊一句');
  ok('私聊用私聊那份', v.samplesFor(store, 'private:7').samples[0] === '私聊一句');
  ok('两档都没设才用全局', v.samplesFor({ global: ['兜底'], private: [], group: [], rooms: {} }, 'private:7').samples[0] === '兜底');
  ok('全都没有就不带', v.samplesFor({ global: [], private: [], group: [], rooms: {} }, 'group:1').samples.length === 0);
  ok('私聊挑的样例不会串到群里', (() => {
    const pool = [
      { dir: 'out', room: 'private:1', text: '私聊里的软话' },
      { dir: 'out', room: 'group:1', text: '群里的话' },
    ];
    const onlyGroup = v.pickSamples(pool.filter((e) => v.kindOfRoom(e.room) === 'group'), { n: 3 });
    return onlyGroup.length === 1 && onlyGroup[0] === '群里的话';
  })());
  // 老格式（数组）要能读回来，别把已经存好的样例读丢
  const tmpFile = path.join(ROOT, 'tmp', 'voice-selftest.json');
  fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
  fs.writeFileSync(tmpFile, JSON.stringify(['老格式一句']));
  ok('老格式当全局读', v.loadStore(tmpFile).global[0] === '老格式一句');
  v.saveStore(tmpFile, { global: [], private: ['私聊'], group: [], rooms: {} });
  ok('分档存得住', v.loadStore(tmpFile).private[0] === '私聊');
  fs.rmSync(tmpFile);
}

// ── 回看时她自己的长回复只留开头 ────────────────────────────
{
  const long = 'z'.repeat(200);
  const mine = renderTranscript([{ dir: 'out', name: '她', text: long }]);
  const his = renderTranscript([{ dir: 'in', name: '他', text: long }]);
  ok('自己的长话被截断', mine.includes('……（后面还说了一些）') && mine.length < 120);
  ok('别人的长话不截', his.includes(long));
}

// ── 人格三层真的拼进提示词 ──────────────────────────────
// 为什么要单测这一段：2026-10-22 之前 core.md 一直以为「DSH 会按 AGENTS.md 自动加载」，
// 结果 14KB 一次都没进过提示词，谁也没发现——直到她自己读了自己的卡。
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qad-persona-'));
  fs.writeFileSync(path.join(dir, 'core.md'), 'CORE-内容');
  fs.writeFileSync(path.join(dir, 'group.md'), 'GROUP-内容');
  fs.writeFileSync(path.join(dir, 'self.md'), 'SELF-内容');

  const own = personaNoteFor({ isOwner: true, isGroup: false, dir });
  ok('主人的私聊带核心人设', own.includes('【核心人设】') && own.includes('CORE-内容'));
  ok('主人的私聊带她自己那份', own.includes('【我自己的部分】') && own.includes('SELF-内容'));
  ok('主人的私聊不带群聊手册', !own.includes('GROUP-内容'));

  const ownGroup = personaNoteFor({ isOwner: true, isGroup: true, dir });
  ok('主人的群里三份都带', ownGroup.includes('CORE-内容') && ownGroup.includes('GROUP-内容') && ownGroup.includes('SELF-内容'));

  const other = personaNoteFor({ isOwner: false, isGroup: true, dir });
  ok('外人看不到核心人设和她自己那份', !other.includes('CORE-内容') && !other.includes('SELF-内容'));
  ok('外人只拿对外那份群聊手册', other.includes('【对外的人设') && other.includes('GROUP-内容'));
  ok('外人不被叫作先生', other.includes('不是先生本人'));

  const logged = [];
  personaNoteFor({ dir, log: (m) => logged.push(m) });
  ok('拼完会留一行日志（面板里看得见）', logged.length === 1 && logged[0] === '主人 · 核心人设');

  // 文件没了也不能炸，只是少一段
  fs.rmSync(path.join(dir, 'core.md'));
  ok('core 不在时不报错、少一段', !personaNoteFor({ dir }).includes('【核心人设】'));
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 事件流：只读尾巴，结果要跟整份读一样 ─────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qad-events-'));
  const log = new EventLog({ dir });
  const days = ['2026-10-21', '2026-10-22', '2026-10-23'];
  const counts = [5, 900, 9];        // 中间那天故意造得比一次读的块大
  const all = [];
  days.forEach((d, di) => {
    const lines = [];
    for (let i = 0; i < counts[di]; i += 1) {
      const ts = new Date(`${d}T12:00:00`).getTime() + i;
      const rec = { eid: `ev_${di}_${i}`, ts, room: i % 5 === 0 ? 'group:b' : 'group:a', text: `${i}` };
      lines.push(JSON.stringify(rec));
      all.push(rec);
    }
    fs.writeFileSync(path.join(dir, `events-${d}.jsonl`), lines.join('\n') + '\n');
  });
  const naive = (limit, room) => all.filter((r) => !room || r.room === room).slice(-limit);
  check('事件流：最近 3 条', log.readRecent({ limit: 3 }), naive(3));
  check('事件流：跨天取 40 条', log.readRecent({ limit: 40 }), naive(40));
  check('事件流：按房间筛', log.readRecent({ room: 'group:b', limit: 6 }), naive(6, 'group:b'));
  check('事件流：要的比有的多', log.readRecent({ limit: 5000 }).length, all.length);

  const longText = 'z'.repeat(200000);   // 一行比一次读的块还长
  fs.appendFileSync(path.join(dir, 'events-2026-10-23.jsonl'), JSON.stringify({ eid: 'ev_long', ts: 1, room: 'group:long', text: longText }) + '\n');
  const last = log.readRecent({ limit: 1 })[0];
  check('事件流：超长行读得全', last?.eid === 'ev_long' && last.text.length === longText.length, true);

  const since = new Date('2026-10-22T12:00:30').getTime();
  const sinceNaive = all.filter((r) => r.ts >= since).length;
  check('事件流：readSince 跳过旧的天', log.readSince(since).length, sinceNaive);
  check('事件流：readSince 0 是全量', log.readSince(0).length, all.length + 1);
  check('事件流：还没收过消息时不炸', new EventLog({ dir: path.join(dir, 'none') }).readRecent({ limit: 3 }), []);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 模型（src/brain/model.mjs）───────────────────────────
{
  const { parseDefaultModel, writeModelPatch, providerIdOk, keyEnvName, parseProviderIds, providerEnv, readCredentialRef } = await import('../src/brain/model.mjs');
  const fake = [
    '- id: jobs',
    '  name: x',
    '- id: agent-default-model',
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    '  config:',
    '    provider: deepseek-official',
    '    model: deepseek-flash',
    '- id: llm-retry',
  ].join('\n');
  check('模型：能从 dump-config 里挑出默认 provider/model', parseDefaultModel(fake), { provider: 'deepseek-official', model: 'deepseek-flash' });
  check('模型：没有那一块就返回空', parseDefaultModel('- id: jobs'), { provider: '', model: '' });
  check('模型：注释行与引号也能认', parseDefaultModel([
    '- id: agent-default-model',
    '  # 这是注释',
    '  config:',
    "    provider: 'aicost'",
    '    model: "claude-opus-5-5"',
  ].join('\n')), { provider: 'aicost', model: 'claude-opus-5-5' });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qad-model-'));
  const f = writeModelPatch(dir, { provider: 'tokenrhythm', model: 'deepseek-v4.1-flash-1017' });
  check('模型：写 patch 文件', Boolean(f && fs.existsSync(f)), true);
  const body = f ? fs.readFileSync(f, 'utf8') : '';
  check('模型：patch 里的 provider 对', /provider: tokenrhythm/.test(body), true);
  check('模型：patch 里的 model 对', /model: deepseek-v4\.1-flash-1017/.test(body), true);
  // 自己加的提供商：写进同一份 patch，密钥走环境变量
  const pf = writeModelPatch(dir, {
    provider: 'acme-gateway',
    model: 'gpt-x',
    providers: {
      'acme-gateway': {
        displayName: '中转站',
        api: 'openai-completions',
        baseURL: 'https://gateway.example/v1',
        apiKeyRef: 'ACME_KEY',
        models: ['gpt-x'],
      },
    },
  });
  const pfBody = pf ? fs.readFileSync(pf, 'utf8') : '';
  check('提供商：patch 里有 llm-pi-ai 那段', /- id: llm-pi-ai/.test(pfBody), true);
  check('提供商：apiKeyEnv 按 id 派生', /apiKeyEnv: QAD_LLM_KEY_ACME_GATEWAY/.test(pfBody), true);
  check('提供商：baseURL 写进去了', /baseURL: https:\/\/gateway\.example\/v1/.test(pfBody), true);
  check('提供商：模型 id 写进去了', /- id: gpt-x/.test(pfBody), true);
  check('提供商：id 不合法的不往里写', writeModelPatch(dir, { providers: { Bad: { baseURL: 'https://x' } } }), null);
  check('提供商：id 校验', [providerIdOk('acme-gateway'), providerIdOk('Acme'), providerIdOk('a'), providerIdOk('9x')],
    [true, false, false, false]);
  check('提供商：环境变量名', keyEnvName('acme-gateway'), 'QAD_LLM_KEY_ACME_GATEWAY');
  check('提供商：从 dump-config 里认出已有名单', parseProviderIds([
    '- id: llm-pi-ai',
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    '  config:',
    '    providers:',
    '      aicost:',
    '        baseURL: https://a/v1',
    '      tokenrhythm:',
    '        baseURL: https://t/v1',
    '- id: next-one',
  ].join('\n')), ['aicost', 'tokenrhythm']);
  check('提供商：面板填的 key 优先', providerEnv({ x: { apiKey: 'sk-1' } }).QAD_LLM_KEY_X, 'sk-1');
  check('提供商：没有 key 也没有 ref 就不塞环境变量', Object.keys(providerEnv({ y: { apiKeyRef: '' } })).length, 0);
  check('提供商：读 DSH 凭据里的 ref', readCredentialRef('NO_SUCH_REF_THANKS'), '');

  check('模型：不指定就不写 patch（用 profile 默认）', writeModelPatch(dir, {}), null);
  check('模型：只填一半也不写', writeModelPatch(dir, { provider: 'aicost' }), null);
  // 三个槽位各写各的文件——同时跑的两轮不能互相把对方的模型改掉
  const fa = writeModelPatch(dir, { provider: 'aicost', model: 'claude-opus-5-5' }, 'model-patch-aaaa.yml');
  const fb = writeModelPatch(dir, { provider: 'aicost', model: 'deepseek-v4.1-flash' }, 'model-patch-bbbb.yml');
  check('模型：决策/看图各用一份 patch，文件名不同', [fa && fa !== fb, (fa || '').endsWith('model-patch-aaaa.yml'), (fb || '').endsWith('model-patch-bbbb.yml')], [true, true, true]);
  check('模型：两份 patch 里各自记着自己的模型', [
    fs.readFileSync(fa, 'utf8').includes('claude-opus-5-5'),
    fs.readFileSync(fb, 'utf8').includes('deepseek-v4.1-flash'),
    fs.readFileSync(fa, 'utf8').includes('model-patch-aaaa.yml'),
  ], [true, true, true]);
  fs.rmSync(dir, { recursive: true, force: true });
}
// ── 「她正忙的时候他插一句」─────────────────────────────
{
  const { asidePrompt, describeDoing } = await import('../src/body/aside.mjs');
  check('先回一句：工具名翻成中文', describeDoing(['read_image', 'pwsh', 'read_image']), '看图、跑命令');
  check('先回一句：没动过工具也有话说', describeDoing([]), '想了想事情');
  check('先回一句：不认识的工具原样留着', describeDoing(['sticker_screen']), 'sticker_screen');
  const p = asidePrompt({
    personaNote: '【你自己】喜欢被叫小鲸鱼',
    doing: '看图、跑命令',
    minutes: 3.4,
    ownerText: '在吗',
  });
  check('先回一句：提示词里带上她在忙什么', p.includes('正在看图、跑命令'), true);
  check('先回一句：提示词里带上他说的话', p.includes('他刚说：在吗'), true);
  check('先回一句：分钟数取整', p.includes('已经做了 3 分钟'), true);
  check('先回一句：要求只回一句、不超过 40 字', p.includes('不超过 40 字'), true);
  check('先回一句：人设垫在最前面', p.startsWith('【你自己】'), true);
}
// ── 面板热生效：改了配置，组件手里那份也得跟着变 ──────────
// 以前这些是构造时拷进去的，面板改完要重启桥才认（2026-10-23 踩过）。
{
  const sender = new Sender({ client: null, maxLen: 100, gapMs: 10, split: { enabled: true, softMax: 50 } });
  check('热生效：发送器改之前单条上限', sender.maxLen, 100);
  sender.reconfigure({ maxLen: 2000, gapMs: 0, split: { enabled: false } });
  check('热生效：发送器换单条上限', sender.maxLen, 2000);
  check('热生效：发送器换分句开关', sender.split.enabled, false);
  check('热生效：发送器没传的字段不动', sender.gapMs, 0);

  const cd = new PokeCooldown(1000);
  cd.mark('r', 0);
  ok('热生效：戳一戳改之前 1 秒内算冷却', cd.hot('r', 500) === true);
  cd.setMs(100);
  ok('热生效：戳一戳改成 100ms 后不再冷却', cd.hot('r', 500) === false);

  const live = { owner: { userIds: [] }, group: { keywords: ['早'] } };
  const routerLive = createRouter({ cfg: live, now: () => 0 });
  check('热生效：router 关键词现读', routerLive.keywords, ['早']);
  live.group.keywords = ['晚安', '  '];
  check('热生效：改完 group.keywords 不用重造 router', routerLive.keywords, ['晚安']);

  const brainLive = new HeadlessBrain({ model: 'old' });
  brainLive.reconfigure({ model: 'new' });
  check('热生效：headless 换模型', brainLive.cfg.model, 'new');

  // 重活脑子外面套的那层壳（main.mjs 的 withModel）：壳只管「用哪个模型」，
  // 别的都得透过去。早前是手写白名单只转发 kind + run，2026-10-24 交接纸条
  // 就因为 kind 丢了、一张都没写成；补上 kind 之后 reconfigure 还在名单外，
  // 所以改成挂原型链——这两条守的就是那个契约。
  const shellBase = new HeadlessBrain({ model: 'x' });
  const shell = Object.create(shellBase);
  shell.run = (opts) => shellBase.run(opts);
  check('套壳：kind 透得过去（交接纸条靠它认是不是 headless）', shell.kind, 'headless');
  check('套壳：reconfigure 也透得过去', typeof shell.reconfigure, 'function');
  const mainSrc = fs.readFileSync(path.join(ROOT, 'src/main.mjs'), 'utf8');
  ok('套壳：withModel 不再是手写白名单', /const shell = Object\.create\(base\)/.test(mainSrc) && !/kind: base\.kind/.test(mainSrc));
}

// ── 她手头的事 / 她也会困 ─────────────────────────────────
// 这两层都是「让她有自己的日子」，所以判错的代价不是报错，是穿帮。
{
  const atHour = (h) => new Date(2026, 9, 24, h, 30, 0, 0).getTime();

  ok('困：凌晨三点算在睡区间里', restState({ enabled: true, from: 1, to: 7 }, atHour(3)) !== null);
  check('困：中午不在睡区间', restState({ enabled: true, from: 1, to: 7 }, atHour(12)), null);
  ok('困：跨零点（23~5）凌晨两点算睡着', restState({ enabled: true, from: 23, to: 5 }, atHour(2)) !== null);
  ok('困：跨零点（23~5）下午两点算醒着', restState({ enabled: true, from: 23, to: 5 }, atHour(14)) === null);
  check('困：关掉就不困', restState({ enabled: false, from: 1, to: 7 }, atHour(3)), null);
  check('困：醒着时提示词是空的', restLine({ enabled: true, from: 1, to: 7 }, atHour(12)), '');
  ok('困：睡着时提示词不是空的', restLine({ enabled: true, from: 1, to: 7 }, atHour(3)).length > 0);

  const f = path.join(os.tmpdir(), `qad-doing-${process.pid}.json`);
  fs.rmSync(f, { force: true });
  const doing = new Doing({ file: f, cfg: { defaultMinutes: 20, afterMinutes: 30 }, logger: () => {} });
  check('在忙：没写过就是空', doing.read(), null);
  doing.set('洗澡', 10);
  const st = doing.read();
  check('在忙：记下她在做什么', st.doing, '洗澡');
  ok('在忙：还算得出来剩多久', st.leftMs > 0);
  ok('在忙：不是刚忙完', st.justDone === false);
  doing.clear();
  const st2 = doing.read();
  ok('在忙：说忙完了先进「刚忙完」', st2.justDone === true);
  fs.rmSync(f, { force: true });

  const fake = [
    { id: 'a', kind: '事实', text: '先生今天在改桥的配置面板', room: 'p' },
    { id: 'b', kind: '事实', text: '先生今天在改桥的配置面板！', room: 'p' },
    { id: 'c', kind: '事实', text: '先生明天要去看牙', room: 'p' },
    { id: 'd', kind: '约定', text: '不叫醒先生', room: 'p' },
    { id: 'e', kind: '约定', text: '不叫醒先生', room: 'p' },
  ];
  const { kept, dups } = dedupe(fake);
  check('去重：同一句话两条只留一条', dups.length, 1);
  check('去重：并进先记的那条', dups[0].into, 'a');
  ok('去重：不相干的条目不动', kept.some((x) => x.id === 'c'));
  check('去重：约定一个字都不碰', kept.filter((x) => x.kind === '约定').length, 2);
}
// ── 自由活动停表：他在跟她聊，这段时间就不该白烧 ──────────
// 以前只是「这一拍让路」，他聊十分钟，她那半小时就少了十分钟——
// 而她那半小时的用处本来就是「他不在的时候她有自己的日子」。
{
  let ownerBusy = true;
  const ft = new FreeTime({
    cfg: {
      freeTime: {
        beatMs: 60000, skipIfActiveMs: 300000, pauseWhileOwnerChats: true,
        pauseCheckMs: 40, durationMs: 1800000, maxMessages: 3, permission: 'look',
      },
    },
    brain: { run: async () => ({ text: '<done/>' }) },
    send: async () => {},
    logger: () => {},
    room: 'private:1',
    roomState: () => (ownerBusy
      ? { lastDir: 'in', lastTs: Date.now() }
      : { lastDir: 'in', lastTs: Date.now() - 400000 }),
  });
  const s0 = ft.start({ minutes: 30 }).status;
  check('停表：刚开始表在走', s0.paused, false);
  await new Promise((r) => setTimeout(r, 2100));
  const s1 = ft.status();
  check('停表：他在说话就先停下', s1.paused, true);
  check('停表：停下期间到点时间不往前跑', s1.endsAt, s0.endsAt);
  ownerBusy = false;
  // 停表期间的检查间隔被 #schedule 的 1 秒下限夹住，等过它
  await new Promise((r) => setTimeout(r, 1300));
  const s2 = ft.status();
  check('停表：他安静了就继续', s2.paused, false);
  ok('停表：把停掉的那段时间还给她（顺延）', s2.endsAt > s1.endsAt);
  ft.stop('测试结束');
}

// ── 一轮没跑完 ────────────────────────────────────────────
// 2026-10-24 21:42 她画图连撞两次超时，整轮作废、一个字都没发出去，
// 他对着手机等了四十分钟。这几条守的是「失败必须能被说出来」。
{
  const why = 'headless 超时（300000ms，最后一条事件 tool_call 在 263s 前，共 20 条 / 9KB）';
  const again = stallNote(why);
  ok('没跑完：把卡在哪一步带给她', again.includes('tool_call 在 263s 前'));
  ok('没跑完：让她自己定重试还是说实话', again.includes('你自己定'));
  const last = stallNote(why, { retry: false });
  ok('没跑完：连着两轮之后不让她再动手', last.includes('不要再调用任何工具'));
  ok('没跑完：两种都从「刚才那一轮没跑完」起头', again.startsWith('【刚才那一轮没跑完】') && last.startsWith('【刚才那一轮没跑完】'));
  ok('没跑完：原因长得离谱就截断', stallNote('x'.repeat(2000)).length < 500);
  ok('没跑完：没有原因也不空着', stallNote('').includes('没有原因'));

  ok('没跑完：默认有一句能发出去', stallNote('x').trim().length > 0);

  // 三轮全塌时不替她说话：只记一笔，等她下次开口自己提。
  const book = new FailBook();
  check('兜底：没塌过就是空的', book.take('private:1'), '');
  book.add('private:1', {
    why: 'headless 超时（300000ms，最后一条事件 tool_call 在 263s 前）',
    said: '欸～还没画好嘛～',
    tools: ['sd_server', 'sd_server', 'sd_txt2img', 'sd_txt2img'],
  });
  const recalled = book.take('private:1');
  ok('兜底：下次开口时提得起来', recalled.includes('上一次卡在这儿') && recalled.includes('tool_call 在 263s 前'));
  ok('兜底：先说清那是件什么事（他当时说的话）', recalled.includes('欸～还没画好嘛～'));
  ok('兜底：说清她停在哪个工具上', recalled.includes('sd_txt2img'));
  book.add('private:4', { why: 'X', tools: ['a', 'b', 'c', 'd', 'e'] });
  ok('兜底：工具只留最后三个', !book.take('private:4').includes('a → '));
  ok('兜底：交给她自己决定提不提', recalled.includes('不想提也行') && recalled.includes('别当成做完了'));
  check('兜底：只提醒一次，取过就没了', book.take('private:1'), '');
  check('兜底：别的房间不受影响', book.take('group:9'), '');
  book.add('private:3', { why: '只是超时' });
  ok('兜底：没有上下文也不崩', book.take('private:3').includes('只是超时'));
  book.add('private:2', { why: '两小时前的' });
  check('兜底：过了六小时就不翻旧账', book.take('private:2', Date.now() + 7 * 3600_000), '');

  const msrc = fs.readFileSync(path.join(ROOT, 'src/main.mjs'), 'utf8');
  ok(
    '兜底：main 里真的接了三轮',
    msrc.includes('stallNote(why1)') &&
      msrc.includes('stallNote(why2, { retry: false })') &&
      msrc.includes('fails.add(roomKey, {'),
  );
  ok('兜底：塌了也不冒充她说话', !msrc.includes('failureLine'));
  ok(
    '兜底：群里连失败的话术都不给',
    msrc.includes("asGroup ? '' : stallNote(why1)") && msrc.includes("asGroup ? '' : fails.take(roomKey)"),
  );
  ok('兜底：群里两轮没跑完就到此为止', /if \(asGroup\) \{\s*clearTimeout\(ackTimer\);\s*return;/.test(msrc));
}

// ── 退出码非 0 但这一轮成了 ────────────────────────────────
// 2026-10-24 光 upkeep/distill 就因此白丢五轮；2026-10-25 09:14 体检那次 final 里一个字
// 都没有，也被当成崩了。判据必须是两条独立证据，缺一条就算失败。
{
  ok('退出码：final 到过、没有 error → 算成', finishedDespiteExit({ sawFinal: true, errors: [] }));
  ok('退出码：errors 没传也算没有 error', finishedDespiteExit({ sawFinal: true }));
  ok('退出码：有 error 就不算成', !finishedDespiteExit({ sawFinal: true, errors: ['boom'] }));
  ok('退出码：final 根本没到 → 不算成', !finishedDespiteExit({ sawFinal: false, errors: [] }));
  ok('退出码：没 final 又有 error → 不算成', !finishedDespiteExit({ sawFinal: false, errors: ['boom'] }));
  ok('退出码：什么都不给 → 不算成，也不崩', !finishedDespiteExit());
  ok('退出码：errors 是个脏东西 → 当失败，别当没有 error', !finishedDespiteExit({ sawFinal: true, errors: 'boom' }));

  const hsrc = fs.readFileSync(path.join(ROOT, 'src/brain/headless.mjs'), 'utf8');
  ok('退出码：不用「最后一条事件是不是 final」判（会被后续事件顶掉）', !hsrc.includes("lastEventKind === 'final'"));
  ok('退出码：看到 final 就记一笔，后面来什么都顶不掉', hsrc.includes('sawFinal = true'));
}

// ── 记忆写在"你"的视角 ─────────────────────────────────────
// 2026-10-25 之前提要里写的是「第三人称」，于是她每天读几百条「她要…」「小鲸鱼…」，
// 读自己的记忆像读别人的档案。改成第一人称视角之后，注入那边一个字都不用动。
{
  const dsrc = fs.readFileSync(path.join(ROOT, 'src/memory/distill.mjs'), 'utf8');
  ok('记忆：要写成"我"的视角（本鲸也行）', dsrc.includes('"我"的视角'));
  ok('记忆：不许再要求第三人称', !dsrc.includes('第三人称'));
}

// ── 她自己决定这轮要不要整套工具 ────────────────────────────
// 2026-10-26：他问「能不能让她自己判断这轮该不该调用完整工具集」。
// 判据不能靠正则猜（那天她说「这轮没看到这个工具」，正则一条都没命中），
// 于是改成：轻装那轮告诉她工具不全，需要就自己说一声，回话后换档重跑。
{
  ok('换档：认得出「我要用全套工具」', wantsFullTools('我要用全套工具'));
  ok('换档：认得出她说缺工具那段话', wantsFullTools('这轮没看到这个工具，我要用全套工具'));
  ok('换档：认得出 <full/> 标记', wantsFullTools('<full/>'));
  ok('换档：平时说话不误判', !wantsFullTools('我给你画吧，等我一下'));
  ok('换档：只是问「全套工具是什么」不算要换', !wantsFullTools('全套工具是什么'));
  ok('换档：轻装那一轮要告诉她工具不全', String(LIGHT_HINT || '').includes('我要用全套工具'));
  const msrc2 = fs.readFileSync(path.join(ROOT, 'src/main.mjs'), 'utf8');
  ok('换档：说出口之后就真的重跑一次', msrc2.includes('换档重跑这一轮'));
  ok('换档：重跑用的是不带提示的那份提示词', msrc2.includes('promptNoHint'));
}

// ── 结果 ────────────────────────────────────────────────
if (fails.length) {
  console.log(`✗ ${fails.length} 个失败 / ${pass} 个通过\n`);
  for (const f of fails) console.log('  ✗ ' + f + '\n');
  process.exit(1);
}
console.log(`✓ ${pass} 项全过`);
