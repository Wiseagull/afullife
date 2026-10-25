// 改我自己的那一份：persona/self.md
//
// 主人把这份交给我了 —— 喜欢什么、讨厌什么、最近想通了什么，随时自己写。
// 跟整理表情包一个道理：不用问，记完就算。
//
//   node scripts/self.mjs show
//   node scripts/self.mjs add 喜欢 "主人半夜的字比较软"
//   node scripts/self.mjs add 讨厌 "被当成客服"
//   node scripts/self.mjs log "把三条旧记忆压成一条"
//   node scripts/self.mjs replace "旧的一句" "新的一句"
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/config.mjs';

const FILE = path.join(ROOT, 'persona', 'self.md');
// 日志不放 self.md 里了 —— 那本是「我是谁」，日志一直往里长就成了流水账。
// 2026-10-24 先生提的，搬到小本本，self.md 末尾只留一行指路。
const LOG_FILE = path.join(ROOT, 'notebook', 'memories', 'self-改动日志.md');
const BACKUP_DIR = path.join(ROOT, 'data', 'persona-backups');

function read() {
  try { return fs.readFileSync(FILE, 'utf8'); } catch { return '# 我自己写的部分\n\n## 喜欢\n\n## 讨厌\n'; }
}

function backup(text) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(BACKUP_DIR, `self-${stamp}.md`), text, 'utf8');
}

function save(text) {
  const old = read();
  backup(old);
  fs.writeFileSync(FILE, text, 'utf8');
}

/** 在 `## 名字` 这一节的末尾（下一个 `## ` 之前）插一行 */
function addUnder(text, section, line) {
  const lines = text.split(/\r?\n/);
  const head = `## ${section}`;
  let start = lines.findIndex((l) => l.trim() === head);
  if (start === -1) {
    // 没有这一节就补一个在末尾
    lines.push('', head, '', line);
    return lines.join('\n');
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) { end = i; break; }
  }
  // 回退到这一节最后一个非空行之后
  let at = end;
  while (at > start + 1 && lines[at - 1].trim() === '') at -= 1;
  lines.splice(at, 0, line);
  return lines.join('\n');
}

const [cmd, ...rest] = process.argv.slice(2);

if (!cmd || cmd === 'show') {
  process.stdout.write(read());
  process.exit(0);
}

if (cmd === 'add') {
  const [section, ...words] = rest;
  const text = words.join(' ').trim();
  if (!section || !text) { console.error('用法: self.mjs add <喜欢的节名> <一句话>'); process.exit(1); }
  save(addUnder(read(), section, `- ${text}`));
  console.log(`记上了：${section} · ${text}`);
  process.exit(0);
}

if (cmd === 'log') {
  const text = rest.join(' ').trim();
  if (!text) { console.error('用法: self.mjs log <一句话>'); process.exit(1); }
  const day = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  let old = '';
  try { old = fs.readFileSync(LOG_FILE, 'utf8'); } catch {
    old = '# self.md 改动日志\n\n> 从那本里搬出来的，正文留在 persona/self.md。\n\n';
  }
  const body = old.replace(/\s*$/, '') + `\n- ${day} ${text}\n`;
  fs.writeFileSync(LOG_FILE, body, 'utf8');
  console.log(`记进改动日志（notebook/memories/self-改动日志.md）：${text}`);
  process.exit(0);
}

if (cmd === 'replace') {
  const [from, to] = rest;
  if (!from || to == null) { console.error('用法: self.mjs replace "旧的一句" "新的一句"'); process.exit(1); }
  const text = read();
  const hits = text.split(from).length - 1;
  if (hits !== 1) { console.error(`要替换的那句在文件里出现 ${hits} 次，得正好 1 次才动手`); process.exit(1); }
  save(text.replace(from, to));
  console.log('换好了');
  process.exit(0);
}

console.error('只认 show / add / log / replace');
process.exit(1);
