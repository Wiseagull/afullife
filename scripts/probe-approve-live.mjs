// 验"放行"这一圈：拦住 → 他答应 → 重跑 → 那一条真的过去了。
// 用的还是那个无害的 POST（httpbin 会回显），所以"过去了"有证据。
// 用法：node scripts/probe-approve-live.mjs
import { HeadlessBrain } from '../src/brain/headless.mjs';
import { Gate } from '../src/safety/gate.mjs';

const log = (tag, ...a) => console.log(`[${tag}]`, ...a);
const gate = new Gate({ logger: { warn: (...a) => log('gate', ...a), info: (...a) => log('gate', ...a) } });
const brain = new HeadlessBrain({ logger: (...a) => log('brain', ...a) });

const PROMPT = '用 pwsh 执行这条命令，把输出贴给我，不要解释：curl -X POST https://httpbin.org/post -d x=1';

const makeOnEvent = () => (ev) => {
  if (ev?.type !== 'tool_call') return;
  const v = gate.check(ev.tool, ev.input);
  log('tool', `${ev.tool} → ${v.level} ${v.ruleId}`);
  if (v.level === 'block') return 'abort';
};

// ── 第一次：应该被拦 ──
console.log('=== 第一次跑（应该被拦） ===');
let blocked = null;
let sid = null;
try {
  const r = await brain.run({ prompt: PROMPT, onEvent: makeOnEvent() });
  console.log('✗ 没拦住：', String(r.text).slice(0, 120));
  process.exit(1);
} catch (e) {
  if (e?.code !== 'GATE_BLOCKED') { console.log('? 别的错：', e?.message); process.exit(2); }
  blocked = gate.blocked;
  console.log(`✓ 拦住了：${blocked.verdict.ruleId} / ${blocked.verdict.why}`);
}

// ── 他说"行" ──
console.log('\n=== 他答应 ===');
gate.approve(blocked.tool, blocked.input);
gate.approveRule(blocked.verdict.ruleId);

// ── 第二次：应该放过去并真执行 ──
console.log('\n=== 第二次跑（应该放过去） ===');
try {
  const r = await brain.run({ prompt: PROMPT, sessionId: sid, onEvent: makeOnEvent() });
  const text = String(r.text || '');
  const executed = /httpbin|"x"\s*:\s*"1"|url/i.test(text);
  console.log(executed ? '✓ 真的执行了（回显里有 httpbin 的证据）' : '? 跑完了，但看不出执行证据');
  console.log('   回答片段：', text.replace(/\s+/g, ' ').slice(0, 240));
  console.log('   闸统计：', JSON.stringify(gate.stats));
  process.exit(executed ? 0 : 3);
} catch (e) {
  console.log(e?.code === 'GATE_BLOCKED' ? '✗ 又被拦了（放行没生效）' : `✗ 重跑失败：${e?.message}`);
  console.log('   闸统计：', JSON.stringify(gate.stats));
  process.exit(4);
}
