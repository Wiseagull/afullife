// 规程按需挂的用例表：node scripts/probe-rules.mjs
// 判断错一次不会坏事（规程不是权限），但判成"全套"太多就等于没改，所以要看命中率。
import { judgeFull, chatRules } from '../src/body/rules.mjs';

const cases = [
  // [说明, 入参, 期望 full]
  ['私聊闲聊', { isGroup: false, messages: [{ text: '在吗' }] }, false],
  ['私聊问感受', { isGroup: false, messages: [{ text: '你以前不是这样说话的' }] }, false],
  ['动词但没对象', { isGroup: false, messages: [{ text: '我想改主意了' }] }, false],
  ['改 + 文件名', { isGroup: false, messages: [{ text: '把 a.mjs 里的 3 改成 4' }] }, true],
  ['帮我看看（没写对象但是派活）', { isGroup: false, messages: [{ text: '帮我看看这个咋回事' }] }, true],
  ['贴报错', { isGroup: false, messages: [{ text: 'TypeError: x is undefined' }] }, true],
  ['贴链接让查', { isGroup: false, messages: [{ text: '看看这个 https://example.com' }] }, true],
  ['带图', { isGroup: false, messages: [{ text: '这啥', images: ['http://x/1.png'] }] }, true],
  ['引用的是代码', { isGroup: false, messages: [{ text: '这是啥', quoteText: 'const a = 1;' }] }, true],
  ['上一轮动过手', { isGroup: false, messages: [{ text: '再来' }], toolsJustUsed: true }, true],
  ['群里没点我名', { isGroup: true, messages: [{ text: '把 a 改一下' }], addressed: false }, false],
  ['群里点了名 + 派活', { isGroup: true, messages: [{ text: '帮我把 a.mjs 改一下', atMe: true }], addressed: true }, true],
  ['群里点了名但闲聊', { isGroup: true, messages: [{ text: '在吗', atMe: true }], addressed: true }, false],
];

let pass = 0;
for (const [name, input, want] of cases) {
  const got = judgeFull(input);
  const ok = got.full === want;
  if (ok) pass += 1;
  console.log(`${ok ? '✓' : '✗'} ${name} → ${got.full ? '全套' : '精简'}（${got.reason}）${ok ? '' : ` 期望 ${want ? '全套' : '精简'}`}`);
}
console.log(`\n${pass} 通过 / ${cases.length - pass} 失败`);
console.log(`\n精简规程长这样：\n${chatRules(false)}`);
process.exit(pass === cases.length ? 0 : 1);
