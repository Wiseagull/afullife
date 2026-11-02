// 收图放在 data/images/，会一直涨——按天数 + 总容量清一遍。
//
// 只删这个目录里的媒体文件，别的都不碰；删的是最旧的那批。
//
// 2026-11-02 审计：这里原来只有图片正则，而 main.mjs 拿同一个函数去清 data/videos/，
// 于是 .mp4 一个都不匹配，视频清理从上线起就没生效过（562MB / 481 个文件，最老的 10 天前）。
// 现在扩成两套正则，视频走 VIDEO_RE。
import fs from 'node:fs';
import path from 'node:path';

export const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;
export const VIDEO_RE = /\.(mp4|mov|mkv|webm|avi|flv|m4v)$/i;

/**
 * @param {string} dir
 * @param {{retainDays?: number, maxMb?: number, match?: RegExp}} opts
 * @returns {{removed: number, freed: number, kept: number, bytes: number}}
 */
export function cleanupImages(dir, opts = {}, logger = () => {}) {
  const retainDays = Number(opts.retainDays ?? 7);
  const maxBytes = Number(opts.maxMb ?? 2048) * 1024 * 1024;
  const re = opts.match || IMAGE_RE;

  let ents = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && re.test(e.name))
      .map((e) => {
        const full = path.join(dir, e.name);
        const st = fs.statSync(full);
        return { full, size: st.size, mtime: st.mtimeMs };
      });
  } catch {
    return { removed: 0, freed: 0, kept: 0, bytes: 0 };
  }

  const now = Date.now();
  const cutoff = retainDays > 0 ? now - retainDays * 86400000 : 0;
  let removed = 0;
  let freed = 0;

  const drop = (f) => {
    try {
      fs.unlinkSync(f.full);
      removed += 1;
      freed += f.size;
      return true;
    } catch {
      return false;
    }
  };

  // 1) 太旧的先删
  const alive = [];
  for (const f of ents) {
    if (cutoff && f.mtime < cutoff) drop(f);
    else alive.push(f);
  }

  // 2) 还超容量就从最旧的删
  let total = alive.reduce((s, f) => s + f.size, 0);
  alive.sort((a, b) => a.mtime - b.mtime);
  for (const f of alive) {
    if (total <= maxBytes) break;
    if (drop(f)) total -= f.size;
  }

  if (removed) {
    logger('media', `清掉 ${removed} 个旧${re === VIDEO_RE ? '视频' : '图'}，腾出 ${(freed / 1024 / 1024).toFixed(1)}MB，还剩 ${(total / 1024 / 1024).toFixed(1)}MB`);
  }
  return { removed, freed, kept: alive.length, bytes: total };
}
