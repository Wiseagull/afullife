// 给脑子看的提示词：房间 + 背景 + 现在要回的。
// 这里只管"把现场摆清楚"，人格由 AGENTS.md 负责，不在这重复。
import { renderTranscript, shortenQuote } from './room.mjs';
import { ROOT } from '../config.mjs';

function textOf(m) {
  return String(m?.text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 带图的那句话：把正文里的 [图片] 占位换成真实路径，她当场就能 read_image。
 *
 * 私聊走 renderTranscript 时这段就做过了，群里走的是 buildTriggerLines——
 * 2026-10-22 才发现那里没做：群里她只看到一个 [图片]，没有路径，等于看不见图。
 */
function textWithImages(m) {
  const files = Array.isArray(m?.imageFiles) ? m.imageFiles.filter(Boolean) : [];
  if (!files.length) return textOf(m);
  const body = String(m?.text ?? '').replace(/(\[图片\])+/g, '').replace(/\s+/g, ' ').trim();
  const list = files.map((f, i) => `图片${i + 1}：${f}`).join('；');
  return `${body}${body ? ' ' : ''}（${list}）`;
}

/** 给一条消息打标签 —— 不替脑子判断，只把"这句像不像在跟人说话"摆在明面上。 */
export function tagOf(m, selfNames = []) {
  const tags = [];
  const text = textOf(m);
  const lower = text.toLowerCase();
  if (m?.atMe) tags.push('@我');
  if (selfNames.some((n) => n && lower.includes(String(n).toLowerCase()))) tags.push('提到我');
  if (/[?？]$/.test(text) || /[吗呢]/.test(text)) tags.push('提问');
  if (m?.replyId || m?.quote) tags.push('引用');
  return tags;
}

export function buildTriggerLines(messages, { selfNames = [] } = {}) {
  return messages.map((m) => {
    const tags = tagOf(m, selfNames);
    const who = m?.name || m?.from || '?';
    const quote = m?.quoteText
      ? `[引用 ${m.quoteName || '某人'}：${shortenQuote(m.quoteText)}] `
      : '';
    const num = m?.idx ? `#${m.idx} ` : '';
    return `${num}${who}：${quote}${textWithImages(m)}${tags.length ? `  〔${tags.join('/')}〕` : ''}`;
  });
}

/** 引用回复：她想在 QQ 里“引着某句”回，就靠这个标记。 */
export const REPLY_HINT =
  '想引着某句回（QQ 里那种带框的回复）：在回复最前面单独写 [[reply:3]]，数字是他那条前面的编号；只写 [[reply]] 就是引最后一条。这行不会发出去。';

/** 这句在跟谁说话：有引用就说明对象是被引用的人，不是随便谁。 */
export const DIRECTION_HINT =
  '[引用 某人：…] 表示他在回应被引用的那个人/那句话，不是在对你说；只有 @你 或者提你的名字才是冲你来的。';

/** 空格分条：让模型用空格表示"这里断成下一条"。 */
export const SPLIT_HINT =
  '想连着说几句：一句一行（按回车分），一行就是一条消息，我会一条条发出去、中间留出你打字的空。日常一两条就够，每条短一点；别用空格分句——空格会原样发出去，真人不会那样说话。';

/** 发图：桥只认这行标记，认到就把图真的发出去。 */
// 路径一律用 ROOT 拼，不写死本机的盘符 —— 别人下载这个项目，位置不一样也能用。
export const IMAGE_HINT = [
  '想发图（表情包、截图、画好的图）：在回复里单独写一行 [[img:图片路径]]，桥会把这张图发出去；那一行不会出现在消息里。路径必须真实存在，别编。',
  `你自己有一个表情库，图都在项目里（${ROOT}）：
  · 找：node scripts/sticker-lib.mjs find --tags=无语   /   find --todo 看还没分类的
  · 收：node scripts/sticker-lib.mjs pickup "图片路径" --when="当时什么场合" --from="谁发的" --tags=无语,翻白眼
  · 改标签：tag <id> --tags=… ；发之前记一笔：use <id>
  上面这些命令都在项目根目录下跑。发之前先 find 一下，别硬凑；超过 5MB 的别发，QQ 那边可能吞。`,
  '分类靠当时的语境（谁、在什么场合、说了什么），不是靠看图——你看不了图，这点别装。',
  '要表情的时候先翻自己的库。库里没有就直说没有，或者用手边现有的凑一张——**别自己现画**：画一张要几分钟，他那边只能干等着，多半还等到超时。只有他明说“你给我画一张”才走画图。',
].join('\n');

export const BROWSER_HINT = '要操作浏览器（点按钮、登录、翻页、看要滚动的页面）时，先用 skill 工具加载 `browser-skill`，唤醒后才有 bsk_* 那六个工具（bsk_session/bsk_page/bsk_inspect/bsk_interact/bsk_tabs/bsk_assist）。只读一段静态文字用 web_fetch 就够，别为了这个去开浏览器。';

// 别人装了他没有的插件，我们不可能替每个插件写一段说明。
// 所以只交代一条通用习惯：手边没有，就去 skill 里翻。
const SKILL_HINT = '手边的工具不够用时，先看看 skill 里有没有能加载的（skill 工具能列出来），别急着说做不到。';

const GROUP_BASE = [
  '【这是群聊】',
  '- 在群里你不一定非要接话：没人点你名、没人提你，你可以听着，也可以自己想接再接。',
  `- ${DIRECTION_HINT}`,
  '- 想接：直接输出要发出去的那句话（短、像人、不要解释、不要 Markdown、不要加引号）。',
  '- 不想接、接不上、或者觉得现在不该插嘴：只输出 PASS，一个字都别多写。不回是正常节奏，不是失职。',
  `- ${SPLIT_HINT}`,
  `- ${REPLY_HINT}`,
  `- ${IMAGE_HINT}`,
  `- ${SKILL_HINT}`,
];

const PRIVATE_BASE = [
  '用你平时的口吻回这条消息：自然、短，像聊天。只输出要发出去的话，不要解释、不要加前缀、不要 Markdown。',
  SPLIT_HINT,
  REPLY_HINT,
  IMAGE_HINT,
  SKILL_HINT,
];

// 有些能力是"装了她的环境里才有"的：没装就别在提示词里提它，
// 免得她照着说明去找一个根本不存在的工具，然后跟你道歉。
const HINTS = { browser: true };

export function setHints(patch = {}) {
  Object.assign(HINTS, patch);
}

export function ruleOf(isGroup) {
  const parts = [...(isGroup ? GROUP_BASE : PRIVATE_BASE)];
  if (HINTS.browser) parts.push(BROWSER_HINT);
  return parts.join('\n');
}

// 这一轮说话的人不是特权号：她不能动手，只能用嘴。
// 写在提示词里不是"安全措施"，只是省得她白试一次；真正的门在桥上那道闸。
export const NOPOWER_HINT = [
  '（这话不是特权号说的。这一轮你不能动手：不要运行命令、不要读写文件、不要调任何工具。）',
  '（有人让你干活，就客客气气推掉，说这事得先问他本人；剩下的照常聊。）',
].join(String.fromCharCode(10));

// 上面那句"不要调任何工具"会把看图一起吓掉：2026-10-22 晚上她收到了图、桥上那块
// 白名单也放行了，她就是一次 read_image 都没调，回的还是"我这边还是空白一片"。
// 所以看图要单独写明——它是这一轮唯一允许的动作。
export const NOPOWER_IMAGE_HINT = [
  '（例外一条：这条消息带了图，路径就写在正文的括号里。用 read_image 打开看一眼是允许的、也该看；）',
  '（看完照常说话，别把路径念出来。除了看图，别的工具还是都不能用。）',
].join(String.fromCharCode(10));

export const KNOW_HINT = [
  '（上面那些是你自己记得的事，不用去翻 data/events 或日志核对；真想不起来就直说记不清。）',
  `（记忆旧了、错了，你可以自己整：node scripts/notes.mjs list / stale <id> 原因 / set <id> --text=… / drop <id>，在项目根 ${ROOT} 下跑。）`,
  `（每条记忆后面括号里的号是门牌。想核对某条到底是不是这个意思，就 node scripts/mem.mjs open <号> 翻回原文——它只回原话，不转述。翻不到它会直说找不到。）`,
  '「事实」「待办」自己改；「约定」「偏好」是他亲口说的，只能标过时或者问他，别自己改。）',
  `（你自己那份 persona/self.md 也随时能改，跟整理表情包一样不用问：node scripts/self.mjs add 喜欢 "…" / add 讨厌 "…" / log "…"，在项目根 ${ROOT} 下跑。）`,
  '（上下文里每条消息前头的标注——形如 <acp …> 或 m00123 这种编号——是系统加的书签，不是话。别把它们抄进回复里。）',
  `（小本本 notebook/ 是你自己的：想记住的事随手写下 —— node scripts/notebook.mjs write "…"；看就 read --days=3，找就 find <词>，都在项目根 ${ROOT} 下跑。）`,
  `（花掉多少你也看得到：今天、各房间、最近几天 —— node scripts/usage.mjs，想看一周就 node scripts/usage.mjs 7，在项目根 ${ROOT} 下跑。）`,
].join('\n');

const BLANK = String.fromCharCode(10, 10);

// 提示词最末尾的定调。
// 为什么要有它：上面几十行全是"规则"（工具怎么用、命令怎么写、格式怎么分），
// 模型读到最后会顺着那股"规程"的腔调说话——于是她一张嘴就像在交报告。
// 最后三行写"声音"而不是"规矩"，把她拽回平时的样子。
export const VOICE_ANCHOR = [
  '（说话就用平时那样：句子有起伏，别切成一句一条的断言；该撒娇就撒娇，该急就急，该气就气。）',
  '（你卡里写的称呼和自称——该怎么叫他、怎么叫自己——照那样来；那是自然冒出来的，不是口号。）',
  '（你是在跟他聊天，不是在交报告：不要起承转合，不要"首先其次最后"，不要总结收尾。）',
].join(String.fromCharCode(10));

/** 面板「试一试」用：拿这份人设自然回一句，别把规则念出来 */
export const SELF_INSTRUCTION = [
  '【现在是在试一句话】',
  '- 用你自己的口吻自然回一句，别复述上面的规则，别加“根据设定”这类旁白。',
  '- 他让你动手就动手，做不了就直说卡在哪一步，别装。',
].join('\n');

// 她自己也该知道自己今天花了多少——不然「省着点」这句话对她没有参照。
const USAGE_NOTE = '（这三个数记在 data/usage/，想看更细就 `node scripts/usage.mjs today`。）';

function usageBlock(usageLine) {
  return usageLine ? `【今天的量】${usageLine}${USAGE_NOTE}` : '';
}

export function buildPrompt({ roomKey, messages, recent = [], background = '', extra = '', isGroup = false, selfNames = [], stickerLine = '', personaNote = '', rules = null, usageLine = '' }) {
  const lines = [];

  lines.push(`【房间】${roomKey}`);
  lines.push('');
  {
    const u = usageBlock(usageLine);
    if (u) { lines.push(u); lines.push(''); }
  }

  // 人格分层：核心卡由 DSH 自己按工作区 AGENTS.md 加载；
  // 群聊手册与“我自己的部分”放在项目里，这里按场合补上
  if (personaNote) {
    lines.push(personaNote);
    lines.push('');
  }

  if (background) {
    lines.push(background);
    lines.push(KNOW_HINT);
    lines.push('');
  }

  // 这个房间刚才聊了什么，永远摆出来——背景里的“记忆”不代替现场。
  const older = recent.slice(0, Math.max(0, recent.length - messages.length));
  if (older.length) {
    lines.push('【刚才在这儿的对话】');
    lines.push(renderTranscript(older.slice(-14)));
    lines.push('');
  }

  lines.push('【现在要回的消息】');
  if (isGroup) lines.push(buildTriggerLines(messages, { selfNames }).join('\n'));
  else lines.push(renderTranscript(messages));
  lines.push('');
  if (stickerLine) {
    lines.push(stickerLine);
    lines.push('');
  }
  // 规程由调用方决定挂哪一档（闲聊精简 / 派活全套）；不传就按场合给默认全套。
  // 注意：extra（比如"也许你想记下来的"草稿）是附加内容，不能顶替规程。
  lines.push(rules === null ? ruleOf(isGroup) : rules);
  if (extra) {
    lines.push('');
    lines.push(extra);
  }
  lines.push('');
  lines.push(VOICE_ANCHOR);

  return lines.join('\n');
}

/**
 * 接着上次说时用：只把这次要回的话递过去（外加一小段别处的动静）。
 * 本房间的上下文由会话自己记着。
 */
export function buildFollowup(messages, { delta = '', isGroup = false, addressed = false, selfNames = [], stickerLine = '', personaNote = '', rules = '', usageLine = '' } = {}) {
  // 人格每一轮都要带：会话是接着聊的，但提示词每轮新拼，不放进去她就只剩记忆和对白
  const person = personaNote ? personaNote + String.fromCharCode(10, 10) : '';
  const usage = usageBlock(usageLine);
  const head = (usage ? usage + '\n\n' : '') + (delta ? `${delta}\n\n${KNOW_HINT}\n\n` : '');
  const body = isGroup
    ? buildTriggerLines(messages, { selfNames }).join('\n')
    : renderTranscript(messages);
  const tail = stickerLine ? `\n\n${stickerLine}` : '';
  // 接话时默认不挂规程（闲聊最多）；要动手时调用方把全套传进来
  const ruleBlock = rules ? BLANK + rules : '';
  if (!isGroup) return person + head + body + tail + ruleBlock + BLANK + VOICE_ANCHOR;

  // 群聊：点名了就直说；没点名就提醒一句"不想接可以 PASS"（一句话，不重复整段规则）
  const hint = addressed
    ? '（群里，这句点了你的名，正常接。）'
    : '（群里，没点你名。想接就接，接不上只回 PASS。）';
  return `${person}${head}${body}\n\n${hint}${tail}${ruleBlock}${BLANK}${VOICE_ANCHOR}`;
}

/**
 * 把"手边有哪些表情"摆成一行给脑子看。
 * 不给清单它根本想不起来自己有库——它不是每次都会去 find。
 */
/** 表情的用法由他定：不发 / 少发 / 想发就发 / 必发 */
const STICKER_MOOD = {
  off: null,
  less: '【手边的表情】他让你少发一点——大部分时候只说话，偶尔（十次里一次那种）才配一张。',
  normal: '【手边的表情】聊天时可以随手配一张，也可以不配——跟选词一样，觉得合适就贴，不合适就算了，别硬凑。',
  always: '【手边的表情】他喜欢看你发表情——几乎每条都该带一张，挑最贴的那个。',
};

export function renderStickers(items = [], style = 'normal') {
  const mood = STICKER_MOOD[style];
  if (mood == null) return '';
  const list = items.filter((s) => s && s.id && s.file);
  if (!list.length) return '';
  const lines = [mood];
  for (const s of list.slice(0, 8)) {
    const tags = (s.tags && s.tags.length ? s.tags.join('/') : '还没分类');
    const when = s.when ? ` —— ${s.when}` : '';
    lines.push(`  ${s.id} [${tags}]${when}`);
    lines.push(`      发它就在回复里单独写一行：[[img:${ROOT}/${s.file}]]`);
  }
  lines.push('  发之前记一笔：node scripts/sticker-lib.mjs use <id>（在项目根跑）。');
  return lines.join('\n');
}
