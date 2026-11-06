// 收到的图落盘：同一张图收几遍都只存一份。
//
// 2026-11-05 量的：data/images 里 1065 个文件，去掉重复只剩 504 张不同的图——
// 一张 106KB 的表情在 4.3 天里被存了 46 遍，一个 1.2MB 的动图存了 17 遍，
// 光重复就占 150MB。名字原来是 msgId，同一张图每来一次换一个名字，谁也认不出谁。
//
// 为什么要紧：清理是按 mtime 删最旧的。一张老表情被人反复发，就会一直占着几十个名额，
// 把没重复过的图挤出去——容量花在复读上，能记住的东西反而更少。
//
// 所以名字改成内容哈希：再来同一张，只把 mtime 拨新（等于"最近又用到过"），不再写第二份。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sniffImage } from './sniff.mjs';

/**
 * 把一张图写进 dir，内容相同就不重复写。
 * @param {string} dir 目录（会先建好）
 * @param {Buffer} buf 图的内容
 * @param {{fallbackExt?: string}} opts 嗅不出文件头时用的扩展名（一般从 URL 后缀来）
 * @returns {{file: string, reused: boolean}}
 */
export function storeImageBuffer(dir, buf, opts = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const ext = sniffImage(buf) || String(opts.fallbackExt || 'png').toLowerCase().replace(/^\./, '');
  const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
  const file = path.join(dir, `${hash}.${ext}`);
  try {
    if (fs.statSync(file).size === buf.length) {
      const now = new Date();
      fs.utimesSync(file, now, now);
      return { file, reused: true };
    }
  } catch { /* 没有就是第一次，往下写 */ }
  fs.writeFileSync(file, buf);
  return { file, reused: false };
}
