// 人格三层怎么拼进提示词：core 每轮带；group 只在群里带；self 每轮带。
//
// 这段原来长在 src/main.mjs 里。2026-10-22 那件事的根因就在它身上：注释写着
// 「核心卡是 DSH 按工作区 AGENTS.md 自动加载的」，可工作区搬进项目之后，那儿的
// AGENTS.md 只有干活规矩——14KB 的 core.md 整整几天没进过任何一轮提示词，
// 是她自己翻出来的。
//
// 挪成单独模块，是为了让 selftest 能直接钉住「core 真的进了提示词」这件事：
// 下次谁把这行删了，测试会先叫，不用等人再怀疑「她怎么不像她了」。
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from '../config.mjs';

export const PERSONA_DIR = path.join(ROOT, 'persona');

function personaOf(name, dir) {
  try { return fs.readFileSync(path.join(dir, name), 'utf8').trim(); } catch { return ''; }
}

/**
 * 按场合拼三层人设。
 *
 * 2026-10-22 晚上（主人 m13170）：「core 能不能只针对主人号一个人，其他人不管私聊
 * 还是群聊都要加载 group」——所以按「这话是谁说的」分：
 *   主人：核心人设（+ 群里再补群聊手册） + 她自己那份
 *   别人：只有群聊手册，再补一句「这不是先生」，把人设里的称呼关系彻底摘掉
 *
 * @param {{isGroup?: boolean, isOwner?: boolean, dir?: string, log?: (msg: string) => void}} opts
 * @returns {string} 直接塞进提示词的那一段
 */
export function personaNoteFor({ isGroup = false, isOwner = true, dir = PERSONA_DIR, log = null } = {}) {
  const parts = [];
  if (isOwner) {
    const core = personaOf('core.md', dir);
    if (core) parts.push(`【核心人设】\n${core}`);
  }
  if (isGroup || !isOwner) {
    const g = personaOf('group.md', dir);
    if (g) {
      const head = isOwner ? '【群聊手册】' : '【对外的人设：跟主人以外的人说话用这份】';
      parts.push(`${head}\n${g}`);
    }
  }
  if (isOwner) {
    const mine = personaOf('self.md', dir);
    if (mine) parts.push(`【我自己的部分】\n${mine}`);
  } else {
    parts.push('（眼前这个人不是先生本人。别叫他先生，也别把跟先生之间的称呼、约定往他身上套——对他客客气气、像个普通网友那样聊。）');
  }
  if (log) log(isOwner ? (isGroup ? '主人 · 核心+群聊手册' : '主人 · 核心人设') : '对外人设（非主人）');
  return parts.join('\n\n');
}
