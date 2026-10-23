// "我正在干活，他插了一句" —— 先回一句，再继续。
//
// 场景（2026-10-23 主人定）：她一轮能干五六分钟（筛表情、翻文件、画图），
// 这几分钟里主人发来的话只能干等，看起来就是"她不说话了"。
// 现在改成：主人开口时如果她正在跑，桥另起一个**很短**的脑（不带工具、不开会话），
// 用她自己的人设说一句"我在做什么"，然后原来那一轮该干嘛干嘛。
//
// 这个文件只负责拼那一句的提示词，其余（判断该不该发、发去哪）在 src/main.mjs。

/** 工具名 → 人话，只挑常见的，没收录的就原样说 */
const TOOL_WORD = {
  read: '翻文件',
  write: '写文件',
  edit: '改文件',
  glob: '找文件',
  grep: '搜代码',
  pwsh: '跑命令',
  ops_bash: '跑命令',
  read_image: '看图',
  generate_image: '画图',
  edit_image: '改图',
  web_fetch: '翻网页',
  web_search: '上网查',
  skill: '看工具说明',
  subagent: '派人干活',
};

/**
 * 把这一轮已经调过的工具，说成一句人话。
 * @param {string[]} tools 本次运行里出现过的工具名（按出现顺序）
 * @returns {string} 例如 "看图、跑命令"
 */
export function describeDoing(tools = []) {
  const seen = [];
  for (const t of tools) {
    const name = String(t || '');
    if (!name) continue;
    const word = TOOL_WORD[name] || (name.startsWith('mcp__') ? '用外部工具' : name);
    if (!seen.includes(word)) seen.push(word);
  }
  if (!seen.length) return '想了想事情';
  return seen.slice(0, 4).join('、');
}

/**
 * 拼"先回一句"的提示词。
 * @param {{personaNote?: string, doing?: string, minutes?: number, ownerText?: string, recent?: string}} p
 */
export function asidePrompt({ personaNote = '', doing = '', minutes = 1, ownerText = '', recent = '' } = {}) {
  const lines = [];
  if (personaNote) {
    lines.push(personaNote.trim(), '');
  }
  lines.push('【现在的情况】');
  lines.push(`你手上还有一件事没做完（已经做了 ${Math.max(1, Math.round(minutes))} 分钟，正在${doing || '忙着'}），`);
  lines.push('这时候他跟你说话了。');
  if (recent) lines.push(`刚在这儿的对话：\n${recent}`);
  lines.push(`他刚说：${ownerText || '（没说什么）'}`);
  lines.push('');
  lines.push('用你自己的口气回他**一句**：说清你手上在忙什么、马上就回来。');
  lines.push('要求：只回这一句，不要解释流程，不要列清单，不要道歉铺垫，也不要说"我先忙完"以外的空话；');
  lines.push('不超过 40 字；这一句发出去之后你会继续把手里那件事做完。');
  return lines.join('\n');
}
