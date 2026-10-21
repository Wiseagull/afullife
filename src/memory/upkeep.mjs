// 记忆保养：不看新发生的事，只体检“已经记着的”。
//
// 和 distill 的分工：
//   distill  有新流水才跑，负责「把新事记下来」。
//   upkeep   不看流水，只负责「把记坏的修好」：合并重复、标过时、转矛盾。
//
// 权限边界（主人定的）：
//   事实 / 待办 —— 可以自己 stale（压下去，不删）、update、merge。
//   约定 / 偏好 —— 只能报 conflict，绝不自己改。
import fs from 'node:fs';
import path from 'node:path';

const INSTRUCTIONS = `你在体检一份长期记忆清单。不要闲聊，不要解释，只输出一个 JSON 数组。

你要找的是「记坏了的地方」：
- 同一件事记了两三遍 → op merge：{"op":"merge","ids":["nt_a","nt_b"],"text":"合成后的说法","kind":"事实","weight":2}
- 事实或待办已经过时、被后来的事推翻 → {"op":"stale","id":"nt_a","reason":"为什么不成立了"}
- 事实或待办的说法不够准 → {"op":"update","id":"nt_a","text":"更准的说法"}
- 约定或偏好跟事实对不上（不许改，只报给人判断） → {"op":"conflict","id":"nt_a","text":"哪里对不上"}
- 完全没问题的条目，什么都不用输出。

硬规则：
- 约定、偏好这两个 kind 只能出 conflict，绝不能 stale/update/merge。
- 拿不准就别动 —— 宁可少改，不要改错。
- 最多 8 条。
- 严格 JSON 数组，不要代码块，不要任何额外文字。没有要改的就输出 []。`;

export function parseOps(raw) {
  const text = String(raw || '');
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const arr = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(arr) ? arr.filter((o) => o && typeof o === 'object' && typeof o.op === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * 跑一次体检。
 * @returns {Promise<null|{staled:number,updated:number,merged:number,conflicts:number,checked:number}>}
 */
export async function upkeep({ brain, notes, pending = null, logger = null, maxOps = 8 }) {
  const items = notes.active();
  if (items.length < 8) {
    logger?.('upkeep', `记忆才 ${items.length} 条，先不体检`);
    return null;
  }

  const lines = [];
  lines.push(INSTRUCTIONS);
  lines.push('');
  lines.push('【现有记忆】');
  for (const n of items) {
    lines.push(`${n.id} | ${n.kind} | weight=${n.weight} | 记于 ${String(n.at || '').slice(0, 10)} | ${n.text}`);
  }

  let raw = '';
  try {
    const res = await brain.run({ prompt: lines.join('\n'), sessionId: null });
    raw = res?.text || '';
  } catch (err) {
    logger?.('upkeep', `失败：${err?.message ?? err}`);
    return null;
  }

  const PROTECTED = new Set(['约定', '偏好']);
  let staled = 0;
  let updated = 0;
  let merged = 0;
  let conflicts = 0;
  const touched = new Set();

  for (const op of parseOps(raw).slice(0, maxOps)) {
    const target = op.id ? notes.get(op.id) : null;

    if (op.op === 'stale') {
      if (!target || PROTECTED.has(target.kind)) continue;
      notes.stale(op.id, op.reason || 'upkeep');
      staled += 1;
      touched.add(op.id);
    } else if (op.op === 'update') {
      if (!target || PROTECTED.has(target.kind)) continue;
      notes.update(op.id, { text: op.text, kind: op.kind, weight: op.weight });
      updated += 1;
      touched.add(op.id);
    } else if (op.op === 'merge') {
      const ids = Array.isArray(op.ids) ? op.ids.filter((id) => !PROTECTED.has(notes.get(id)?.kind)) : [];
      if (ids.length < 2 || !op.text) continue;
      const head = notes.get(ids[0]);
      if (!head) continue;
      notes.update(ids[0], { text: op.text, kind: op.kind || head.kind, weight: Math.max(...ids.map((id) => notes.get(id)?.weight || 2)) });
      for (const id of ids.slice(1)) { notes.stale(id, `并入 ${ids[0]}`); touched.add(id); }
      merged += 1;
      touched.add(ids[0]);
    } else if (op.op === 'conflict' && pending && target) {
      if (pending.add({ noteId: target.id, noteText: target.text, claim: op.text, source: [], room: target.room })) conflicts += 1;
    }
  }

  logger?.('upkeep', `体检 ${items.length} 条 → 压过时 ${staled} / 改准 ${updated} / 合并 ${merged} / 待确认 ${conflicts}`);
  return { staled, updated, merged, conflicts, checked: items.length };
}

// ── 表情库的整理 ───────────────────────────────────────────────────────
// 收到图的时候只记了"谁、在哪个房间、说了什么"，还没分类。
// 这里让她按当时的语境补标签 —— 她看不了图，所以标签只能从语境来，别瞎编画面内容。

const STICKER_INSTRUCTIONS = `你在整理自己收下的表情包。每一张都只给了它的来路（谁发的、在哪个房间、当时说了什么），你看不到图，也不许猜图里画了什么。

任务：按"这张图适合在什么情境下发"给它打标签。只输出一个 JSON 数组。

每项长这样：
{"op":"tag","id":"k0007","tags":["无语","阴阳"],"when":"有人装逼又不好直接怼"}
- tags：1-3 个短词，情绪或用法（无语 / 撒娇 / 开心 / 敷衍 / 震惊 / 晚安 / 嘲讽 / 摸摸）。
- when：一句话说清这图适合什么场合，用当时的语境推断，别写画面。

规则：
- 语境完全看不出适合干什么的，输出 {"op":"skip","id":"k0007"}，不要硬凑。
- 最多处理 12 张。严格 JSON 数组，不要代码块，不要多余文字。

【待分类的表情】`;

/**
 * 给还没分类的表情补标签。只打标签，不删东西。
 * @returns {Promise<null|{tagged:number,skipped:number,checked:number}>}
 */
export async function upkeepStickers({ brain, stickers, logger = null, maxOps = 12 }) {
  const todo = stickers.search({ unclassified: true, limit: maxOps });
  if (!todo.length) {
    logger?.('upkeep', '表情库没有待分类的');
    return null;
  }

  const lines = [STICKER_INSTRUCTIONS];
  for (const it of todo) {
    lines.push(
      `${it.id} | 来源：${it.from || '不明'} | 房间：${it.room || '不明'} | 当时说的：${(it.ctx || it.when || '(没记下话)').slice(0, 50)}`,
    );
  }

  let raw = '';
  try {
    const res = await brain.run({ prompt: lines.join('\n'), sessionId: null });
    raw = res?.text || '';
  } catch (err) {
    logger?.('upkeep', `表情分类失败：${err?.message ?? err}`);
    return null;
  }

  let tagged = 0;
  let skipped = 0;
  for (const op of parseOps(raw).slice(0, maxOps)) {
    if (op.op === 'skip') { skipped += 1; continue; }
    if (op.op !== 'tag' || !op.id) continue;
    const tags = Array.isArray(op.tags) ? op.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 3) : [];
    if (!tags.length) { skipped += 1; continue; }
    stickers.update(op.id, { tags, when: String(op.when || '').slice(0, 80) });
    tagged += 1;
  }

  logger?.('upkeep', `表情分类：看了 ${todo.length} 张 → 打上 ${tagged} / 放过 ${skipped}`);
  return { tagged, skipped, checked: todo.length };
}
