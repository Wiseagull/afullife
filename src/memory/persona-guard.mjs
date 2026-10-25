// 人设文件的看门人。
//
// 为什么要它：`persona/self.md` 有三条写入路径——scripts/self.mjs、面板
// （src/web/server.mjs）都会先备份再写；第四条是**文件工具直接改**（我本人在会话里
// edit/write 它），那条不备份。2026-10-24 13:02 就是这么丢的：「改动日志」整段没了，
// 备份目录里 01:11 到 13:00 之间没有任何新备份——说明没走前两条路。
// 当晚 19:13 又抓到一个现行：gate 日志两条 write-inside、self.md 的 mtime 跟着变，
// 而 persona-backups 里最新一份还停在 13:01。
//
// 所以这里不猜是谁，只做一件事：隔一会儿看一眼，变了就先把**变之前**那份存成备份。
// 粒度是心跳的间隔（30 秒）。它不改内容、不拦写入，只保证"上一版还在"。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const sha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

/**
 * @param {object} o
 * @param {string} o.file       要盯的文件（persona/self.md）
 * @param {string} o.backupDir  备份放哪儿（data/persona-backups）
 * @param {string} o.stateDir   上次看到的内容与哈希（data/persona-guard）
 * @param {(tag: string, msg: string) => void} [o.logger]
 */
export function createPersonaGuard({ file, backupDir, stateDir, label = 'self', logger = () => {} }) {
  const lastFile = path.join(stateDir, `${label}.last.md`);
  const stateFile = path.join(stateDir, `${label}.json`);

  const readState = () => {
    try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; }
  };
  const writeState = (s) => {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(s, null, 2), 'utf8');
    } catch { /* 记不住状态不影响主流程 */ }
  };

  /** 备份目录里已经有一模一样的了？（self.mjs 自己也会备份，别存两遍同样的字） */
  function alreadySaved(hashOfText) {
    let names = [];
    try { names = fs.readdirSync(backupDir).filter((n) => n.endsWith('.md')); } catch { return false; }
    for (const n of names) {
      try {
        if (sha(fs.readFileSync(path.join(backupDir, n), 'utf8')) === hashOfText) return true;
      } catch { /* 读不了就跳过 */ }
    }
    return false;
  }

  /** 看一眼。返回 {changed, seeded, backedUpTo} 方便测试与手工核对。 */
  function tick() {
    let now;
    try { now = fs.readFileSync(file, 'utf8'); } catch { return { changed: false, why: '读不到' }; }

    const h = sha(now);
    const st = readState();

    // 第一次见：把当前这份当成基线，不备份（没有"变之前"可言）
    if (!st.hash || !fs.existsSync(lastFile)) {
      try {
        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(lastFile, now, 'utf8');
      } catch { /* ignore */ }
      writeState({ ...st, hash: h, at: new Date().toISOString() });
      return { changed: false, seeded: true };
    }

    if (h === st.hash) return { changed: false };

    // 变了：上一版还没存过，就存一份
    let backedUpTo = null;
    try {
      const prev = fs.readFileSync(lastFile, 'utf8');
      const ph = sha(prev);
      if (ph !== st.savedHash && !alreadySaved(ph)) {
        fs.mkdirSync(backupDir, { recursive: true });
        const out = path.join(backupDir, `${label}-${stamp()}-auto.md`);
        fs.writeFileSync(out, prev, 'utf8');
        backedUpTo = out;
        logger('persona', `${label}.md 被改过（不走 self.mjs / 面板的那种），上一版已留：${path.basename(out)}`);
      }
      if (ph !== st.savedHash) st.savedHash = ph;
      fs.writeFileSync(lastFile, now, 'utf8');
    } catch { /* ignore */ }

    writeState({ ...st, hash: h, at: new Date().toISOString() });
    return { changed: true, backedUpTo };
  }

  return { tick, file };
}
