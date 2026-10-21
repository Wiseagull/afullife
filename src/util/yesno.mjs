// “行 / 不行”的判定。
//
// 别用正则前缀加 \b：中文字符不是 \w，`/^行\b/` 永远匹配不到「行」——
// 这个坑真踩过，表现是“你答应了，它还在等”。
// 所以这里只做一件事：去掉标点和空白，整句比对。

const YES = new Set([
  '行', '行吧', '行啊', '可以', '可以呀', '好', '好啊', '好的', '嗯', '嗯嗯',
  '继续', '同意', '放行', '准', '准了', '放它过去', '让它过',
  'ok', 'okay', 'yes', 'y', 'yep', 'go', 'sure',
]);

const NO = new Set([
  '不行', '不可以', '不要', '不用', '别', '别动', '算了', '拒绝', '停', '停下',
  'no', 'nope', 'n', 'stop', 'cancel',
]);

const normalize = (text) => String(text ?? '')
  .replace(/[\s，。！？!?,、.~～…]/g, '')
  .toLowerCase();

export function isYes(text) {
  return YES.has(normalize(text));
}

export function isNo(text) {
  return NO.has(normalize(text));
}
