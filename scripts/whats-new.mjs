// 从 DSH 这边看一眼：QQ 那几间屋子刚才发生了什么，我又记着什么。
// node scripts/whats-new.mjs [条数]
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { EventLog } from '../src/memory/events.mjs';
import { NotesStore } from '../src/memory/notes.mjs';

const n = Number(process.argv[2]) || 25;
const cfg = loadConfig({ cli: {} });
const events = new EventLog({ dir: path.join(cfg.dataDir, 'events') });
const notes = new NotesStore({ file: path.join(cfg.dataDir, 'memory', 'notes.jsonl') });

const hhmm = (ts) => new Date(ts).toTimeString().slice(0, 5);
const label = (room) => (!room ? '?' : room.startsWith('private:') ? '私聊' : room.startsWith('group:') ? '群' : room);

console.log(`── 最近 ${n} 条 ──`);
for (const e of events.readRecent({ limit: n })) {
  const who = e.dir === 'out' ? '我' : (e.name || e.from || '某人');
  console.log(`${hhmm(e.ts)} [${label(e.room)}] ${who}：${String(e.text || '').replace(/\n/g, ' ')}`);
}

console.log('');
console.log(`── 我记得的（${notes.all().length} 条）──`);
for (const x of notes.all()) {
  console.log(`(${x.kind}/${x.weight}) ${x.text}`);
}
