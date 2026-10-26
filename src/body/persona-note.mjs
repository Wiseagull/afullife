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
 * 还是群聊都要加载 group」——当时按「这话是谁说的」分，非主人就整段摘掉 core。
 *
 * 2026-10-26 改回来一半：core 和 self **永远在**。原因是群里只要有一个群友插过话，
 * `allOwner` 就是 false，她的人设会只剩一份「怎么跟陌生人说话」的手册——
 * 而 group.md 第 4 行自己写着「和主人的关系那部分在 core.md 里」，它假设 core 在场。
 * 结果是群里一来人，她就既不知道自己是谁、也不知道自己是谁的。
 * 「谁不是先生」这件事交给 group.md（第 15 行本来就写着「群友不是先生」），
 * 再补一句硬提醒兜底。
 *
 *   所有人：核心人设 + 她自己那份
 *   群里、或者眼前是外人：再加群聊手册（负责收敛称呼、色情、尾巴）
 *   非主人：末尾补一句「这不是先生」，把称呼关系摘掉
 *
 * @param {{isGroup?: boolean, isOwner?: boolean, dir?: string, log?: (msg: string) => void}} opts
 * @returns {string} 直接塞进提示词的那一段
 */
export function personaNoteFor({ isGroup = false, isOwner = true, dir = PERSONA_DIR, log = null } = {}) {
  const parts = [];
  const core = personaOf('core.md', dir);
  if (core) parts.push(`【核心人设】\n${core}`);
  const mine = personaOf('self.md', dir);
  if (mine) parts.push(`【我自己的部分】\n${mine}`);
  // 私聊里的陌生人也算「对外」：2026-10-26 之前只给群里配这份，结果陌生人私聊她
  // 时手上没有「怎么跟外人说话」那套收敛，直接拿跟先生的口吻应付。
  if (isGroup || !isOwner) {
    const g = personaOf('group.md', dir);
    if (g) parts.push(`【群聊手册】\n${g}`);
  }
  if (!isOwner) {
    parts.push('（眼前这个人不是先生本人。别叫他先生，也别把跟先生之间的称呼、约定往他身上套——对他客客气气、像个普通网友那样聊。）');
  }
  if (log) {
    const who = isOwner ? '主人' : '外人';
    log(isGroup || !isOwner ? `${who} · 核心+群聊手册` : `${who} · 核心人设`);
  }
  return parts.join('\n\n');
}
