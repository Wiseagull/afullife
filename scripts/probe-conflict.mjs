// 测试"对不上"这条链路：攒一条待确认，看它会不会被问到、被记下解释。
// node scripts/probe-conflict.mjs
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { PendingStore } from '../src/memory/pending.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-'));
const file = path.join(dir, 'pending.json');
const p = new PendingStore({ file });

const a = p.add({ noteId: 'nt_x', noteText: '主人已经关掉 QQagent', claim: 'QQagent 还开着', room: 'private:1', source: ['ev_1'] });
console.log('add:', a?.status === 'open' ? '✓' : '✗');
console.log('open:', p.open('private:1').length === 1 ? '✓' : '✗');
p.markAsked(a.id);
console.log('asked:', p.open('private:1').length === 0 && p.all()[0].status === 'asked' ? '✓' : '✗');

const ans = p.markAnswered({ room: 'private:1', text: '我是关了它的自动回复，程序还开着' });
console.log('answered:', ans?.answer ? '✓' : '✗', '→', ans?.answer);
console.log('answered list:', p.answered().length === 1 ? '✓' : '✗');
p.close(a.id);
console.log('closed:', p.answered().length === 0 ? '✓' : '✗');

// 重新加载，确认落盘了
const p2 = new PendingStore({ file });
console.log('persist:', p2.all()[0]?.status === 'closed' ? '✓' : '✗', `文件 ${JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8'))[0]).slice(0, 60)}…`);
