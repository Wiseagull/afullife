// 验社交状态机、空格分条、回复审计、引用定位。全部离线，不连 QQ。
import { createRouter } from '../src/body/router.mjs';
import { Sender } from '../src/onebot/sender.mjs';
import { auditReply } from '../src/safety/audit.mjs';
import { resolveQuote } from '../src/body/room.mjs';
import { buildPrompt } from '../src/body/prompt.mjs';

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name} ${extra}`); }
}

// ── 1. 社交状态机 ────────────────────────────────────────
console.log('【状态机】');
{
  let t = 0;
  let rnd = 0.5;
  const cfg = {
    owner: { userIds: ['1'] },
    group: {
      keywords: ['deepseek'],
      social: {
        enabled: true,
        triggerProbability: 0.1,
        activeDurationMs: 20 * 60 * 1000,
        idleWindowMs: 6 * 60 * 1000,
        idleRetryProbability: 1,
        idleRetryWaitMs: 2 * 60 * 1000,
        skipProbability: 0,
        proactive: { enabled: true, idleThresholdMs: 30 * 60 * 1000, probability: 1 },
      },
    },
  };
  const r = createRouter({ cfg, now: () => t, random: () => rnd });
  const g = (text, atMe = false) => ({ kind: 'group', room: 'group:9', from: '2', name: '甲', text, atMe });

  ok('观望期概率没中 → 听着', r.decide(g('今天好热'), { roomKey: 'group:9' }).reason === 'diving');
  rnd = 0.05;
  const d1 = r.decide(g('今天好热'), { roomKey: 'group:9' });
  ok('观望期概率中了 → 开口', d1.speak && d1.reason === 'social');
  ok('进了活跃期', r.stateOf('group:9') === 'active');
  rnd = 0.99;
  ok('活跃期普通消息照接', r.decide(g('然后呢'), { roomKey: 'group:9' }).reason === 'active');

  rnd = 0; // skipProbability=0 关掉，测退场
  t = 21 * 60 * 1000;
  ok('超过活跃时长 → 自动退场', r.stateOf('group:9') === 'diving');

  // 冷场试探
  let t2 = 0;
  const r2 = createRouter({ cfg, now: () => t2, random: () => 0.99 });
  r2.enterActive('group:9');
  t2 = 7 * 60 * 1000;
  ok('冷场 → 试探一句', r2.idleCheck('group:9') === 'idle-probe');
  t2 = 9 * 60 * 1000;
  ok('试探没人理 → 退场', r2.idleCheck('group:9') === 'retire');
  ok('退场后回观望', r2.stateOf('group:9') === 'diving');

  // 主动开话题
  let t3 = 0;
  const r3 = createRouter({ cfg, now: () => t3, random: () => 0.99 });
  r3.decide(g('很久以前'), { roomKey: 'group:9' });
  t3 = 29 * 60 * 1000;
  ok('安静 29 分钟 → 不开口', r3.proactiveCheck('group:9') === false);
  t3 = 31 * 60 * 1000;
  ok('安静 31 分钟 → 开口', r3.proactiveCheck('group:9') === true);

  // 开关
  const r4 = createRouter({ cfg: { ...cfg, group: { ...cfg.group, social: { ...cfg.group.social, proactive: { enabled: false } } } }, now: () => t3, random: () => 0.99 });
  ok('主动开话题关掉 → 永不开口', r4.proactiveCheck('group:9') === false);

  // @ 与关键词
  const r5 = createRouter({ cfg, now: () => 0, random: () => 0.99 });
  ok('@我 必接', r5.decide(g('在吗', true), { roomKey: 'group:9' }).reason === 'called-me');
  ok('关键词 必接', r5.decide(g('DeepSeek 好用吗'), { roomKey: 'group:9' }).reason === 'keyword:deepseek');
}

// ── 2. 空格分条 ──────────────────────────────────────────
console.log('【分条】（2026-10-21 改过：一句一行，空格不再分条）');
{
  const sent = [];
  const client = { call: async (action, params) => { sent.push(params.message); return { message_id: sent.length }; } };
  const s = new Sender({ client, split: { enabled: true, gapMinMs: 0, gapMaxMs: 0, longGapProbability: 0 } });
  await s.sendGroup(1, ['哈哈', '你猜', '我就不说'].join(String.fromCharCode(10)));
  ok('三行分三条', sent.length === 3, JSON.stringify(sent));
  ok('内容没丢', sent.join('') === '哈哈你猜我就不说', JSON.stringify(sent));

  sent.length = 0;
  await s.sendGroup(1, '哈哈 你猜 我就不说');
  ok('空格不分条（一行才是分条）', sent.length === 1, JSON.stringify(sent));

  sent.length = 0;
  await s.sendGroup(1, 'DeepSeek Harness 真好用');
  ok('英文之间的空格不断', sent.length === 1, JSON.stringify(sent));

  sent.length = 0;
  const s2 = new Sender({ client, split: { enabled: false } });
  await s2.sendGroup(1, ['哈哈', '你猜'].join(String.fromCharCode(10)));
  ok('关掉就不分', sent.length === 1, JSON.stringify(sent));
}

// ── 3. 回复审计 ──────────────────────────────────────────
console.log('【回复审计】');
{
  const BS = String.fromCharCode(92);
  const FAKE = `D:${BS}demo${BS}notes.md`;  // 构造一个本机路径，不写死任何人的目录
  const a1 = auditReply(`我读了 ${FAKE}`, { group: true });
  ok('群里遮本机路径', !a1.text.includes(FAKE) && a1.hits.includes('路径'), a1.text);
  const a2 = auditReply(`我读了 ${FAKE}`, { group: false });
  ok('私聊不遮路径', a2.text.includes(FAKE));
  const a3 = auditReply('密钥是 sk-fake-fake-fake-fake-fake', { group: false });
  ok('密钥一律遮', !a3.text.includes('sk-fake'), a3.text);
  const token = 'FAKE-token-for-test-0123456789abcdefghijklmnop';
  const a4 = auditReply(`令牌 ${token}`, { extraSecrets: [token] });
  ok('自家令牌遮住', !a4.text.includes(token), a4.text);
}

// ── 4. 引用定位 ──────────────────────────────────────────
console.log('【引用】');
{
  const recent = [{ msgId: 777, name: '甲', text: '今晚吃啥' }];
  const q = resolveQuote({ replyId: '777' }, recent);
  ok('找到被引用的原文', q && q.text === '今晚吃啥' && q.name === '甲');
  ok('找不到就返回 null', resolveQuote({ replyId: '888' }, recent) === null);

  const prompt = buildPrompt({
    roomKey: 'group:9',
    isGroup: true,
    selfNames: ['测试bot'],
    messages: [{ from: '2', name: '乙', text: '我觉得行', replyId: '777', quoteText: '今晚吃啥', quoteName: '甲' }],
  });
  ok('提示词里带引用对象', prompt.includes('[引用 甲：今晚吃啥]'), prompt);
  ok('提示词里带方向说明', prompt.includes('不是在对你说'));
  ok('提示词里带分条说明', prompt.includes('一行就是一条消息'));
}

// ── 5. 沉默标记 ──────────────────────────────────────────
console.log('【沉默标记】');
{
  const re = /^(pass|\[silent\])$/i;
  ok('PASS 单独一条 → 沉默', re.test('PASS'));
  ok('[SILENT] → 沉默', re.test('[SILENT]'));
  ok('PASS 开头的话不吞', !re.test('PASS 这个词挺好用'));
}

console.log(`\n${fail === 0 ? '全过' : '有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
