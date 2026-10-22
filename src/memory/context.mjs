// 装配给脑子看的“背景”。
//
// 原则（2026-10-20 改）：背景里放的是**记忆**，不是日志。
//   · 原始事件流不进提示词 —— 摆一屏流水账，它会当成“外部资料”，
//     转头去翻 data/events 求证，回话就变成“我刚去翻了一下”。
//   · 这里只说“它已经知道的事”，用第一人称残片，不像系统推送。
//   · 蒸馏出来的记忆条目（notes）才带出处，因为它们本来就是定论。
//
// 跨房间可见性仍在这里收口：用 cfg.memory.rooms 的两个开关。

/** 房间的短标签，用来标“这话是从哪儿来的” */
export function roomTag(room, nameOf = null) {
  if (!room) return '';
  const name = nameOf?.(room);
  if (name) { const t = String(name); return t.length > 10 ? t.slice(0, 10) : t; }
  const id = String(room).split(':')[1] || '';
  const tail = id.length > 4 ? id.slice(-4) : id;
  return room.startsWith('private:') ? `私聊${tail}` : `群${tail}`;
}

/** 这个房间看不看得见那个房间的东西 */
export function canSee(cfg, viewer, source) {
  if (!source || source === viewer) return true;
  const view = roomView(cfg, viewer);
  if (!view.read) return false;
  return roomView(cfg, source).share;
}

/** 房间的两个开关（配置里没写就用默认） */
export function roomView(cfg, room) {
  const conf = (cfg && cfg.memory && cfg.memory.rooms && cfg.memory.rooms[room]) || {};
  const isPrivate = String(room || '').startsWith('private:');
  const read = conf.read !== undefined ? !!conf.read : true;
  const share = conf.share !== undefined ? !!conf.share : isPrivate;
  return { read, share };
}

/** 一条事件值不值得记进“隐约记得”：图/表情只提一句，空的丢掉 */
function worthwhile(e) {
  if (!e) return false;
  const text = String(e.text || '').trim();
  const hasImage = Array.isArray(e.images) && e.images.length > 0;
  if (!text && !hasImage) return false;
  if (text.length < 2 && !hasImage) return false;
  return true;
}

/** 把一条事件写成像“自己想起来的”那种口气 */
function memoryLine(e, viewer, nameOf) {
  const where = e.room === viewer ? '这儿' : roomTag(e.room, nameOf);
  const who = e.dir === 'out' ? '我' : (e.name || e.from || '有人');
  const text = String(e.text || '').replace(/\s+/g, ' ').trim();
  const hasImage = Array.isArray(e.images) && e.images.length > 0;

  if (!text && hasImage) return `${where}，${who}发了张图。`;
  const said = text.length > 60 ? `${text.slice(0, 60)}…` : text;
  const tail = hasImage ? '（还发了张图）' : '';
  if (e.dir === 'out') return `${where}，我回了句：${said}${tail}`;
  return `${where}，${who}说：${said}${tail}`;
}

/**
 * 开场用：我隐约记得的事 + 我记住的事。
 *
 * 只给「记忆」，不给日志：别处的零碎事件最多留几条，且都是成句的；
 * 这个房间刚才聊了什么由调用方自己摆在对话里，不在这里重复。
 */
export function buildBackground({
  events = [],
  notes = [],
  roomKey = null,
  cfg = null,
  nameOf = null,
  limitEvents = 6,
  limitSelf = 3,
  limitNotes = 12,
} = {}) {
  const blocks = [];

  // ① 别处发生、值得记一笔的（当前房间的不算，那是“刚刚在聊的”）
  const elsewhere = events
    .filter((e) => e.room && e.room !== roomKey)
    .filter((e) => !roomKey || canSee(cfg, roomKey, e.room))
    .filter(worthwhile)
    .slice(-limitEvents);

  if (elsewhere.length) {
    blocks.push('（你隐约记得这些，不用去翻记录确认）');
    for (const e of elsewhere) blocks.push(`- ${memoryLine(e, roomKey, nameOf)}`);
  }

  // ①b 我自己主动说出去的话（自由活动那几句，见 selfLines）
  const mineBlock = selfLines(events, roomKey, limitSelf);
  if (mineBlock) {
    if (blocks.length) blocks.push('');
    blocks.push(mineBlock);
  }

  // ② 已经沉淀下来的记忆——这些才是定论，带出处
  const keep = notes
    .filter((n) => !n.staleAt)
    .filter((n) => !n.room || !roomKey || canSee(cfg, roomKey, n.room));
  if (keep.length) {
    const sorted = [...keep].sort((a, b) => {
      const ra = (a.room === roomKey ? 1 : 0) + (a.weight || 0);
      const rb = (b.room === roomKey ? 1 : 0) + (b.weight || 0);
      return rb - ra;
    });
    if (blocks.length) blocks.push('');
    blocks.push('（你记得的事）');
    for (const n of sorted.slice(0, limitNotes)) {
      const from = n.room && n.room !== roomKey ? `，来自${roomTag(n.room, nameOf)}` : '';
      blocks.push(`- 「${n.kind}」${n.text}${from}`);
    }
  }

  return blocks.join('\n');
}

/**
 * 她自己主动说出去、但没经过房间会话的那几句（自由活动的发言）。
 *
 * 只认 `free: true` 标记 —— 普通聊天的回复也是 dir:'out'，
 * 那些会话自己记着，再列一遍就是重复。
 */
export function selfLines(events = [], roomKey = null, limit = 3) {
  const mine = events
    .filter((e) => e.room === roomKey && e.dir === 'out' && e.free === true)
    .filter(worthwhile)
    .slice(-limit);
  if (!mine.length) return '';
  return [
    '（你自己主动说过的话，别当成没说）',
    ...mine.map((e) => {
      const said = String(e.text || '').replace(/\s+/g, ' ').trim();
      return `- 你发过：${said.length > 60 ? `${said.slice(0, 60)}…` : said}`;
    }),
  ].join('\n');
}

/**
 * 接着聊时用：别的房间刚发生、且真的值得提一嘴的。
 * 同一房间的上下文由会话自己记着，不重复。
 */
export function buildDelta({ events = [], excludeRoom = null, cfg = null, nameOf = null, sinceTs = 0, limit = 6, limitSelf = 3 } = {}) {
  const evs = events
    .filter((e) => e.room !== excludeRoom && (e.ts || 0) > sinceTs)
    .filter((e) => !e.room || !excludeRoom || canSee(cfg, excludeRoom, e.room))
    .filter(worthwhile)
    .slice(-limit);
  const parts = [];
  if (evs.length) {
    parts.push([
      '（这会儿你隐约想起来）',
      ...evs.map((e) => `- ${memoryLine(e, excludeRoom, nameOf)}`),
    ].join('\n'));
  }
  // 热会话也要补：自由活动那几句不走会话，会话里永远没有
  const mine = selfLines(events, excludeRoom, limitSelf);
  if (mine) parts.push(mine);
  return parts.join('\n');
}
