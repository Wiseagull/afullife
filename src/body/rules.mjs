// 规程按需挂。
//
// 以前每一轮都把"命令怎么写、表情怎么收、记忆怎么整"十几条说明挂上去，
// 结果她读到最后就顺着那股规程腔说话——聊着天也像在交报告。
//
// 现在默认精简，只有这一轮看着像要动手才挂全套。
// 判断错了不死人：规程不是权限，工具每轮都在下发，没挂说明她也照样能调，
// 只是少了提示。所以宁可少挂，不可多挂。

/** 精简版：纯说话时她需要知道的，只有这几条 */
const CHAT_PRIVATE = [
  '【这一轮主要是说话】',
  '- 不用 Markdown、列表、总结式结尾。',
  '- 一句一行（按回车分），一行就是一条消息，日常一两条就够。',
  '- 你手上有什么工具、怎么用，自己清楚——真要动手就正常调，别因为这里没写就不用。',
].join('\n');

const CHAT_GROUP = [
  '【这一轮主要是听着/说话】',
  '- 不用 Markdown、列表、总结式结尾。',
  '- 一句一行（按回车分），一行就是一条消息；不想接就只回 PASS。',
  '- 你手上有什么工具、怎么用，自己清楚——真要动手就正常调，别因为这里没写就不用。',
].join('\n');

export function chatRules(isGroup) {
  return isGroup ? CHAT_GROUP : CHAT_PRIVATE;
}

// 动作词：只是"像在派活"的一半，还得有对象（路径/链接/代码/报错/图）才算
const ACTIONS = [
  '改', '写', '修', '跑', '执行', '装', '删', '查', '搜', '打开', '下载',
  '生成', '画', '出图', '转成', '发给', '部署', '推上去', '重装', '更新',
  '清理', '统计', '对比', '检查', '分析', '看看', '试试', '读一下', '看一眼',
  '换成', '加上', '去掉', '替换', '合并', '拆分', '重启', '停掉', '拉起来',
];

// 对象：这才是"真要动手"的证据
const OBJECTS = [
  { re: /[A-Za-z]:[\\/]/, why: '盘符路径' },
  { re: /(^|[\s(（])\.{0,2}[\\/][\w.-]/, why: '相对路径' },
  { re: /https?:\/\//i, why: '链接' },
  { re: /```|`[^`\s][^`]*`/, why: '代码' },
  { re: /\b(const|let|var|function|class|import|export|return|def|async|await)\b|=>|[{}]\s*;?$/, why: '代码片段' },
  { re: /\b(Error|TypeError|ReferenceError|RangeError|SyntaxError|Traceback|exit code)\b|报错|异常|崩了|打不开|跑不起来|没反应/i, why: '报错' },
  { re: /\.[a-z]{2,5}\b/i, why: '文件名' },
  { re: /\bgit\b|\bnpm\b|\bnode\b|\bpip\b|\bpnpm\b/i, why: '命令' },
];

/**
 * 这一轮要不要挂全套规程。
 *
 * 边界（2026-10-24 定的，别往回走）：
 *   这里的关键词只决定「这一轮用哪套规程」——一次性、随消息走。
 *   它绝不许改她跨轮的状态（记忆、关系、在忙什么、困不困）。
 *   理由是：误判一句话的代价是这一轮多挂几行规程，代价小；
 *   而误判一旦能改状态，就等于把「正则没认出这是正经事」写进她的人格里。
 *   要改状态，只能走她自己的显式动作（比如 <busy:…> 那种她自己写出来的）。
 *
 *   至于「什么话能说、什么话不能说」，代码里一个字都不该有——
 *   那是人设文件（persona/、AGENTS.md）的事，交给写人设的人。
 *   代码一旦开始判内容，换个主人想放宽或收紧都得改代码，那就成了「不可配置的红线」。
 *
 * @param {object} o
 * @param {boolean} o.isGroup
 * @param {Array<{text?:string, atMe?:boolean, images?:string[], quoteText?:string}>} o.messages
 * @param {boolean} [o.addressed] 群里是不是点了她的名
 * @param {boolean} [o.toolsJustUsed] 这个房间刚动过手（干活是连续的）
 * @returns {{full: boolean, reason: string}}
 */
/**
 * 她在轻装那一轮里自己要求换全套工具。
 *
 * judgeFull 那套是在猜「他要不要动手」；这个不是猜——是她自己说的。
 * 她说「这轮没看到这个工具」，比任何启发式都准。
 */
export function wantsFullTools(text) {
  const s = String(text || '');
  if (/<full\s*\/?>/i.test(s)) return true;
  return /(我要|我想|我得|需要)(用)?全套工具/.test(s);
}

export function judgeFull({ isGroup = false, messages = [], addressed = false, toolsJustUsed = false } = {}) {
  const list = Array.isArray(messages) ? messages : [];

  // 手里没消息（比如只是被叫了一句），谈不上派活
  const joined = list.map((m) => String(m?.text ?? '')).join('\n').trim();

  // 带图 = 多半要我看/用它
  if (list.some((m) => (m?.images?.length ?? 0) > 0)) {
    return { full: true, reason: '带了图' };
  }

  // 引用的是一条报错/一段代码
  const quoted = list.map((m) => String(m?.quoteText ?? '')).join('\n');
  if (quoted && OBJECTS.some((o) => o.re.test(quoted))) {
    return { full: true, reason: '引用了代码/报错' };
  }

  if (!joined) return { full: false, reason: '没有说话内容' };

  // 直接贴一段报错（TypeError: … / Traceback / exit code / at file:line）——
  // 不管有没有动词、有没有问号，这就是"来看看这个"
  if (/\b(TypeError|ReferenceError|RangeError|SyntaxError|Error):|Traceback \(most recent call last\)|exit code \d+|\bat\s+\S+:\d+:\d+/i.test(joined)) {
    return { full: true, reason: '贴了报错栈' };
  }

  const hitAction = ACTIONS.find((w) => joined.includes(w));

  // 群里的口径更严：得点了名、还得像派活
  if (isGroup && !addressed) {
    return { full: false, reason: '群里没点我名' };
  }

  if (hitAction) {
    const obj = OBJECTS.find((o) => o.re.test(joined));
    if (obj) return { full: true, reason: `命中「${hitAction}」+ ${obj.why}` };
    // 私聊里他直接说"你改一下""帮我看看"，也算派活——对象是默契
    if (!isGroup && /帮我|你(去|来)?(改|写|修|跑|查|装|删|画|看看|试试|看下)|麻烦/.test(joined)) {
      return { full: true, reason: `命中「${hitAction}」（没写对象，但口气是派活）` };
    }
  }

  // 没动词，但贴了报错/代码/路径还在问"这是啥"——那也是要我看
  if (!hitAction && /[?？]|为什么|咋回事|怎么回事|什么原因|啥情况|看一下|看下/.test(joined)) {
    const obj = OBJECTS.find((o) => o.re.test(joined));
    if (obj) return { full: true, reason: `贴了${obj.why}还在问` };
  }

  // 干活是连续的：上一轮动过手，这一轮还在同一条线上
  if (toolsJustUsed) return { full: true, reason: '接着上一轮动手' };

  return { full: false, reason: '像在闲聊' };
}
