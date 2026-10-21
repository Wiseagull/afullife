// 把她偶尔吐出来的"系统标签"擦掉再发。
//
// 2026-10-21 出现过两次：正文前面多一行会话标注 —— 那是代理注入的 ACP 标记
// （每条消息前面都会挂一个 `<acp …>` 标签），
// 模型偶尔会把上一条的编号当成开头照着写。
//
// 这类东西绝不该出现在 QQ 里：对方看到的就是一串乱码。所以在发送前统一擦掉，
// 而不是指望模型每次都想起来不许抄。
//
// 擦的时候要留神别误伤：`M4A1`、`m4a1`、`m1 芯片` 这种正常词不能碰。
// 所以只在两个位置动手：整行就是一个编号，或者行首挂着编号再跟正文。

/** <acp …> … </acp> 这种成对/落单的标注 */
const ACP_TAG = /<\/?acp\b[^>]*>/gi;
const ACP_PAIR = /<acp\b[^>]*>[\s\S]*?<\/acp>/gi;
/** 宿主注入的提醒块（万一被复述出来） */
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/gi;

/** 一条 ACP 书签：m00123 / m00456 / m00abc —— m 开头，后面至少一个数字 */
const REF_TOKEN = 'm[0-9][0-9a-z]{3,7}';
/** 整行只有它 */
const LONE_REF = new RegExp(`^\\s*${REF_TOKEN}\\s*$`, 'i');
/** 行首挂着它，后面紧跟正文（中文/空白都算） */
const LEADING_REF = new RegExp(`^[ \\t]*${REF_TOKEN}(?=[\\s\\u3000-\\u9fff]|$)`, 'i');

export function stripLeaks(text) {
  let s = String(text ?? '');

  s = s.replace(ACP_PAIR, ' ').replace(ACP_TAG, ' ').replace(REMINDER, ' ');

  const lines = [];
  for (const raw of s.split(/\r?\n/)) {
    if (LONE_REF.test(raw)) continue; // 整行就是书签 → 整行丢
    const line = raw.replace(LEADING_REF, '').replace(/[ \t]+$/, '');
    if (line.trim() === '' && raw.trim() !== '') continue; // 行首书签擦完变空 → 也丢
    lines.push(line);
  }
  s = lines.join('\n');

  // 擦完可能留下多余空行
  s = s.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return s;
}
