// 合并转发（聊天记录）的展开。
//
// 消息里只会来一个 `[合并转发]` 的空壳，真正的内容要靠
// `get_forward_msg` 按**外层消息的 message_id** 去取（实测：转发卡片里那个
// res_id 会过期，拿它去取只会得到 payload is empty）。

const MAX_NODES = 30;
const MAX_CHARS = 3000;

function stripCQ(s) {
  return String(s ?? '').replace(/\[CQ:[^\]]*\]/g, '').trim();
}

/** 节点里的内容段 → 一行文本（图片这类只留占位，别让转发撑爆上下文） */
function bodyOf(node) {
  const nm = node?.message ?? node?.content;
  if (typeof nm === 'string') return stripCQ(nm);
  if (!Array.isArray(nm)) return '';
  const parts = [];
  for (const seg of nm) {
    const type = seg?.type;
    const d = seg?.data || {};
    if (type === 'text') parts.push(String(d.text ?? ''));
    else if (type === 'at') parts.push(d.qq === 'all' ? '@全体' : `@${d.name || d.qq}`);
    else if (type === 'image') parts.push('[图片]');
    else if (type === 'face' || type === 'mface') parts.push('[表情]');
    else if (type === 'record') parts.push('[语音]');
    else if (type === 'video') parts.push('[视频]');
    else if (type === 'file') parts.push(`[文件 ${d.name || ''}]`.trim());
    else if (type === 'json') parts.push('[卡片]');
    else if (type === 'forward') parts.push('[转发消息]'); // 套娃不再展开，深度一层封顶
  }
  return parts.join('').replace(/\s+/g, ' ').trim();
}

/**
 * 把 get_forward_msg 返回的节点数组渲染成一段可读文本。
 * @param {Array} nodes
 * @returns {{text:string, count:number, shown:number} | null}
 */
export function renderForwardNodes(nodes, { maxNodes = MAX_NODES, maxChars = MAX_CHARS } = {}) {
  if (!Array.isArray(nodes) || !nodes.length) return null;

  const lines = [];
  let shown = 0;
  for (const n of nodes) {
    if (lines.length >= maxNodes) break;
    const nick = String(n?.sender?.card || n?.sender?.nickname || n?.nickname || n?.user_id || '?');
    const body = bodyOf(n);
    if (!body) continue;
    lines.push(`${nick}: ${body}`.slice(0, 300));
    shown += 1;
    if (lines.join('\n').length > maxChars) break;
  }

  if (!shown) return { text: `[合并转发 共${nodes.length}条，里面没有可读的文字]`, count: nodes.length, shown: 0 };

  const rest = nodes.length - shown;
  const tail = rest > 0 ? `\n…（还有 ${rest} 条没展开）` : '';
  return {
    text: `[合并转发的聊天记录 共${nodes.length}条]\n${lines.join('\n')}${tail}`,
    count: nodes.length,
    shown,
  };
}

/** 各种 OneBot 实现的返回形状不太一样，挨个认一遍 */
export function pickNodes(res) {
  if (!res) return [];
  if (Array.isArray(res)) return res;
  if (Array.isArray(res.messages)) return res.messages;
  if (Array.isArray(res.data)) return res.data;
  if (Array.isArray(res.data?.messages)) return res.data.messages;
  if (Array.isArray(res.message)) return res.message;
  return [];
}
