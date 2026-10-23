// 房间：把 OneBot 的原始事件折成内部消息，并按房间取上下文。
// 「房间」= 一个私聊或一个群。换的是屋子，不是人。

export function roomKeyOf({ kind, id }) {
  return kind === 'group' ? `group:${id}` : `private:${id}`;
}

export function segmentsToText(segments) {
  if (!Array.isArray(segments)) return '';
  const parts = [];
  for (const seg of segments) {
    const type = seg?.type;
    const data = seg?.data || {};
    if (type === 'text') parts.push(String(data.text ?? ''));
    else if (type === 'at') parts.push(data.qq === 'all' ? '@全体' : `@${data.name || data.qq}`);
    else if (type === 'image') parts.push('[图片]');
    else if (type === 'face') parts.push('[表情]');
    else if (type === 'mface') parts.push('[表情]');
    else if (type === 'record') parts.push('[语音]');
    else if (type === 'video') parts.push('[视频]');
    else if (type === 'file') parts.push(`[文件 ${data.name || ''}]`.trim());
    else if (type === 'reply') parts.push('[引用]');
    else if (type === 'json') parts.push('[卡片]');
    else if (type === 'forward') parts.push('[合并转发]');
  }
  return parts.join('');
}

/**
 * 把 OneBot 事件折成内部消息；非消息事件返回 null。
 * @returns {null | {room:string, kind:'private'|'group', id:string, msgId:number|null,
 *   from:string, name:string, text:string, at:number, atMe:boolean}}
 */
export function normalizeEvent(raw, { selfId = '', selfNames = [] } = {}) {
  if (!raw || raw.post_type !== 'message') return null;

  const kind = raw.message_type === 'group' ? 'group' : raw.message_type === 'private' ? 'private' : '';
  if (!kind) return null;

  const id = String(kind === 'group' ? raw.group_id ?? '' : raw.user_id ?? '');
  if (!id) return null;

  const from = String(raw.user_id ?? raw.sender?.user_id ?? '');
  if (selfId && from === String(selfId)) return null; // 自己说的话不回流

  const name = String(raw.sender?.card || raw.sender?.nickname || from);
  const segments = Array.isArray(raw.message) ? raw.message : null;
  const text = segments ? segmentsToText(segments) : String(raw.raw_message ?? raw.message ?? '').trim();

  const atSegs = segments ? segments.filter((s) => s?.type === 'at') : [];
  const atMe = atSegs.some((s) => String(s?.data?.qq) === String(selfId) && selfId);
  const images = segments
    ? segments.filter((s) => s?.type === 'image')
      .map((s) => String(s?.data?.url || s?.data?.file || ''))
      .filter(Boolean)
    : [];
  const names = [selfNames].flat().filter(Boolean);
  const calledByName = names.some((n) => text.includes(n));
  const replySeg = segments ? segments.find((s) => s?.type === 'reply') : null;
  const hasForward = segments ? segments.some((s) => s?.type === 'forward') : false;

  return {
    room: roomKeyOf({ kind, id }),
    kind,
    id,
    msgId: raw.message_id ?? null,
    from,
    name,
    text,
    images,
    at: Number(raw.time || Math.floor(Date.now() / 1000)),
    atMe: atMe || calledByName,
    // 引用：只留被引用那条的 id，正文由调用方去历史里捞
    replyId: replySeg ? String(replySeg?.data?.id ?? '') : '',
    hasForward,
    forwardId: hasForward ? String(segments.find((s) => s?.type === 'forward')?.data?.id ?? '') : '',
  };
}

/** 把一串事件渲染成给脑子看的对话记录（纯文本）。 */
export function renderTranscript(events) {
  return events.map((e) => {
    const who = e.name || e.from || '?';
    // 编号：她想引着某句回时，用 [[reply:编号]] 指过去
    const num = e.idx ? `#${e.idx} ` : '';
    // 引用：他在回哪一句，得摆在她眼前，不然她只能猜“这句是冲谁来的”
    const quote = e.quoteText
      ? `[引用 ${e.quoteName || '某人'}：${shortenQuote(e.quoteText)}] `
      : '';
    const files = Array.isArray(e.imageFiles) ? e.imageFiles.filter(Boolean) : [];
    let text = String(e.text ?? '');
    // 她自己说过的长段落，回看时只留开头：
    // 一是省 token，二是别让她照着“上一次的长回复”继续往下说（人设就是这么漂走的）
    if (e.dir === 'out' && text.length > 80) text = `${text.slice(0, 80)}……（后面还说了一些）`;
    if (quote) text = text.replace(/\[引用\]/g, '');
    if (!files.length) return `${num}${who}: ${quote}${text.trim()}`;
    // 正文里原本只有一个 [图片] 占位，换成真实路径——她当场就能 read_image
    text = text.replace(/(\[图片\])+/g, '').trim();
    const list = files.map((f, i) => `图片${i + 1}：${f}`).join('；');
    return `${num}${who}: ${quote}${text}${text ? ' ' : ''}（${list}）`;
  }).join('\n');
}

/** 引用那一行：太长就截断，但带图片路径的不能截——截了路径就废了。 */
export function shortenQuote(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ');
  return t.includes('（附图：') ? t : t.slice(0, 60);
}

/**
 * 引用正文 + 落盘路径：有图就把「（附图：…）」接在后面，正文里的 [图片] 占位去掉。
 * 没图就原样返回（一个字都不动）。
 */
export function withFiles(text, files = []) {
  const raw = String(text ?? '');
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  if (!list.length) return raw;
  const bare = raw.replace(/(\[图片\])+/g, '').trim();
  return `${bare}${bare ? ' ' : ''}（附图：${list.join('；')}）`;
}

/** 引用的是哪句：拿 replyId 去最近的事件里捞原文。捞不到就返回 null。 */
export function resolveQuote(msg, recent = []) {
  const id = String(msg?.replyId || '');
  if (!id) return null;
  const hit = recent.find((e) => String(e.msgId ?? '') === id);
  if (!hit) return null;
  // 被引用的是张图：光写「[图片]」她等于没看见（19:11 他就问过「你知道我说的是哪一张吗」）。
  // 那条我们落过盘，把路径一起带上，她当场就能 read_image。
  const files = Array.isArray(hit.imageFiles) ? hit.imageFiles.filter(Boolean) : [];
  return { text: withFiles(hit.text, files), name: hit.name || hit.from || '某人', files };
}
