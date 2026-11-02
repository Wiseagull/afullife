// 文本处理：QQ 不吃 Markdown，长文要切。
// 只做保守清洗 —— 宁可少删，不要把一个正常句子改坏。

/** Markdown → 纯文本（保留代码内容，去掉标记）。 */
export function toPlain(md) {
  let s = String(md ?? '');
  if (!s) return '';

  // 代码块：保留内容，去掉围栏与语言标注
  s = s.replace(/```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g, (_, code) => code.replace(/\n$/, ''));
  // 行内代码
  s = s.replace(/`([^`]+)`/g, '$1');
  // 标题
  s = s.replace(/^#{1,6}\s+/gm, '');
  // 图片与链接：[文字](地址) → 文字；![alt](src) → alt
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
  // 加粗 / 斜体 / 删除线
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/__([^_]+)__/g, '$1');
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?]|$)/g, '$1$2');
  s = s.replace(/~~([^~]+)~~/g, '$1');
  // 引用与分隔线
  s = s.replace(/^>\s?/gm, '');
  s = s.replace(/^\s*([-*_])\1{2,}\s*$/gm, '');
  // 表格分隔行
  s = s.replace(/^\s*\|?[\s:-]+\|[\s:|-]*$/gm, '');
  s = s.replace(/^\s*\|(.*)\|\s*$/gm, (_, row) => row.split('|').map((c) => c.trim()).join('  '));
  // 多余空行
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/**
 * Markdown 图片 → 发图标记。
 * QQ 不认 Markdown，而 toPlain 会把 ![说明](路径) 削成只剩「说明」两个字，
 * 路径跟着被吃掉：图静默发不出去，他那边只看到一行没头没脑的话。
 * 所以在清洗之前先把图片抠成 [[img:路径]]，走桥里发图那条通路。
 */
export function markdownImagesToTags(md) {
  return String(md ?? '').replace(
    /!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^)\s]+))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g,
    (_m, angled, plain) => `[[img:${String(angled || plain).trim()}]]`,
  );
}

/**
 * 把正文里的图抠成路径：Markdown 图片和 [[img:绝对路径]] 两种写法都认。
 * 回话那条路（sendTurn）另有一份带审计占位符的，这一份给自由活动用。
 * 2026-10-30 从 main.mjs 挪过来：纯函数，摆在这儿 selftest 才够得着。
 */
export function pullImagePaths(text) {
  const paths = [];
  const stripped = markdownImagesToTags(text).replace(/\[\[img:([^\]]+)\]\]/gi, (_m, p) => {
    paths.push(String(p).trim().replace(/^["']|["']$/g, ''));
    return '';
  });
  return { text: stripped.replace(/[ \t]+\n/g, '\n').trim(), paths: paths.filter(Boolean) };
}

/**
 * 把长文切成若干段，尽量在段落 > 换行 > 句末标点处断开。
 * 单段都不超过 max；切不动时硬切。
 */
export function splitMessage(text, max = 1200) {
  const s = String(text ?? '').trim();
  if (!s) return [];
  if (s.length <= max) return [s];

  const out = [];
  let rest = s;

  while (rest.length > max) {
    const window = rest.slice(0, max);
    // 候选断点：段落、换行、句末、逗号、空格
    const marks = ['\n\n', '\n', '。', '！', '？', '；', '. ', '! ', '? ', '，', ', ', ' '];
    let cut = -1;
    for (const m of marks) {
      const i = window.lastIndexOf(m);
      if (i > max * 0.4) { cut = i + m.length; break; }
    }
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

/**
 * 一行太长时按句末标点断开，每段尽量不超过 softMax。
 * 尾巴太短就并回上一段 —— 别单独发出去一条「……嗯。」
 */
export function splitSentences(text, softMax = 120) {
  const s = String(text ?? '').trim();
  if (!s) return [];
  if (s.length <= softMax) return [s];

  const marks = ['。', '！', '？', '…', '；', '!', '?', '.', '，', ','];
  const out = [];
  let rest = s;
  while (rest.length > softMax) {
    const window = rest.slice(0, softMax);
    let cut = -1;
    for (const m of marks) {
      const i = window.lastIndexOf(m);
      if (i >= softMax * 0.35) { cut = i + m.length; break; }
    }
    if (cut <= 0) {
      const sp = window.lastIndexOf(' ');
      cut = sp > softMax * 0.35 ? sp + 1 : softMax;
    }
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) {
    if (out.length && rest.length < softMax * 0.35) out[out.length - 1] += rest;
    else out.push(rest);
  }
  return out.filter(Boolean);
}

/** 压成一行（用于日志、标题）。 */
export function oneLine(text, max = 120) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}
