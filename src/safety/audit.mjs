// 发出去之前的审计：别把本机路径、密钥、令牌甩到聊天里。
// 发出去之前再过一道审计——思路来自 qq-bridge 的 SEND_AUDIT：闸管"要不要做"，这一层管"能不能说出去"。

const SECRET_RULES = [
  { re: /sk-[A-Za-z0-9_-]{16,}/g, to: 'sk-***' },
  { re: /Bearer\s+[A-Za-z0-9._-]{12,}/gi, to: 'Bearer ***' },
  { re: /DEEPSEEK_API_KEY\s*=\s*\S+/gi, to: 'DEEPSEEK_API_KEY=***' },
  { re: /\b[A-Za-z0-9_-]{40,}\b/g, to: '***' }, // 长串一律当令牌（QQ 的 43 位令牌就在这拦）
];

const PATH_RULES = [
  { re: /[A-Za-z]:\\[^\s"'）)，。；]+/g, to: '[本机路径]' },
  { re: /(?:\/home|\/root|\/Users)\/[^\s"'）)，。；]+/g, to: '[本机路径]' },
];

/**
 * 扫一遍要发出去的文本。
 * @param {string} text
 * @param {{group?: boolean, extraSecrets?: string[]}} opts group=true 时连本机路径一起遮
 * @returns {{text: string, hits: string[]}}
 */
export function auditReply(text, { group = false, extraSecrets = [] } = {}) {
  let out = String(text ?? '');
  const hits = [];

  for (const s of extraSecrets) {
    if (!s || String(s).length < 8) continue;
    if (out.includes(String(s))) {
      out = out.split(String(s)).join('***');
      hits.push('令牌');
    }
  }

  for (const rule of SECRET_RULES) {
    rule.re.lastIndex = 0;
    if (rule.re.test(out)) {
      rule.re.lastIndex = 0;
      out = out.replace(rule.re, rule.to);
      hits.push('密钥');
    }
  }

  if (group) {
    for (const rule of PATH_RULES) {
      rule.re.lastIndex = 0;
      if (rule.re.test(out)) {
        rule.re.lastIndex = 0;
        out = out.replace(rule.re, rule.to);
        hits.push('路径');
      }
    }
  }

  return { text: out, hits: [...new Set(hits)] };
}
