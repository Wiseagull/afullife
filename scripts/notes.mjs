#!/usr/bin/env node
// 记忆条目的手动入口 —— 也是“我自己整理记忆”的开关。
//
// 用法（在哪儿跑都行，路径已写死）：
//   node scripts/notes.mjs list            # 看现在记着什么（不含过时的）
//   node scripts/notes.mjs list --all      # 连过时的一起看
//   node scripts/notes.mjs search 鲸鱼      # 按词找
//   node scripts/notes.mjs add 事实 文本…   # 新记一条（kind: 约定/偏好/事实/待办）
//   node scripts/notes.mjs set nt_abc123 --text=新的说法 --weight=3
//   node scripts/notes.mjs stale nt_abc123 原因   # 标成过时（不删，还能捞回来）
//   node scripts/notes.mjs restore nt_abc123
//   node scripts/notes.mjs drop nt_abc123   # 真删（会先进 archive 留底）
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NotesStore } from '../src/memory/notes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const notes = new NotesStore({ file: path.join(ROOT, 'data', 'memory', 'notes.jsonl') });

const [, , cmd, ...rest] = process.argv;
const flags = Object.fromEntries(
  rest.filter((a) => a.startsWith('--')).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.length ? v.join('=') : true];
  }),
);
const argv = rest.filter((a) => !a.startsWith('--'));

function fmt(n) {
  const mark = n.staleAt ? '〔过时〕' : '';
  const room = n.room ? ` (${n.room})` : '';
  return `${n.id}  ${mark}[${n.kind}·${n.weight}] ${n.text}${room}`;
}

function done(msg) {
  console.log(msg);
  process.exit(0);
}

switch (cmd) {
  case 'list': {
    const items = flags.all ? notes.all() : notes.active();
    const room = typeof flags.room === 'string' ? flags.room : null;
    const kind = typeof flags.kind === 'string' ? flags.kind : null;
    const shown = items.filter((n) => (!room || n.room === room) && (!kind || n.kind === kind));
    console.log(`共 ${shown.length} 条${flags.all ? '' : '（过时的不显示）'}`);
    for (const n of shown) console.log(fmt(n));
    break;
  }
  case 'search': {
    const q = String(argv.join(' ') || '').toLowerCase();
    if (!q) done('要找什么？');
    const hit = notes.active().filter((n) => n.text.toLowerCase().includes(q) || n.kind.includes(q));
    console.log(`找到 ${hit.length} 条`);
    for (const n of hit) console.log(fmt(n));
    break;
  }
  case 'add': {
    const [kind, ...words] = argv;
    const text = words.join(' ').trim();
    if (!text) done('用法：add <约定|偏好|事实|待办> <文本>');
    const note = notes.add({ kind, text, weight: Number(flags.weight) || 2, room: flags.room || null, source: ['cli'] });
    done(note ? `记下了：${fmt(note)}` : '这条已经有了，没重复记');
    break;
  }
  case 'set': {
    const id = argv[0];
    if (!id) done('用法：set <id> --text=… --kind=… --weight=…');
    const patch = {};
    if (typeof flags.text === 'string') patch.text = flags.text;
    if (typeof flags.kind === 'string') patch.kind = flags.kind;
    if (flags.weight) patch.weight = Number(flags.weight);
    if (!Object.keys(patch).length) done('没给要改什么（--text / --kind / --weight）');
    const note = notes.update(id, patch);
    done(note ? `改好了：${fmt(note)}` : `没有 ${id} 这条`);
    break;
  }
  case 'stale': {
    const [id, ...why] = argv;
    if (!id) done('用法：stale <id> [原因]');
    const note = notes.stale(id, why.join(' '));
    done(note ? `标成过时了：${fmt(note)}` : `没有 ${id} 这条`);
    break;
  }
  case 'restore': {
    const note = notes.restore(argv[0]);
    done(note ? `捞回来了：${fmt(note)}` : `没有 ${argv[0]} 这条`);
    break;
  }
  case 'drop': {
    done(notes.drop(argv[0]) ? `删了 ${argv[0]}（归档留着）` : `没有 ${argv[0]} 这条`);
    break;
  }
  default:
    console.log(`用法：
  list [--all] [--room=…] [--kind=…]
  search <词>
  add <kind> <文本> [--weight=3] [--room=…]
  set <id> [--text=…] [--kind=…] [--weight=…]
  stale <id> [原因]      # 标成过时，不删
  restore <id>
  drop <id>              # 真删，先进 archive`);
}
