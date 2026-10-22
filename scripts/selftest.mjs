// 自测：不用真的连 QQ，把合成事件喂进管道看判断对不对。
// node scripts/selftest.mjs
import { normalizeEvent, resolveQuote, shortenQuote, renderTranscript, withFiles } from '../src/body/room.mjs';
import { createRouter } from '../src/body/router.mjs';
import { toPlain, splitMessage } from '../src/util/text.mjs';
import { StickerLibrary } from '../src/stickers/library.mjs';
import { openingMood, draftLines, shouldYield } from '../src/body/freetime.mjs';
import { UsageStore, describeUsage } from '../src/usage/store.mjs';
import { buildPrompt, buildTriggerLines } from '../src/body/prompt.mjs';
import { selfLines, agoLabel } from '../src/memory/context.mjs';
import { SerialQueue } from '../src/body/queue.mjs';
import { ROOT } from '../src/config.mjs';
import { handoverPrompt, cleanHandover } from '../src/memory/handover.mjs';
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
  check('账本：落盘一天一个文件', fs.existsSync(path.join(dir, 'usage-' + new Date().toISOString().slice(0, 10) + '.jsonl')), true);
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
  const allowed = new Set([String.raw`E:\img\a.jpg`]);
  ok('别人发的图可以看', allowImageRead('read_image', { file_path: String.raw`E:\img\a.jpg` }, allowed));
  ok('换成正斜杠也认得', allowImageRead('read_image', { file_path: 'E:/img/a.jpg' }, allowed));
  ok('别的路径不给看', !allowImageRead('read_image', { file_path: String.raw`E:\secret\x.jpg` }, allowed));
  ok('别的工具一样不给', !allowImageRead('pwsh', { command: 'dir' }, allowed));
  ok('没给路径就当不给', !allowImageRead('read_image', {}, allowed));
}

// ── 结果 ────────────────────────────────────────────────
if (fails.length) {
  console.log(`✗ ${fails.length} 个失败 / ${pass} 个通过\n`);
  for (const f of fails) console.log('  ✗ ' + f + '\n');
  process.exit(1);
}
console.log(`✓ ${pass} 项全过`);
