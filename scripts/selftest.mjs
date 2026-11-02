// 自测：不用真的连 QQ，把合成事件喂进管道看判断对不对。
// node scripts/selftest.mjs
import { normalizeEvent, resolveQuote, shortenQuote, renderTranscript, withFiles } from '../src/body/room.mjs';
import { createRouter } from '../src/body/router.mjs';
import { cleanupImages, IMAGE_RE, VIDEO_RE } from '../src/media/cleanup.mjs';
import { toPlain, splitMessage, markdownImagesToTags, pullImagePaths } from '../src/util/text.mjs';
import { StickerLibrary, probeImage } from '../src/stickers/library.mjs';
import { FreeTime, openingMood, draftLines, shouldYield, shouldRotateFree, stripMarks, recentTalk } from '../src/body/freetime.mjs';
import { parseVerdicts, batchPrompt, screenStickers, makeSheet, uncutNote } from '../src/stickers/screen.mjs';
import { UsageStore, describeUsage } from '../src/usage/store.mjs';
import { buildPrompt, buildTriggerLines, videoHint, fitHistory, roughTokens, HISTORY_MAX_TOKENS } from '../src/body/prompt.mjs';

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
import { InterestStore } from '../src/interests/store.mjs';
import { dedupe, upkeep } from '../src/memory/upkeep.mjs';
import { stallNote, FailBook } from '../src/brain/stall.mjs';
import { findStart, staleFrom, assess, staleNote } from './probe-stale.mjs';
import { createStaleWatch } from '../src/util/stale-watch.mjs';
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
check('群里叫名字：realAt 假', grpName.realAt, false);
check('群里叫名字：calledMe 真', grpName.calledMe, true);
check('群里@我：realAt 真', grpAt.realAt, true);
check('群里@我：calledMe 假（没叫名字）', grpAt.calledMe, false);

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

// 两个开关各管各的：面板上「@ 我 必回」「叫名字 必回」以前声明了却没人读（2026-11-02 审计发现）
{
  const noAt = createRouter({ cfg: { ...cfg, group: { ...(cfg.group || {}), speakOnAt: false } } });
  check('关掉「@ 我」：真 @ 不再直接回', noAt.decide({ kind: 'group', room: 'ga1', from: '42', atMe: true, realAt: true }).speak, false);
  check('关掉「@ 我」：叫名字照样回', noAt.decide({ kind: 'group', room: 'ga2', from: '42', atMe: true, realAt: false, calledMe: true }).speak, true);

  const noName = createRouter({ cfg: { ...cfg, group: { ...(cfg.group || {}), speakOnName: false } } });
  check('关掉「叫名字」：叫名字不再直接回', noName.decide({ kind: 'group', room: 'gn1', from: '42', atMe: true, realAt: false, calledMe: true }).speak, false);
  check('关掉「叫名字」：真 @ 照样回', noName.decide({ kind: 'group', room: 'gn2', from: '42', atMe: true, realAt: true }).speak, true);
}

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
// Markdown 图片得转成发图标记，不然 toPlain 会把路径吃干净（2026-10-29 连着两次踩到）
check('Markdown 图片转标记',
  markdownImagesToTags('看图 ![鲸鱼](C:\\pics\\whale.png) 就这样'),
  '看图 [[img:C:\\pics\\whale.png]] 就这样');
check('Markdown 图片尖括号路径',
  markdownImagesToTags('![x](<C:\\a b\\c.png>)'),
  '[[img:C:\\a b\\c.png]]');
check('Markdown 图片带标题',
  markdownImagesToTags('![x](C:\\a.png "说明")'),
  '[[img:C:\\a.png]]');
check('普通文字不动', markdownImagesToTags('就这样'), '就这样');

// 自由活动那条路的抠图：2026-10-29 连着两次踩到（图只剩一句说明、
// [[img:]] 原样当字发出去）。当时这函数埋在 main.mjs 里，selftest 够不着；
// 2026-10-30 挪到 util/text.mjs，这儿才开始守得住。
check('抠出 Markdown 图，正文只留字',
  JSON.stringify(pullImagePaths('看图 ![鲸鱼](C:\\pics\\whale.png) 就这样')),
  JSON.stringify({ text: '看图  就这样', paths: ['C:\\pics\\whale.png'] }));
check('抠出 [[img:]] 写法',
  JSON.stringify(pullImagePaths('[[img:C:\\pics\\cat.gif]]')),
  JSON.stringify({ text: '', paths: ['C:\\pics\\cat.gif'] }));
check('两种写法混着来，顺序照出现',
  JSON.stringify(pullImagePaths('先看图 ![x](<C:\\a b\\c.png>) 再说 [[img:"C:\\d.png"]]')),
  JSON.stringify({ text: '先看图  再说', paths: ['C:\\a b\\c.png', 'C:\\d.png'] }));
check('一行只有图，正文就空',
  JSON.stringify(pullImagePaths('![a](C:\\1.png)\n![b](C:\\2.png)')),
  JSON.stringify({ text: '', paths: ['C:\\1.png', 'C:\\2.png'] }));
check('没图时正文一个字不动',
  JSON.stringify(pullImagePaths('就这样，没有图')),
  JSON.stringify({ text: '就这样，没有图', paths: [] }));
check('只有空白也算没话说',
  JSON.stringify(pullImagePaths('  ')),
  JSON.stringify({ text: '', paths: [] }));

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
    { name: '某某', text: '你看这个 [视频]', videoFiles: ['C:/ws/data/videos/789-0.mp4'] },
  ]);
  ok('对话记录里带视频路径', line.includes('视频1：C:/ws/data/videos/789-0.mp4'));

  const trig = buildTriggerLines([
    { idx: 1, name: '某某', text: '[视频]', videoFiles: ['C:/ws/data/videos/789-0.mp4'], atMe: true },
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
    { idx: 1, name: '某某', text: '[图片]', imageFiles: ['C:/x/img1.jpg'], atMe: false },
    { idx: 2, name: '某某', text: '你看这个', imageFiles: ['C:/x/img2.gif'], atMe: false },
    { idx: 3, name: '某某', text: '没有图', atMe: false },
  ], { selfNames: ['小鲸鱼'] });
  ok('群里带图的消息给了真实路径', group[0].includes('C:/x/img1.jpg'));
  ok('群里带图的消息不再只剩 [图片] 占位', !group[0].includes('[图片]'));
  ok('群里带文字又带图，两样都在', group[1].includes('你看这个') && group[1].includes('C:/x/img2.gif'));
  ok('群里没图的消息不被乱加括号', !group[2].includes('图片1'));
}

// ── 表情库 ──────────────────────────────────────────────
// 用临时目录，绝不碰 data/stickers 里真那些图。
{
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-selftest-lib-'));
  const tmpDir = path.join(tmpRoot, 'library');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpRoot, 'library.json');
  // 8x8 的实心块。原来这里是个 1x1 的 PNG —— 2026-11-01 加了「空图不进库」之后
  // 那个 fixture 自己也成了空图，留着它就等于一边拦空图一边拿空图当样本。
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4sWUBVsQwtCQAydSHATA1Jj4AAAAASUVORK5CYII=',
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

  // 5. 刚收进来、还没分类的，不能被每小时的清理误删。
  //    2026-10-27 早上实测：清库每小时一次、补标签的体检 6 小时一次，
  //    07:30~08:37 进来的 6 张候选全在体检轮到它们之前被当成「没标签」删了。
  {
    const gDir = path.join(tmpRoot, 'grace');
    fs.mkdirSync(gDir, { recursive: true });
    const gFile = path.join(gDir, 'library.json');
    const H = 3600 * 1000;
    const mk = (id, ageH, extra = {}) => {
      fs.writeFileSync(path.join(gDir, `${id}.png`), Buffer.concat([png, Buffer.from(id)]));
      return {
        id, file: `grace/${id}.png`, bytes: 100, tags: [], when: '', ctx: '', from: '',
        addedAt: Date.now() - ageH * H, usedAt: null, used: 0, pending: true, ...extra,
      };
    };
    const items = [
      mk('k9001', 0),                                    // 刚进来的
      mk('k9002', 0),                                    // 也是刚进来的
      mk('k9003', 30),                                   // 一天多没分类，宽限期已过
      mk('k9004', 30, { pending: false, tags: ['旧'] }), // 有标签，但从没发过
    ];
    fs.writeFileSync(gFile, JSON.stringify({ items, seq: 9004, tombstones: [] }));
    const glib = new StickerLibrary({ file: gFile, dir: gDir, root: tmpRoot });
    const gout = glib.prune({ maxCount: 2, maxMb: 200 }, () => {});
    check('清库先清老的', gout.removed, 2);
    ok('刚收进来的没被当垃圾删掉', Boolean(glib.get('k9001') && glib.get('k9002')));
    ok('过期的待分类和没人用的旧标签先走', !glib.get('k9003') && !glib.get('k9004'));
  }

  // 5b. 宽限期是 24 小时，不是 6 小时。2026-11-01 早上睡了 13 小时，
  //     11:31 那次 prune 把三张一次都没被看过的待分类剪了——因为 6 小时
  //     的宽限期假设「我一直在看」。宽限期得撑过一整夜。
  {
    const gDir = path.join(tmpRoot, 'grace-night');
    fs.mkdirSync(gDir, { recursive: true });
    const gFile = path.join(gDir, 'library.json');
    const H = 3600 * 1000;
    const mk = (id, ageH, extra = {}) => {
      fs.writeFileSync(path.join(gDir, `${id}.png`), Buffer.concat([png, Buffer.from(id)]));
      return {
        id, file: `grace-night/${id}.png`, bytes: 100, tags: [], when: '', ctx: '', from: '',
        addedAt: Date.now() - ageH * H, usedAt: null, used: 0, pending: true, ...extra,
      };
    };
    const items = [
      mk('k9011', 20),                                   // 睡前进来的，一觉醒来还没被看过
      mk('k9012', 40, { pending: false, tags: ['旧'] }), // 有标签，但从没发过
    ];
    fs.writeFileSync(gFile, JSON.stringify({ items, seq: 9012, tombstones: [] }));
    const glib = new StickerLibrary({ file: gFile, dir: gDir, root: tmpRoot });
    glib.prune({ maxCount: 1, maxMb: 200 }, () => {});
    ok('睡一夜之后待分类还在', Boolean(glib.get('k9011')));
    ok('这种情况下走的是有标签没发过的旧图', !glib.get('k9012'));
  }

  // 6. 只有信封没有信的图不进库。
  //    2026-11-01 15:2x：一张 108 字节的 GIF89a 从正常入库路径进来，画布 300x300、
  //    里头三帧全是 1x1（三个不同图 ID 哈希一模一样，是同一个占位符换了三个信封）。
  //    sniffExt 只看前四个字节，拦不住；现在 add() 会用 probeImage 读一次真实尺寸。
  {
    const eDir = path.join(tmpRoot, 'empty');
    fs.mkdirSync(eDir, { recursive: true });
    const elib = new StickerLibrary({ file: path.join(eDir, 'library.json'), dir: eDir, root: tmpRoot });
    // 造一个结构合法的 GIF：画布 cw x ch，每帧 fw x fh
    const gif = (cw, ch, frames) => {
      const head = Buffer.alloc(7);
      head.writeUInt16LE(cw, 0);
      head.writeUInt16LE(ch, 2);
      const parts = [Buffer.from('GIF89a', 'latin1'), head];
      for (const [fw, fh] of frames) {
        const d = Buffer.alloc(10);
        d[0] = 0x2c;
        d.writeUInt16LE(fw, 5);
        d.writeUInt16LE(fh, 7);
        parts.push(d, Buffer.from([0x02, 0x02, 0x44, 0x01, 0x00]));
      }
      parts.push(Buffer.from([0x3b]));
      return Buffer.concat(parts);
    };
    const empty = gif(300, 300, [[1, 1], [1, 1], [1, 1]]);
    let rejected = '';
    try { elib.add({ src: blurp('empty.gif', empty), tags: [] }); } catch (e) { rejected = e.message; }
    ok('空 GIF 被拦住', rejected.includes('没有画面'));
    check('空 GIF 没占编号', elib.stats().count, 0);
    const real = elib.add({ src: blurp('real.gif', gif(64, 64, [[64, 64], [64, 64]])), tags: ['动图'] });
    ok('画得出来的动图照收', real.dup === false && real.item.file.endsWith('.gif'));
    check('动图帧数读得出来', probeImage(real.item.abs).frames.length, 2);
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

// ── 刚才那一屏是答过的：别让新一轮再答一遍 ─────────────────
// 2026-10-28 01:03 他说「想和你一起睡」，01:03:47 答过一次；01:03:35 那张图另起一轮时，
// 「刚才在这儿的对话」里还带着那句话，于是 01:04:26 又答了同一个点。
{
  const older = [{ kind: 'private', from: '1', fromName: '先生', text: '想和你一起睡' }];
  const now = [{ kind: 'private', from: '1', fromName: '先生', text: '[图片]' }];
  const p = buildPrompt({ roomKey: 'private:1', messages: now, recent: [...older, ...now] });
  ok('答过的别再答：有「刚才的对话」就有那句提醒', p.includes('别再答第二遍'));
  ok('答过的别再答：那句话本身还在（不能把上下文删掉）', p.includes('想和你一起睡'));
  const bare = buildPrompt({ roomKey: 'private:1', messages: now, recent: now });
  ok('答过的别再答：没有更早的对话就不加这句', !bare.includes('别再答第二遍'));
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
    const brain = new HeadlessBrain({ node: process.execPath, cli: fake, workspace: dir, timeoutMs: 1200, graceMs: 1 });
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

// ── 叫停：段收了就当场掐，不等超时 ────────────────────────
// 2026-10-26 22:24 那次：手动结束之后，底下那一轮没人管，一直跑到 300 秒上限
// （又给了 60 秒宽限），烧掉一百四十万 token，还在和新一段抢同一张图——
// tmp/ 里 ten-v11..v14 是它俩一起吐的。光「不发」不够，得让它停下来。
{
  const { HeadlessBrain } = await import('../src/brain/headless.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qad-selftest-abort-'));
  try {
    const beat = path.join(dir, 'beat.txt');
    const fake = path.join(dir, 'fake-cli.mjs');
    fs.writeFileSync(fake, [
      "import fs from 'node:fs';",
      `const beat = ${JSON.stringify(beat)};`,
      "process.stdin.resume();",
      "console.log(JSON.stringify({ type: 'session', sessionId: 'fake-abort' }));",
      "setInterval(() => fs.appendFileSync(beat, 'x'), 80);",
      "setTimeout(() => {}, 60000);",
    ].join('\n'), 'utf8');
    process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'selftest-key';
    const brain = new HeadlessBrain({ node: process.execPath, cli: fake, workspace: dir, timeoutMs: 5000, graceMs: 1 });
    const ctl = new AbortController();
    const t0 = Date.now();
    const p = brain.run({ prompt: '随便', signal: ctl.signal })
      .then(() => ({ code: 'OK' }), (e) => ({ code: String(e?.code || ''), msg: String(e?.message || e) }));
    await new Promise((r) => setTimeout(r, 400));
    ctl.abort();
    // 子进程真死了没有：它每 80ms 写一个字节，死了心跳就停。
    // 必须趁这一轮还没回来就量——等它自己超时被杀掉，这个数永远是对的（假的绿）。
    const beatLen = () => (fs.existsSync(beat) ? fs.readFileSync(beat, 'utf8').length : 0);
    const n1 = beatLen();
    await new Promise((r) => setTimeout(r, 500));
    const n2 = beatLen();
    const res = await p;
    const took = Date.now() - t0;
    check('叫停：错误码是 ABORTED', res.code, 'ABORTED');
    ok('叫停：不等超时，几百毫秒就回来', took < 3000);
    ok('叫停：子进程真的死了（心跳停了）', n2 - n1 <= 2);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ── 引用的是张图：路径得摆出来 ──────────────────────────
// 19:11 他发了张图问「你知道我说的是哪一张吗」——被引用的图只写「[图片]」，
// 她等于没看见。现在把落盘路径一起带进引用行，而且不截断。
{
  const recent = [
    { msgId: '100', name: '先生', text: '[图片]', imageFiles: ['C:/ws/data/images/a-0.jpg'] },
    { msgId: '101', name: '先生', text: '看这张' },
  ];
  const q = resolveQuote({ replyId: '100' }, recent);
  ok('引用图时带上落盘路径', Boolean(q && q.text.includes('C:/ws/data/images/a-0.jpg')));
  ok('引用图不再只写 [图片]', Boolean(q && !q.text.includes('[图片]')));
  check('引用普通话原样返回', resolveQuote({ replyId: '101' }, recent).text, '看这张');
  check('引用捞不到返回 null', resolveQuote({ replyId: '999' }, recent), null);

  const longPath = `（附图：${'C:/ws/data/images/'.repeat(3)}a-0.jpg）`;
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
  check('空正文带图只留附图', withFiles('[图片]', ['C:/ws/q-0.jpg']), '（附图：C:/ws/q-0.jpg）');
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
  // 2026-10-26 改回来：原来非主人整段摘掉 core/self，群里只要有个群友插过话，
  // 她的人设就只剩一份「怎么跟陌生人说话」的手册。core/self 现在永远在。
  ok('外人也带着核心人设（她始终是她自己）', other.includes('CORE-内容') && other.includes('SELF-内容'));
  ok('外人也带群聊手册', other.includes('GROUP-内容'));
  ok('外人不被叫作先生', other.includes('不是先生本人'));
  const otherPrivate = personaNoteFor({ isOwner: false, isGroup: false, dir });
  ok('私聊里的外人也带核心人设', otherPrivate.includes('CORE-内容') && otherPrivate.includes('SELF-内容'));
  ok('私聊里的外人也带群聊手册（收敛用）', otherPrivate.includes('GROUP-内容'));
  ok('私聊里的外人不被叫作先生', otherPrivate.includes('不是先生本人'));

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

  // 2026-10-28：体检时模型把输出上限全花在思考上，一个字都没吐（turn/end 记的是
  // max-tokens），原来这里解析空串得到 []，日志照写「体检 364 条 → 0/0/0/0」，
  // 看着像没毛病，其实整轮白跑四分钟、九万 token。白卷必须记成白卷。
  const blankNotes = {
    active: () => ['月亮今天很圆', '冰箱里还有半盒草莓', '右脚的鞋带老松', '周四要交那份表',
      '楼下修车铺关门了', '鲸鱼玩偶洗过一回', '屏幕有点脏', '窗台上的绿萝长新叶了'].map((text, i) => ({
      id: 'nt_' + i, kind: '事实', weight: 2, at: '2026-10-28', text,
    })),
    get: () => null,
    stale: () => {},
    update: () => {},
  };
  const blankSaid = [];
  const blankRes = await upkeep({
    brain: { run: async () => ({ text: '   ' }) },
    notes: blankNotes,
    logger: (_tag, msg) => blankSaid.push(String(msg)),
  });
  ok('体检：脑子交白卷时返回 null', blankRes === null);
  ok('体检：白卷要记一笔，别装成没毛病', blankSaid.some((s) => s.includes('白卷')));
  ok('体检：白卷时不许写「压过时 0 / 改准 0」那行假账', !blankSaid.some((s) => s.includes('压过时')));
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
      ? { lastDir: 'in', lastTs: Date.now(), lastInTs: Date.now() }
      : { lastDir: 'in', lastTs: Date.now() - 400000, lastInTs: Date.now() - 400000 }),
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

// ── 自由活动也会换会话：跟聊天一个尺子 ────────────────────
// 2026-10-28 量到的：自由活动原来是「一整段共用一条会话」，越跑越长，单轮读到 334 万
// token（一轮 9~10 步，每步重读一遍全量上下文）。聊天那条有 rotateAtTokens 管着，
// 稳在 15~20 万；这条路以前根本没有这个机制。26 拍花了 1542 万，和 90 轮聊天一样贵。
{
  check('自由活动换会话：没到阈值不换', shouldRotateFree(100000, 250000), false);
  check('自由活动换会话：正好到阈值就换', shouldRotateFree(250000, 250000), true);
  check('自由活动换会话：超了当然换（334 万那种）', shouldRotateFree(3340958, 250000), true);
  check('自由活动换会话：没配阈值按 6 万兜底', shouldRotateFree(70000, undefined), true);
  check('自由活动换会话：读的数是脏的就当没超', shouldRotateFree(undefined, 250000), false);
  const fsrc = fs.readFileSync(path.join(ROOT, 'src/body/freetime.mjs'), 'utf8');
  ok('自由活动换会话：真接在拍子上了', fsrc.includes('shouldRotateFree(readTokens, rotateAt)'));
  ok('自由活动换会话：超了就清空 #sid', fsrc.includes('this.#sid = null;'));
  ok('自由活动换会话：阈值读的是跟聊天同一个配置', fsrc.includes('headless?.rotateAtTokens'));
}

// ── 他刚问过、她已经答过：自由活动不许再答一遍 ────────────
// 2026-10-27 11:52 他问按不按条数挂表情。回话里已经答了（「那本鲸就不硬凑了」），
// 可自由活动那一拍 11:56 又答了一遍——两条链各挂一条 session，互相看不见对方说过话。
// 旧的停表判据看的是「最后一条消息」：她一回，最后一条就成了她的，判据当场失效，
// 于是那一停立刻结束、下一拍照跑。要的是「他安静满这么久才算聊完」，那就得看他
// 最后开口的时刻（lastInTs），不是最后一条消息的时刻。
{
  let ran = 0;
  const ft = new FreeTime({
    cfg: {
      freeTime: {
        beatMs: 60000, skipIfActiveMs: 300000, pauseWhileOwnerChats: true,
        pauseCheckMs: 40, durationMs: 1800000, maxMessages: 3, permission: 'look',
      },
    },
    brain: { run: async () => { ran += 1; return { text: '<done/>' }; } },
    send: async () => {},
    logger: () => {},
    room: 'private:1',
    // 他十秒前问过一句，她刚刚回过：最后一条是她的（out），他最后开口在 10 秒前
    roomState: () => ({ lastDir: 'out', lastTs: Date.now(), lastInTs: Date.now() - 10000 }),
  });
  const s0 = ft.start({ minutes: 30 }).status;
  await new Promise((r) => setTimeout(r, 2200));
  const s1 = ft.status();
  check('答过一遍：他刚开口过就还该停表（哪怕她刚回过）', s1.paused, true);
  check('答过一遍：停了就真没叫她动手', ran, 0);
  ok('答过一遍：停表把她这段往后顺延', s1.endsAt >= s0.endsAt);
  ft.stop('测试结束');
}

// ── 自由活动的对话带「多久之前」，只取最近半小时 ─────────────
// 2026-10-30 23:52：他那两句（23:42、23:44 关于墙）和两小时前的旧话并排摆着，
// 读起来全是「刚才」，她绕着早已聊完的那件事又讲了两拍（23:52「那面墙没人让我画…」、
// 23:54「把灯换成窗了…」）。
// 现在每句前面写清多久之前，并且超过半小时的不进这一段——更早的不该被当成现场。
{
  const now = 1793374800000;
  const mk = (msAgo, dir, text) => ({ ts: now - msAgo, dir, text });
  const lines = recentTalk([
    mk(2 * 3600_000, 'in', '两小时前那句'),
    mk(25 * 60_000, 'out', '二十五分钟前那句'),
    mk(30_000, 'in', '半分钟前那句'),
  ], { windowMs: 30 * 60_000, limit: 12, now });
  check('对话带时间：两小时前的不进来', lines.some((l) => l.includes('两小时前那句')), false);
  check('对话带时间：半小时以内的都在', lines.length, 2);
  check('对话带时间：写了「25 分钟前」', lines[0].includes('25 分钟前'), true);
  check('对话带时间：刚说那句写「刚刚」', lines[1].includes('刚刚'), true);
  check('对话带时间：谁说的还在', lines[0].startsWith('25 分钟前，你：'), true);
  check('对话带时间：只留最后 N 条', recentTalk([
    mk(1000, 'in', 'a'), mk(2000, 'in', 'b'), mk(3000, 'in', 'c'),
  ], { windowMs: 30 * 60_000, limit: 2, now }).length, 2);
  check('对话带时间：没时间戳的丢掉', recentTalk([{ dir: 'in', text: '没 ts' }], { now }).length, 0);
  const longLine = recentTalk([mk(1000, 'out', '啊'.repeat(150))], { windowMs: 30 * 60_000, now })[0];
  ok('对话带时间：削过的句子留一个「…」', longLine.endsWith('…') && longLine.includes('啊'.repeat(120)) && !longLine.includes('啊'.repeat(121)));
  const shortLine = recentTalk([mk(1000, 'out', '一句短的')], { windowMs: 30 * 60_000, now })[0];
  ok('对话带时间：没削的不多一个点', shortLine.endsWith('一句短的'));
  const msrc = fs.readFileSync(path.join(ROOT, 'src/main.mjs'), 'utf8');
  ok('对话带时间：roomState 真用上了它', msrc.includes('talk: recentTalk(list'));
  ok('对话带时间：只取半小时（30 分钟）', msrc.includes('windowMs: 30 * 60 * 1000'));
  const fsrc2 = fs.readFileSync(path.join(ROOT, 'src/body/freetime.mjs'), 'utf8');
  ok('对话带时间：提示里说明了「每句前面是多久之前」', fsrc2.includes('每句前面是多久之前'));
}

// 2026-10-27 16:20 那次：他 16:14 说完，她 16:16 答完（回话那条链答了很久），
// 16:20 自由那一拍按「他安静满 5 分钟」就醒了，插进去说了句跟她刚说过的正相反的话
// （她说画了，那一拍说「图本鲸不画」）。只看他的时刻追不上两个人的对话：
// 取两头晚的那个——他在说、或者她刚在回话里应过他，都算这段没散。
// 但自由活动自己发的那些不算（否则她每拍都在刷新时钟，自由时间永远开不起来），
// 那条在 main.mjs 的 roomState 里滤（e.free），这里用 lastTs 更新、lastOutTs 不动来代表。
{
  let ran = 0;
  const now = Date.now();
  const ft = new FreeTime({
    cfg: {
      freeTime: {
        beatMs: 60000, skipIfActiveMs: 300000, pauseWhileOwnerChats: true,
        pauseCheckMs: 40, durationMs: 1800000, maxMessages: 3, permission: 'look',
      },
    },
    brain: { run: async () => { ran += 1; return { text: '<done/>' }; } },
    send: async () => {},
    logger: () => {},
    room: 'private:1',
    // 他六分多钟前说过（已经过了 5 分钟窗口），她二十秒前刚在回话里答完
    roomState: () => ({ lastDir: 'out', lastTs: now - 20000, lastInTs: now - 400000, lastOutTs: now - 20000 }),
  });
  ft.start({ minutes: 30 });
  await new Promise((r) => setTimeout(r, 2200));
  const s = ft.status();
  check('她刚答完：对话没散，这一拍还该停表', s.paused, true);
  check('她刚答完：停了就真没叫她动手', ran, 0);
  ft.stop('测试结束');
}

// 反过来：刚刚那条"最后一条消息"如果是自由活动自己发的，不算对话，该拍就拍。
{
  let ran = 0;
  const now = Date.now();
  const ft = new FreeTime({
    cfg: { freeTime: { beatMs: 60000, skipIfActiveMs: 300000, durationMs: 1800000, maxMessages: 3, permission: 'look' } },
    brain: { run: async () => { ran += 1; return { text: '<done/>' }; } },
    send: async () => {},
    logger: () => {},
    room: 'private:1',
    // 他十分钟前说过，她十分钟前也应过；现在这条最新的 out 是她自由活动自己发的
    roomState: () => ({ lastDir: 'out', lastTs: now - 5000, lastInTs: now - 600000, lastOutTs: now - 600000 }),
  });
  ft.start({ minutes: 30 });
  await new Promise((r) => setTimeout(r, 2600));
  check('自由活动自己发的不算对话：表不该停', ft.status().paused, false);
  ok('自由活动自己发的不算对话：拍照跑', ran > 0);
  ft.stop('测试结束');
}


// 光有停表还不够：他安静满五分钟之后照样会拍，那一拍要是看不见「她刚在回话里答过」，
// 还是会把同一件事再答一遍。所以每拍都把这个房间最近十几句带进去。
{
  let prompt = '';
  const ft = new FreeTime({
    cfg: { freeTime: { beatMs: 40, skipIfActiveMs: 0, durationMs: 600000, maxMessages: 3, permission: 'look' } },
    brain: { run: async (o) => { prompt = String(o.prompt || ''); return { text: '<done/>' }; } },
    send: async () => {},
    logger: () => {},
    room: 'private:1',
    roomState: () => ({
      lastDir: 'in', lastTs: Date.now() - 1000, lastInTs: Date.now() - 1000,
      talk: ['他：按你喜欢的来吧', '你：那本鲸就不硬凑了'],
    }),
  });
  ft.start({ minutes: 10 });
  await new Promise((r) => setTimeout(r, 2600));  // start() 把第一拍排在 2 秒后
  ok('看得见刚才：那一拍带着这个房间刚说过的话', prompt.includes('【这个房间刚才的对话】'));
  ok('看得见刚才：他问过的那句在里面', prompt.includes('他：按你喜欢的来吧'));
  ok('看得见刚才：她自己答过的也在里面', prompt.includes('你：那本鲸就不硬凑了'));
  ok('看得见刚才：提醒她别再答一遍', prompt.includes('就别再答一遍'));
  ft.stop('测试结束');
}

// ── 上一段的拍回来晚了：不许它替新的一段说话 ──────────────
// 2026-10-26 22:33：两条开场白在 6 秒里都发出去了，日志里是两条「开场那句发出去了
// （不占额度）」，两个不同的 session——同一间私聊连着响两声。想事情要一分多钟，
// 回来时那一段可能已经收了、甚至已经开了新的一段：那种话属于旧段，不该开口。
{
  const said = [];
  let calls = 0;
  const ft = new FreeTime({
    cfg: {
      freeTime: {
        beatMs: 60000, durationMs: 600000, maxMessages: 3, permission: 'look',
        pauseWhileOwnerChats: false,
      },
    },
    brain: {
      run: async () => {
        calls += 1;
        const n = calls;
        await new Promise((r) => setTimeout(r, 1200));
        return { text: n === 1 ? '上一段的那句话' : '这一段的话' };
      },
    },
    send: async (t) => { said.push(t); },
    logger: () => {},
    room: 'private:1',
    roomState: () => ({ lastDir: 'in', lastTs: 0 }),
  });
  ft.start({ minutes: 10 });                        // 第一拍排在 2 秒后
  await new Promise((r) => setTimeout(r, 2400));    // 这一拍已经在想了
  ft.stop('测试：收掉这一段');
  ft.start({ minutes: 10 });                        // 新的一段，第一拍同样 2 秒后
  await new Promise((r) => setTimeout(r, 4400));    // 等两拍都回来
  check('遗孤：上一段的那句话不发出去', said.includes('上一段的那句话'), false);
  ok('遗孤：新一段的话照常说', said.includes('这一段的话'));
  ft.stop('测试结束');
}

// ── 标记写在话里：是话，不是命令 ──────────────────────────
// 2026-10-27 21:16：我给先生解释「那个十分钟的标记会被压成六百秒」，话里带着标记原文，
// 结果整句被当成「去等」——消息没发出去，人还空停了十分钟。判据改成整句匹配。
{
  const said = [];
  const logs = [];
  let calls = 0;
  const ft = new FreeTime({
    cfg: {
      freeTime: {
        beatMs: 40, skipIfActiveMs: 0, durationMs: 600000, maxMessages: 9, permission: 'look',
        pauseWhileOwnerChats: false,
      },
    },
    brain: {
      run: async () => {
        calls += 1;
        return { text: calls === 1 ? '那句里我写了 <wait:600/> 这样的标记，然后话就被吞了' : '<pass/>' };
      },
    },
    send: async (t) => { said.push(String(t)); },
    logger: (area, line) => { logs.push(`${area} ${line}`); },
    room: 'private:1',
    roomState: () => ({ lastDir: 'in', lastTs: 0 }),
  });
  ft.start({ minutes: 10 });
  await new Promise((r) => setTimeout(r, 3000));   // 第一拍排在 2 秒后
  ft.stop('测试结束');
  ok('话里带标记：照常发出去', said.some((t) => t.includes('话就被吞了')));
  check('话里带标记：标记不跟着发出去', said.some((t) => t.includes('<wait:')), false);
  // 被当成「去等」时这一拍会提前 return，话也就不会走完发送那条路（日志里没有「第 N 拍」）。
  ok('话里带标记：这一拍照常走完', logs.some((l) => l.includes('第 1 拍')));
}

// ── 段收了：底下还在跑的那一轮要当场叫停 ──────────────────
// 只挡住它说话是不够的。22:24 手动结束之后，那一轮又跑了六分钟、烧了一百四十万
// token；下一段一开始，两个人就同时改同一张图。所以收段时要把 signal 拉掉。
{
  let gotSignal = null;
  const ft = new FreeTime({
    cfg: {
      freeTime: {
        beatMs: 60000, durationMs: 600000, maxMessages: 3, permission: 'look',
        pauseWhileOwnerChats: false,
      },
    },
    brain: {
      run: async ({ signal }) => {
        gotSignal = signal;
        await new Promise((r) => setTimeout(r, 2000));
        return { text: '<pass/>' };
      },
    },
    send: async () => {},
    logger: () => {},
    room: 'private:1',
    roomState: () => ({ lastDir: 'in', lastTs: 0 }),
  });
  ft.start({ minutes: 10 });
  await new Promise((r) => setTimeout(r, 2400));    // 这一拍已经在想了
  ok('叫停：跑着的那一拍拿到了开关', Boolean(gotSignal) && gotSignal.aborted === false);
  ft.stop('测试：收掉这一段');
  ok('叫停：段一收，底下那一轮当场停', Boolean(gotSignal) && gotSignal.aborted === true);
  await new Promise((r) => setTimeout(r, 600));
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

// ── 工具恒定全套 ────────────────────────────────────────────
// 2026-10-26：这一块原来测的是「她自己说要全套工具 → 换档重跑」。
// 实测换档洗缓存，一次多烧 137000 token，而全量和轻装每步只差 9548，
// 判据还是正则。整条砍了——她永远拿全套，不再需要「要工具」这句话。
{
  const msrc2 = fs.readFileSync(path.join(ROOT, 'src/main.mjs'), 'utf8');
  ok('工具：不再按闲聊降档', !msrc2.includes('turnProfile'));
  ok('工具：不再有「要全套工具」的解析', !msrc2.includes('wantsFullTools'));
  ok('工具：三处都落到默认 profile（全量）', !msrc2.includes('chatProfile'));
  ok('工具：规程也恒定全套', msrc2.includes('const rulesText = ruleOf(asGroup);'));
}

// ── 用量账本不许漏 ──────────────────────────────────────
// 2026-10-28 用户看出面板数字比实际少近一半：原来只有两处记账（正常回话、自由活动），
// aside / 冷场开口 / 等工具跑完的续接 / 体检 / 整理 / 交接纸条 / 筛表情全漏。
// 现在改成在脑子外面套一层（meterRun），谁调 run 都记，kind 由调用方给。
{
  const src = fs.readFileSync(path.join(ROOT, 'src/main.mjs'), 'utf8');
  ok('账本：主脑套了记账层', src.includes('meterRun(brain)'));
  ok('账本：后台脑也套了', src.includes('meterRun(worker)'));
  ok('账本：aside 单独记一种', src.includes("kind: 'aside'"));
  ok('账本：冷场开口单独记一种', src.includes("kind: 'social'"));
  ok('账本：等工具跑完的续接单独记一种', src.includes("kind: 'awaiting'"));
  ok('账本：不再有两处各记一次的老写法', !src.includes('recordUsage'));
  const fsrc = fs.readFileSync(path.join(ROOT, 'src/body/freetime.mjs'), 'utf8');
  ok('账本：自由活动那一拍标了 free', fsrc.includes("kind: 'free'"));
}

// ── 筛表情：一批一次，别一张一读 ──────────────────────────
// 2026-10-28 实测：一张一次 brain.run，单张 5.7 万 token，其中几乎全是系统提示词
// 和工具定义，图片本身才几千。四张就是同一份说明读四遍。改成一批一次。
{
  const pending = [
    { id: 'k1', abs: '/tmp/a.png', ctx: '笑死', from: '某人' },
    { id: 'k2', abs: '/tmp/b.png' },
  ];
  const p = batchPrompt(pending);
  ok('筛表情：一批的提示词里有两张的 id', p.includes('id=k1') && p.includes('id=k2'));
  ok('筛表情：两张的路径都在', p.includes('/tmp/a.png') && p.includes('/tmp/b.png'));
  ok('筛表情：旁边说的话也带上了', p.includes('笑死'));

  const got = parseVerdicts(["看完了",
    '{"id":"k1","verdict":"sticker","tags":["撒娇"],"when":"求夸"}',
    '{"id":"k2","verdict":"screenshot","tags":[],"when":""}',
  ].join('\n'));
  check('筛表情：多行 JSON 都抠出来了', got.size, 2);
  check('筛表情：k1 判成表情', got.get('k1')?.verdict, 'sticker');
  check('筛表情：k2 判成截图', got.get('k2')?.verdict, 'screenshot');

  const broken = parseVerdicts([
    '{"id":"k1","verdict":"sticker"}',
    '{"id":"k2", oops}',
    '{"id":"k3","verdict":"other"}',
  ].join('\n'));
  check('筛表情：坏掉的那一行只丢那一张', broken.size, 2);
  ok('筛表情：没被坏行连累', broken.has('k3'));

  // 真跑一遍：四张只该有一次 brain.run
  let runs = 0;
  const seen = [];
  const fake = {
    pendingAll: async () => [1, 2, 3, 4].map((i) => ({ id: 'k' + i, abs: '/tmp/' + i + '.png' })),
    approve: async (id) => seen.push(['ok', id]),
    reject: async (id, why) => seen.push(['no', id, why]),
  };
  const res = await screenStickers({
    brain: { run: async () => { runs += 1; return { text: [1, 2, 3, 4].map((i) => `{"id":"k${i}","verdict":"sticker","tags":["a"],"when":"b"}`).join('\n') }; } },
    stickers: fake, logger: () => {}, maxOps: 4,
  });
  check('筛表情：四张只跑了一次脑子', runs, 1);
  check('筛表情：四张都处理了', res.checked, 4);
  check('筛表情：四张都收下', res.kept, 4);
  check('筛表情：真落库了', seen.length, 4);

  // 三档以外的判断（2026-10-31 真收到过 "comic-strip-3panels"）：
  // 退回可以，但不能把模型现编的词当"类别"写进 reject，那会让档案看着比实际整齐。
  const odd = [];
  const res2 = await screenStickers({
    brain: { run: async () => ({ text: '{"id":"k1","verdict":"comic-strip-3panels","tags":[],"when":""}' }) },
    stickers: {
      pendingAll: async () => [{ id: 'k1', abs: '/tmp/1.png' }],
      approve: async (id) => odd.push(['ok', id]),
      reject: async (id, why) => odd.push(['no', id, why]),
    },
    logger: () => {}, maxOps: 1,
  });
  check('筛表情：三档以外的判断照样退回', res2.rejected, 1);
  ok('筛表情：理由写明是未识别，不冒充类别', String(odd[0]?.[2] || '').startsWith('未识别判断：'));
}

// ── 拼成联络表：一张图看完一批 ──────────────────────────
// 逐张 read_image 一轮四张就是四张图；拼成一张 384 一格的联络表，一次看完。
{
  const out = path.join(os.tmpdir(), `qad-sheet-${Date.now()}.png`);
  ok('拼图：空名单不拼', makeSheet([], out) === null);
  ok('拼图：路径都不存在就不拼（交给调用方退回逐张）', makeSheet([{ abs: out + '.nope.png' }], out) === null);
  ok('拼图：脚本在仓库里', fs.existsSync(path.join(ROOT, 'tools', 'pending-sheet.py')));

  const p = batchPrompt([{ id: 'k1', abs: '/tmp/a.png' }, { id: 'k2', abs: '/tmp/b.png' }], '/tmp/sheet.png');
  ok('拼图：有联络表就只给一个路径', p.includes('/tmp/sheet.png') && !p.includes('一条路径都没有'));
  ok('拼图：提示词说清一格一张、角上有 id', p.includes('格子左下角印着这张的 id'));
  ok('拼图：两张的 id 还是要列出来', p.includes('k1') && p.includes('k2'));
  const noSheet = batchPrompt([{ id: 'k1', abs: '/tmp/a.png' }]);
  ok('拼图：没拼成还是逐张给路径', noSheet.includes('read_image 打开它') && noSheet.includes('/tmp/a.png'));

  // 切过、没切开的那几张：脚本量出来的数必须走到提示词里。
  // 2026-11-01 之前这条路是静默的——JSON 出了，没人接，模型只看见表上一条横带。
  const u = batchPrompt([{ id: 'k1', abs: '/tmp/a.png' }], {
    path: '/tmp/sheet.png',
    thin: [],
    uncut: [{ id: 'k0357', abs: '/tmp/t.jpg', reason: 'uneven',
      detail: { cut_bands: [{ y: 300, h: 66, pct: 3.4 }], seg_hs: [157, 500, 824], seg_ratio: 5.25 } }],
  });
  ok('切不开：提示词里带上了量到的数', u.includes('1 条缝切出 3 段') && u.includes('差 5.25 倍'));
  ok('切不开：原图路径给了', u.includes('/tmp/t.jpg'));
  ok('切不开：不出现编出来的理由', !u.includes('缝落在内容里'));
  ok('切不开：没缝的那张不占一行（人家本来就是一整张）',
    !batchPrompt([{ id: 'k1', abs: '/tmp/a.png' }], { path: '/tmp/s.png', thin: [], uncut: [] })
      .includes('试过按格切'));

  check('切不开：not_strip 说中位段高', uncutNote({ reason: 'not_strip',
    detail: { cut_bands: new Array(28).fill({ y: 1, h: 12, pct: 0.6 }), median_seg_h: 65, img_h: 1920 } }),
  '28 条缝切出 29 段，段高中位数 65px（图高 1920 的 3.4%，门槛 10%）——像文字长图/截图，不像分格');
  // 缝数与段数必须对得上账：seg_hs 只装过了 min_h 的段，配上全部缝数就成了一句
  // 算不通的话（45 张 uneven 里 15 张这样，k0357 写的是"4 条缝切出 3 段"）。
  check('切不开：uneven 丢了薄边时把两笔账都说清', uncutNote({ reason: 'uneven',
    detail: { cut_bands: new Array(4).fill({ y: 300, h: 66, pct: 3.4 }), seg_hs: [157, 500, 824],
      seg_hs_raw: [157, 30, 500, 824, 40], seg_ratio: 5.25 } }),
  '4 条缝把图分成 5 段，够高的 3 段（其余 2 段不到门槛），高 157..824（差 5.25 倍，门槛 2.5），最宽一条平带 66px 占 3.4% 图高');
  check('切不开：uneven 没丢薄边时话短一点', uncutNote({ reason: 'uneven',
    detail: { cut_bands: [{ y: 300, h: 66, pct: 3.4 }], seg_hs: [157, 500],
      seg_hs_raw: [157, 500], seg_ratio: 3.18 } }),
  '1 条缝切出 2 段，高 157..500（差 3.18 倍，门槛 2.5），最宽一条平带 66px 占 3.4% 图高');
  check('切不开：ok 不装成"没切开"', uncutNote({ reason: 'ok', detail: {} }), '按格切开了');
  check('切不开：too_small 报最高那段、几段够高', uncutNote({ reason: 'too_small',
    detail: { cut_bands: new Array(2).fill({ y: 1, h: 10, pct: 0.5 }),
      img_h: 878, seg_hs_raw: [32, 794, 52], n_fit: 1 } }),
  '2 条缝切出 3 段，只有 1 段够高：最高 794px 占图高 90.4%（门槛 6%），其余 2 段都不到');
  check('切不开：too_small 一段都不够高时也说数', uncutNote({ reason: 'too_small',
    detail: { cut_bands: [{ y: 1, h: 10, pct: 0.5 }],
      img_h: 1000, seg_hs_raw: [40, 45], n_fit: 0 } }),
  '1 条缝切出 2 段，最高的才 45px 占图高 4.5%（门槛 6%），一段都不够');
  check('切不开：too_small 没有明细时不编数',
    uncutNote({ reason: 'too_small', detail: {} }),
    '没切开（too_small），段高没递过来——这条别当数看');
  check('切不开：没见过的原因照抄，不编',
    uncutNote({ reason: 'bleh', detail: {} }), '没切开（bleh）');
}

// ── 兴趣账本：CLI 记的那一笔，桥得看得见 ────────────────────
// 2026-10-30 10:5x 抓到的：自由活动那一拍的提示里三件事全写「1 天前做过」，实际分别是
// 1.7 / 5.3 / 7.8 小时前——账本只在开机读一次盘，而 `node scripts/interests.mjs did …`
// 是另一个进程写的。这类错不报错，只是让她一遍遍被推荐刚做完的事。
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interests-'));
  const file = path.join(dir, 'interests.json');
  const t0 = Date.now();
  const base = {
    items: [{ id: 'in_a', name: '看海', order: 0, count: 1, lastAt: t0 - 3 * 86400000, feelings: [] }],
  };
  fs.writeFileSync(file, JSON.stringify(base), 'utf8');

  const store = new InterestStore({ file });
  check('兴趣：开机读到的是 3 天前', Math.round(store.idleDays(store.get('看海'))), 3);

  // 模拟另一个进程刚刚记了一笔
  const t1 = t0 + 5000;
  fs.writeFileSync(file, JSON.stringify({ items: [{ ...base.items[0], count: 2, lastAt: t1 }] }), 'utf8');
  fs.utimesSync(file, new Date(t1), new Date(t1)); // 钉死 mtime，别靠写入快慢

  check('兴趣：CLI 记的一笔，桥不重启也看得见（count）', store.get('看海')?.count, 2);
  check('兴趣：刚做过的那件不再算 3 天前', Math.round(store.idleDays(store.get('看海'))), 0);
  check('兴趣：挑的时候用的也是新数', store.pick(1)[0]?.idleDays, 0);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 探针：现在跑的是不是最新那份 ──────────────────────────
// 2026-11-01 一天里三次"改了 ≠ 生效"（13:09 改宽限期、17:21 装空图闸、18:03 递 thin），
// 每次都是同一个动作：改完、自检绿、说"好了"——而桥还开着开机时那份。这个探针替我
// 做那次比较，所以它自己得先对：最后一条启动记录、UTC 时间戳、以及"新"的边界。
{
  const log = [
    '[2026-11-01T03:31:08.700Z] 桥已启动（pid 36408）',
    '[2026-11-01 11:31:08] [snowluma] 启动 外部的那份',
    '[2026-11-01T12:14:50.312Z] 桥已启动（pid 19320）',
  ].join('\n');
  const start = findStart(log);
  check('探针：取的是最后一条启动记录（pid）', start?.pid, 19320);
  check('探针：带 Z 的时间戳读成了同一时刻', start?.at, Date.parse('2026-11-01T12:14:50.312Z'));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-'));
  const older = path.join(dir, 'older.mjs');
  const newer = path.join(dir, 'newer.js');
  fs.writeFileSync(older, '// 启动前改的\n', 'utf8');
  fs.writeFileSync(newer, '// 启动后改的\n', 'utf8');
  fs.utimesSync(older, new Date(start.at - 60000), new Date(start.at - 60000));
  fs.utimesSync(newer, new Date(start.at + 60000), new Date(start.at + 60000));
  check('探针：启动之后改过的文件被点名', staleFrom(dir, start.at).map((x) => path.basename(x.file)), ['newer.js']);
  check('探针：启动之前改过的不算', staleFrom(dir, start.at + 120000).length, 0);
  fs.rmSync(dir, { recursive: true, force: true });

  // 自检收尾那句话：只在"真旧了 + 那个进程还活着"时才开口。喂假结果，不碰真进程。
  const fakeStale = { verdict: 'stale', pid: 19320, pidAlive: true, startedAt: start.at, stale: [{ file: path.join(ROOT, 'src', 'a.mjs'), mtime: 0 }] };
  check('探针：旧了就先答一句「这份还没生效」', staleNote(fakeStale)?.includes('这份还没生效'), true);
  // 桥没起（pidAlive 不是 true）、或者判不了：一句话都不说。宁可闭嘴，也不冤枉桥。
  check('探针：桥没起或者判不了时不说话',
    [staleNote({ ...fakeStale, pidAlive: null }), staleNote({ ...fakeStale, pidAlive: false }), staleNote({ verdict: 'fresh', pid: 1, pidAlive: true, startedAt: start.at, stale: [] }), staleNote({ verdict: 'unknown', reason: 'x' })],
    [null, null, null, null]);
}

// ── 看门人：桥自己那一半 ────────────────────────────────
// 探针得有人记得问；桥不问，所以夜里那句话永远没人说。这里验的是"它自己会说"：
// 启动之后改过的点名、同一个版本只说一次、再改一版再说、比启动早的一个字不说。
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-watch-'));
  const file = path.join(dir, 'x.mjs');
  const at = Date.parse('2026-11-01T12:14:50.312Z');
  fs.writeFileSync(file, '// 启动后改的\n', 'utf8');
  fs.utimesSync(file, new Date(at + 60000), new Date(at + 60000));
  const said = [];
  const w = createStaleWatch({ dir, logger: (tag, msg) => said.push(`${tag}:${msg}`), sinceMs: at });
  check('看门人：启动之后改过的文件，它自己点名', w.scan().map((x) => path.basename(x.file)), ['x.mjs']);
  check('看门人：点的是「这份还没生效」', said.length === 1 && said[0].startsWith('stale:这份还没生效'), true);
  check('看门人：同一个版本只说一次', [w.scan().length, said.length], [0, 1]);
  fs.utimesSync(file, new Date(at + 120000), new Date(at + 120000));
  check('看门人：又改了一版就再说一句', w.scan().length, 1);

  const quiet = [];
  const before = createStaleWatch({ dir, logger: (...x) => quiet.push(x), sinceMs: at + 10 * 60000 });
  check('看门人：比启动更晚的时刻不算，一个字不说', [before.scan().length, quiet.length], [0, 0]);

  const t = createStaleWatch({ dir, logger: () => {}, sinceMs: at, intervalMs: 60000 });
  t.start();
  const running = Boolean(t.timer);
  t.stop();
  check('看门人：定时器能开能停', [running, t.timer], [true, null]);

  // 2026-11-02：余量的方向写反过一次。危险区不在 since 之后，而在 since **之前**那几秒——
  // 进程刚起来、src/ 还没 import 完，这段时间改的文件，读到的说不好是哪一版。
  // 写成 sinceMs + tolerance 就等于主动放过这一段，正好是让刚改过的冒充已生效。
  const edge = path.join(dir, 'edge.mjs');
  fs.writeFileSync(edge, '// edge', 'utf8');
  fs.utimesSync(edge, new Date(at + 500), new Date(at + 500));
  check('看门人：启动后半秒改的也算没生效（余量往前提）',
    staleFrom(dir, at).some((x) => path.basename(x.file) === 'edge.mjs'), true);
  check('看门人：判据不许再写成 sinceMs + tolerance',
    fs.readFileSync(path.join(ROOT, 'src', 'util', 'stale-watch.mjs'), 'utf8').includes('sinceMs + tolerance'), false);

  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 媒体清理：视频得显式给扩展名 ────────────────────────
// 2026-11-02 审计：main.mjs 拿只认图片扩展名的清理函数去清 data/videos/，
// .mp4 一个都不匹配，视频清理从上线起就是空转（堆到 562MB / 481 个文件）。
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qad-media-'));
  const write = (name, bytes) => fs.writeFileSync(path.join(dir, name), Buffer.alloc(bytes));
  write('a.png', 1000);
  write('b.mp4', 2000);
  write('c.webm', 500);

  const keep = cleanupImages(dir, { retainDays: 0, maxMb: 1000 });
  ok('清理：默认只认图片，mp4/webm 不碰', fs.existsSync(path.join(dir, 'b.mp4')) && fs.existsSync(path.join(dir, 'c.webm')));
  ok('清理：默认把图算进来了（a.png 还在，因为没超预算）', keep.bytes > 0 && fs.existsSync(path.join(dir, 'a.png')));

  const v = cleanupImages(dir, { retainDays: 0, maxMb: 0.001, match: VIDEO_RE });
  ok('清理：给 VIDEO_RE 才会动视频', v.removed >= 1 && !fs.existsSync(path.join(dir, 'b.mp4')));
  ok('清理：视频正则不误伤图片', fs.existsSync(path.join(dir, 'a.png')));

  ok('清理：图片正则认 png', IMAGE_RE.test('x.PNG'));
  ok('清理：视频正则认 mp4', VIDEO_RE.test('x.MP4'));
  ok('清理：视频正则不认 png', !VIDEO_RE.test('x.png'));

  const msrc3 = fs.readFileSync(path.join(ROOT, 'src/main.mjs'), 'utf8');
  ok('清理：main.mjs 清视频时真传了 VIDEO_RE', /cleanupImages\(videoDir,\s*\{\s*\.\.\.\(cfg\.videos/.test(msrc3) && msrc3.includes('match: VIDEO_RE'));

  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 历史段：不滑窗，只留保险丝 ──────────────────────────
// 2026-11-01 查出群聊 433 轮里 87 轮每轮新输入 12–18 万，47% 的钱花在这上面。
// 根因是 slice(-14)：每来一条新消息整段往前挪一格，缓存按前缀匹配，一挪全断。
{
  const mk = (n, len) => Array.from({ length: n }, (_, i) => ({ dir: i % 2 ? 'out' : 'in', from: '1', text: 'x'.repeat(len) + '#' + i }));
  const small = mk(5, 400);
  ok('历史段：没超预算就原样放（一条都不切）', fitHistory(small, { maxTokens: 100000 }).length === 5);
  const big = mk(60, 8000);
  const cut = fitHistory(big, { maxTokens: 100000 });
  ok('历史段：超预算会裁', cut.length < 60);
  ok('历史段：最新的那条留着', cut.length > 0 && cut[cut.length - 1].text.endsWith('#59'));
  ok('历史段：最旧的被丢掉了', cut.length > 0 && !cut.some((m) => m.text.endsWith('#0')));
  ok('历史段：空数组给空数组', fitHistory([]).length === 0);
  ok('历史段：不是数组也不炸', fitHistory(null).length === 0);
  ok('历史段：保险丝是 30 万', HISTORY_MAX_TOKENS === 300000);
  ok('粗估：中文按 1.6 字符一个 token', roughTokens('一'.repeat(160)) === 100);
  ok('粗估：空串是 0', roughTokens('') === 0);
  const psrc = fs.readFileSync(path.join(ROOT, 'src/body/prompt.mjs'), 'utf8');
  ok('历史段：不再按条数滑窗（没有 older.slice(-14)）', !psrc.includes('older.slice(-14)'));
  ok('历史段：真挂上了 fitHistory', psrc.includes('renderTranscript(fitHistory(older))'));
  const m500 = fs.readFileSync(path.join(ROOT, 'src/main.mjs'), 'utf8');
  ok('历史段：读的条数放宽到 500（不然短句房间永远涨不满）', m500.includes('readRecent({ room: roomKey, limit: 500 })'));
}

// ── 门牌：挂的命令、点名的脚本，文件都得真在 ────────────────
// 2026-10-29 晚：src/body/rules.mjs 早就删了，package.json 还挂着 probe:rules、
// docs/scripts.md 还列着它——370 道闸一道都没拦。它们守的是"跑起来对不对"，
// 而没人跑的命令不会报错，它只是烂着。门牌也是一种承诺，得有人守。
// **这一段必须留在最后**：它拿 pass + 1 报自己的总数，后面再插检查它数不到——
// 2026-11-02 凌晨加探针时报的项数就少算了 4 项，而它照样绿。
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const cmds = Object.entries(pkg.scripts || {});
  const dangling = [];
  for (const [name, cmd] of cmds) {
    for (const m of String(cmd).matchAll(/node\s+(?:\.\/)?([\w./-]+\.(?:mjs|cjs|js))/g)) {
      if (!fs.existsSync(path.join(ROOT, m[1]))) dangling.push(`${name} → ${m[1]}`);
    }
  }
  ok(`门牌：package.json 挂的 ${cmds.length} 条命令都指向真文件${dangling.length ? `（缺：${dangling.join('、')}）` : ''}`, dangling.length === 0);

  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'scripts.md'), 'utf8');
  // 文档里有 `node scripts/xxx.mjs` 这种占位名，不当真文件查
  const named = new Set([...doc.matchAll(/node\s+scripts\/([\w.-]+\.mjs)/g)]
    .map((m) => m[1])
    .filter((f) => !/^x+\.mjs$/i.test(f)));
  const gone = [...named].filter((f) => !fs.existsSync(path.join(ROOT, 'scripts', f)));
  ok(`门牌：docs/scripts.md 点名的 ${named.size} 个脚本都还在${gone.length ? `（缺：${gone.join('、')}）` : ''}`, gone.length === 0);

  // 反过来也得守：前面的判据只查「写的都在」，不查「在的都写了」。新添一个脚本却
  // 忘了上文档，门牌上就少一块，而 370 道闸会一齐报绿——少写不是错，但它让人以为数全了。
  const onDisk = fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => f.endsWith('.mjs'));
  const unlisted = onDisk.filter((f) => !named.has(f)).sort();
  // 占位名 xxx.mjs 只是示例，不该被当成漏写的脚本
  ok(`门牌：scripts/ 里的 ${onDisk.length} 个脚本都在 docs/scripts.md 上${unlisted.length ? `（没写：${unlisted.join('、')}）` : ''}`,
    unlisted.length === 0);

  // 第四种谎：把声明本身删掉。前两条判据写的是「不匹配就算过」，所以改个说法、删掉
  // 半行，闸就悄悄没了，还一路报全过——会烂的门牌不可怕，会自己消失的闸才可怕。
  // 声明在不在，也得有人守。
  const claimed = doc.match(/共\s*(\d+)\s*个/);
  const claimTests = doc.match(/scripts\/selftest\.mjs`\s*\|\s*(\d+)\s*项/);
  ok(`门牌：docs/scripts.md 两处声明都还在（脚本体数${claimed ? '在' : '缺'}、自测项数${claimTests ? '在' : '缺'}）`,
    Boolean(claimed) && Boolean(claimTests));

  // 文档自己报的数也得对：写「共 23 个」而正文列了 28 个，就是门牌上的第二个谎
  ok(`门牌：docs/scripts.md 写的数对得上正文（写 ${claimed ? claimed[1] : '?'} 个，实列 ${named.size} 个）`,
    !claimed || Number(claimed[1]) === named.size);

  // 第三种谎：文档里替自检报的项数。这个数每加一条测试就变，所以只能自己数自己——
  // 本条也算一项，故 total = pass + 已失败的 + 1。2026-10-29 晚才发现原先只写 pass + 1：
  // 一旦前面有别的项红了，总数就少报，正好在已经出事的运行里报一个假数字。
  const total = pass + fails.length + 1;
  ok(`门牌：docs/scripts.md 报的自测项数对得上（写 ${claimTests ? claimTests[1] : '?'} 项，本次 ${total} 项）`,
    !claimTests || Number(claimTests[1]) === total);
}

// ── 结果 ────────────────────────────────────────────────
if (fails.length) {
  console.log(`✗ ${fails.length} 个失败 / ${pass} 个通过\n`);
  for (const f of fails) console.log('  ✗ ' + f + '\n');
  process.exit(1);
}
console.log(`✓ ${pass} 项全过`);

// 绿了之后先别急着说"好了"：这些项验的是盘上这份代码，而现在跑着的桥可能还是
// 开机时那份。自检跑完正是我最容易说出"好了"的一刻，所以让它在同一刻替我先答一句。
// 不是一项检查，不参与计数，也不改退出码——它只说事实，判不了或者桥没起就闭嘴。
const note = staleNote(assess());
if (note) console.log(`\n  ⚠ ${note}\n    （npm run probe:stale 看全名单；重启桥之后这句会自己消失）`);

