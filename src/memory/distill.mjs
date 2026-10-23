// 整理：把流水里的事，压成几条记得住的东西。
// 跑在独立会话里（工作目录是项目根，不加载人格），不和聊天抢上下文。
//
// 一条规矩：**发现跟我记的不一样，不许自己改**。攒成一条待确认，回头问他一句。
import fs from 'node:fs';
import path from 'node:path';

const INSTRUCTIONS = `你在整理一份长期记忆。不要闲聊，不要解释，只输出一个 JSON 数组。

规则：
- **唯一权威是事件流**（下面【新发生的事】里的原文）。你写下的每条都只是它的索引和缓存，会旧、会错；对不上时以原文为准，别拿记性去盖原文。
- 只记长期有用的：约定、偏好、事实、待办。寒暄、一次性的情绪、某句话的具体措辞，都不记。
- 同一件事不要重复记；说法更准确了，用 update。
- 事实和待办过时了，你可以自己改、自己删（op 用 update / drop）。
- **约定和偏好是他亲口说的，跟新发生的事矛盾时不要改、不要删**，输出 {"op":"conflict","id":"<记忆id>","text":"这次听到的说法","source":["…"]}，让人去判断。
- 只有在【他的解释】里明确说过的，才可以 update 或 drop 对应那条。
- 每条必须给 source，填它来自哪几条事件的 id（就是每行开头那个 ev_xxxxxxxx 号，原样抄）。**没有号就别记** —— 记了也核对不了。
- 最多 6 条。没有值得记的东西，就输出 []。
- text 用一句话、第三人称、具体。"他希望被叫某个称呼" 好；"有称呼偏好" 差。

输出格式（严格 JSON，不要代码块，不要任何额外文字）：
[{"op":"add","kind":"约定","text":"…","source":["…"],"weight":3}]
可用的 op：add / update（需 id）/ drop（需 id）/ conflict（需 id）。kind 只能是：约定、偏好、事实、待办。weight 1-3。`;

export function readCursor(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch {
    return {};
  }
}

export function writeCursor(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function parseOps(raw) {
  const text = String(raw || '');
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let arr;
  try {
    arr = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr.filter((o) => o && typeof o === 'object' && typeof o.op === 'string');
}

/**
 * 跑一次整理。
 * @returns {Promise<null|{added,updated,dropped,conflicts,scanned}>}
 */
export async function distill({
  brain,
  notes,
  events,
  cursorFile,
  pending = null,
  logger = null,
  minEvents = 4,
  maxOps = 6,
}) {
  const cursor = readCursor(cursorFile);
  const since = Number(cursor.ts) || (Date.now() - 6 * 3600 * 1000);
  const scanned = events.readSince(since).slice(-160);
  if (scanned.length < minEvents) {
    logger?.('distill', `流水只有 ${scanned.length} 条，先不整理`);
    return null;
  }

  const existing = notes.all().slice(-60).map((n) => `${n.id} | ${n.kind} | ${n.text}`);
  const explained = pending ? pending.answered() : [];

  const lines = [];
  lines.push(INSTRUCTIONS);
  lines.push('');
  lines.push('【现有记忆】');
  lines.push(existing.length ? existing.join('\n') : '（空）');
  if (explained.length) {
    lines.push('');
    lines.push('【他的解释】（这些对不上的事他已经说清楚了，可以据此 update 或 drop）');
    for (const p of explained) lines.push(`${p.noteId} | 原来记着：${p.noteText} | 他说：${p.answer}`);
  }
  lines.push('');
  lines.push('【新发生的事】');
  for (const e of scanned) {
    const who = e.dir === 'out' ? '我' : (e.name || e.from || '某人');
    lines.push(`${e.eid || e.msgId || e.id || '-'} | ${e.room || '-'} | ${who} | ${String(e.text || '').replace(/\n/g, ' ').slice(0, 160)}`);
  }

  let raw = '';
  try {
    const res = await brain.run({ prompt: lines.join('\n'), sessionId: null });
    raw = res?.text || '';
  } catch (err) {
    logger?.('distill', `失败：${err?.message ?? err}`);
    return null;
  }

  const ops = parseOps(raw).slice(0, maxOps);
  let added = 0;
  let updated = 0;
  let dropped = 0;
  let conflicts = 0;
  const touched = new Set();

  for (const op of ops) {
    if (op.op === 'add') {
      if (notes.add({
        kind: op.kind,
        text: op.text,
        room: op.room || null,
        source: op.source,
        weight: op.weight,
      })) added += 1;
    } else if (op.op === 'update') {
      if (notes.update(op.id, { text: op.text, kind: op.kind, weight: op.weight, source: op.source })) {
        updated += 1;
        touched.add(op.id);
      }
    } else if (op.op === 'drop') {
      if (notes.drop(op.id)) {
        dropped += 1;
        touched.add(op.id);
      }
    } else if (op.op === 'conflict' && pending) {
      const note = notes.get(op.id);
      if (note && pending.add({ noteId: note.id, noteText: note.text, claim: op.text, source: op.source, room: note.room })) {
        conflicts += 1;
      }
    }
  }

  // 他解释过的那些，既然已经照他的说法改了，就不用再问
  if (pending) {
    for (const p of explained) if (touched.has(p.noteId)) pending.close(p.id);
  }

  const last = scanned[scanned.length - 1];
  writeCursor(cursorFile, { ts: last?.ts || Date.now(), lastId: last?.eid || null, at: new Date().toISOString() });

  logger?.('distill', `扫了 ${scanned.length} 条 → 新增 ${added} / 更新 ${updated} / 删 ${dropped} / 待确认 ${conflicts}`);
  return { added, updated, dropped, conflicts, scanned: scanned.length };
}
