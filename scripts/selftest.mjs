// 自测：不用真的连 QQ，把合成事件喂进管道看判断对不对。
// node scripts/selftest.mjs
import { normalizeEvent } from '../src/body/room.mjs';
import { createRouter } from '../src/body/router.mjs';
import { toPlain, splitMessage } from '../src/util/text.mjs';

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

// ── 结果 ────────────────────────────────────────────────
if (fails.length) {
  console.log(`✗ ${fails.length} 个失败 / ${pass} 个通过\n`);
  for (const f of fails) console.log('  ✗ ' + f + '\n');
  process.exit(1);
}
console.log(`✓ ${pass} 项全过`);
