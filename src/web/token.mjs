// 桥的本地接口令牌。
//
// 为什么需要：2026-10-22 外部评审指出——/api/* 原来只校验 Origin（任意 127.0.0.1 端口都算）
// 和一个能自己加的头，于是本机**任何**网页都能通过预检、以主人权限调 /api/try 让 agent 干活。
// 现在所有 /api/* 都要带 `x-qad-token`，令牌只写在项目 data/ 下，插件代理与本地脚本自己读。
//
// 这不是加密，只是把"本机任意程序随手一敲"变成"得先读到这个文件"。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const TOKEN_HEADER = 'x-qad-token';

/** 读令牌；没有就生成一个（32 位十六进制）。 */
export function ensureToken(dir) {
  const file = path.join(dir, 'web-token');
  try {
    const got = fs.readFileSync(file, 'utf8').trim();
    if (got.length >= 16) return got;
  } catch { /* 没有就往下走 */ }
  const made = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, made + '\n', { mode: 0o600 });
  return made;
}

/** 不主动生成，只读（插件、脚本用；桥没跑过就没有）。 */
export function readToken(dir) {
  try {
    return fs.readFileSync(path.join(dir, 'web-token'), 'utf8').trim();
  } catch {
    return '';
  }
}
