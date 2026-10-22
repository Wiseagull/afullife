// 自测：不用真的连 QQ，把合成事件喂进管道看判断对不对。
// node scripts/selftest.mjs
import { normalizeEvent } from '../src/body/room.mjs';
import { createRouter } from '../src/body/router.mjs';
import { toPlain, splitMessage } from '../src/util/text.mjs';
import { StickerLibrary } from '../src/stickers/library.mjs';
import { openingMood } from '../src/body/freetime.mjs';
import { UsageStore, describeUsage } from '../src/usage/store.mjs';
import { buildPrompt } from '../src/body/prompt.mjs';
import { ROOT } from '../src/config.mjs';
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
// 陌生人私聊也回（默认 privatePolicy='all'），只是没有动手权限——权限那关在闸上，不在路由上
check('陌生人私聊也回', router.decide({ kind: 'private', from: '999' }).speak, true);
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

// ── 结果 ────────────────────────────────────────────────
if (fails.length) {
  console.log(`✗ ${fails.length} 个失败 / ${pass} 个通过\n`);
  for (const f of fails) console.log('  ✗ ' + f + '\n');
  process.exit(1);
}
console.log(`✓ ${pass} 项全过`);
