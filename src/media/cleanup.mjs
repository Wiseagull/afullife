// 收图放在 data/images/，会一直涨——按天数 + 总容量清一遍。
//
// 只删这个目录里的图片文件，别的都不碰；删的是最旧的那批。
import fs from 'node:fs';
import path from 'node:path';

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

/**
 * @param {string} dir
 * @param {{retainDays?: number, maxMb?: number}} opts
 * @returns {{removed: number, freed: number, kept: number, bytes: number}}
 */
export function cleanupImages(dir, opts = {}, logger = () => {}) {
  const retainDays = Number(opts.retainDays ?? 7);
  const maxBytes = Number(opts.maxMb ?? 2048) * 1024 * 1024;

  let ents = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && IMAGE_RE.test(e.name))
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
    logger('media', `清掉 ${removed} 张旧图，腾出 ${(freed / 1024 / 1024).toFixed(1)}MB，还剩 ${(total / 1024 / 1024).toFixed(1)}MB`);
  }
  return { removed, freed, kept: alive.length, bytes: total };
}
