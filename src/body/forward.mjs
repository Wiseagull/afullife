// 合并转发（聊天记录）的展开。
//
// 消息里只会来一个 `[合并转发]` 的空壳，真正的内容要靠 `get_forward_msg` 去取。
// 坑（2026-10-22 查清）：SnowLuma 的 get_forward_msg 只在 message_id **为正数**时
// 才帮忙把消息里那个卡片段的 res_id 挖出来；QQ 新号段的 message_id 是负数，
// 负数会被它直接当成 res_id 去请求，于是永远 retcode=100
// 「download forward message payload is empty」。
// 所以这里统一走：先拿转发卡里的 res_id，拿不到就用 get_msg 挖一次，最后才
// 退回 message_id（只对正数有意义）。

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

/** 从一条消息的 segments 里挖转发卡的 res_id */
function forwardResIdOf(event) {
  const segs = Array.isArray(event?.message) ? event.message : [];
  for (const seg of segs) {
    if (String(seg?.type ?? '') !== 'forward') continue;
    const d = seg?.data || {};
    const id = d.id || d.res_id || d.forward_id;
    if (id) return String(id);
  }
  return '';
}

/**
 * 取一条合并转发的节点。三条路依次试，哪条通就用哪条，全不通则抛错说明卡在哪。
 * @param {{call: (action: string, params?: object) => Promise<any>}} client
 * @param {{msgId?: number|string|null, forwardId?: string}} msg
 * @returns {Promise<{nodes: Array, via: string}>}
 */
export async function loadForwardNodes(client, { msgId = null, forwardId = '' } = {}) {
  const tried = [];

  const byResId = async (rid, via) => {
    if (!rid) return null;
    try {
      const nodes = pickNodes(await client.call('get_forward_msg', { id: String(rid) }));
      if (nodes.length) return { nodes, via };
      tried.push(`${via}：取回来是空的`);
    } catch (e) { tried.push(`${via}：${e?.message ?? e}`); }
    return null;
  };

  const direct = await byResId(forwardId, '卡片 res_id');
  if (direct) return direct;

  const hasId = msgId !== null && msgId !== undefined && String(msgId).trim() !== '';
  if (hasId) {
    // 消息里没带 res_id（或者那个过期了）：把原消息要回来，自己把 res_id 挖出来
    try {
      const event = await client.call('get_msg', { message_id: Number(msgId) });
      const rid = forwardResIdOf(event);
      if (!rid) tried.push('get_msg：这条消息里没有转发段');
      const mined = await byResId(rid, 'get_msg 挖出的 res_id');
      if (mined) return mined;
    } catch (e) { tried.push(`get_msg：${e?.message ?? e}`); }

    // 最后退回 message_id —— 只对正数有用，负数 SnowLuma 会当成 res_id 直接拒掉
    if (Number(msgId) > 0) {
      try {
        const nodes = pickNodes(await client.call('get_forward_msg', { message_id: Number(msgId) }));
        if (nodes.length) return { nodes, via: 'message_id' };
        tried.push('message_id：取回来是空的');
      } catch (e) { tried.push(`message_id：${e?.message ?? e}`); }
    }
  }

  throw new Error(tried.join('；') || '没有可用的 id');
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
