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
 * 目录里放一个 keep.json（数组，写文件名，或 {"keep": [...]}）就是「这些别清」。
 *
 * 加它是为了 data/stickers/reject：那个目录只有账龄（30 天），没有出口。
 * 2026-11-06 晚上翻 10-21 那 16 张照片时才看清：判退是对的，但「不像表情包」
 * 不等于「没用」——那是别人的一个晚上。给它们登个记，就让它们原地留着，
 * 不用我每次手动复制一份出来。
 *
 * 读不出来 / 格式不对就当没有，绝不让一个坏文件把清理整个卡住。
 */
function readKeepList(dir) {
  const set = new Set();
  try {
    const raw = fs.readFileSync(path.join(dir, 'keep.json'), 'utf8');
    const j = JSON.parse(raw);
    const arr = Array.isArray(j) ? j : (Array.isArray(j?.keep) ? j.keep : []);
    for (const x of arr) {
      const name = typeof x === 'string' ? x : (x && typeof x.name === 'string' ? x.name : '');
      if (name && path.basename(name) === name) set.add(name); // 只认本目录内的文件名
    }
  } catch { /* 没有就是没有 */ }
  return set;
}

// 一次删掉目录里这么大一坨，几乎只能是参数写错了（0 或者单位写反）。
// 2026-11-06 实测代价：拿 {maxMb: 0} 去试 reject，464 张当场没了，fs.unlink 不进回收站，找不回来。
// 手动试跑，别猜参数（这条命令只报数，一个字节都不动）：
//   node -e "import('./src/media/cleanup.mjs').then(m=>console.log(m.cleanupImages('data/stickers/reject',{retainDays:30,maxMb:256,dry:true},console.log)))"
const MASS_DROP_MIN = 40;    // 目录本身没这么多文件就不设闸，别拦日常的十几张
const MASS_DROP_RATIO = 0.6; // 一次超过六成就停下问一句

/**
 * @param {string} dir
 * @param {{retainDays?: number, maxMb?: number, match?: RegExp, dry?: boolean, force?: boolean}} opts
 *   dry=true 只报数不动刀；force=true 跳过「一次删太多」的闸。
 * @returns {{removed: number, freed: number, kept: number, bytes: number, planned?: number, refused?: boolean}}
 */
export function cleanupImages(dir, opts = {}, logger = () => {}) {
  const retainDays = Number(opts.retainDays ?? 7);
  const maxBytes = Number(opts.maxMb ?? 2048) * 1024 * 1024;
  const re = opts.match || IMAGE_RE;
  const keep = readKeepList(dir);
  const dry = opts.dry === true;
  const force = opts.force === true;

  let raw = [];
  try {
    raw = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && re.test(e.name))
      .map((e) => {
        const full = path.join(dir, e.name);
        const st = fs.statSync(full);
        return { full, name: e.name, size: st.size, mtime: st.mtimeMs, keep: keep.has(e.name) };
      });
  } catch {
    return { removed: 0, freed: 0, kept: 0, bytes: 0 };
  }

  const now = Date.now();
  const cutoff = retainDays > 0 ? now - retainDays * 86400000 : 0;
  const pinned = raw.filter((f) => f.keep).length;
  const sizeOf = (list) => list.reduce((s, f) => s + f.size, 0);

  // 先算成一张清单，再动刀。
  // 边判边删的话，算到一半出错就已经删了一半，也没法在动手前问一句「这一刀是不是太宽」。
  const doomed = [];
  const alive = [];
  // 1) 太旧的（keep.json 里登过记的不算）
  for (const f of raw) {
    if (f.keep) { alive.push(f); continue; }
    if (cutoff && f.mtime < cutoff) doomed.push(f);
    else alive.push(f);
  }
  // 2) 还超容量就从最旧的删，登记的排在最后
  alive.sort((a, b) => (a.keep === b.keep ? a.mtime - b.mtime : (a.keep ? 1 : -1)));
  let total = sizeOf(alive);
  for (const f of alive) {
    if (total <= maxBytes) break;
    if (f.keep) continue;
    doomed.push(f);
    total -= f.size;
  }

  // 闸：一次要删掉大半个目录，先停手（dry 不落刀，所以照报不拦）。
  if (!dry && !force && doomed.length > MASS_DROP_MIN && doomed.length > raw.length * MASS_DROP_RATIO) {
    logger('media', `这次要清 ${doomed.length}/${raw.length} 个，看着像参数写错了，一个没动`
      + `（确认要清就加 force:true）`);
    return { removed: 0, freed: 0, kept: raw.length, bytes: sizeOf(raw), planned: doomed.length, refused: true };
  }

  let removed = 0;
  let freed = 0;
  for (const f of doomed) {
    // dry 只报数不落刀。2026-11-06 我拿 {maxMb:0} 去试 reject，以为有 dry，
    // 结果它真删了 464 张——这个开关是当场补的，补完才轮到这道闸。
    if (dry) { removed += 1; freed += f.size; continue; }
    try {
      fs.unlinkSync(f.full);
      removed += 1;
      freed += f.size;
    } catch { /* 删不动就留着，下一轮再说 */ }
  }
  // 「还剩」按盘上真留下的算。别拿 total 去减 freed：容量那一段已经减过一次，
  // 而 total 里本来就没有账龄判退的那批——减两遍会把报数压小（2026-11-06 自测抓到的）。
  // 试跑也一样报「删完之后剩多少」，不是拿当前大小冒充：dry 就是拿来判断要不要下刀的，
  // 报个数报得比真删之后还满，等于骗自己（2026-11-06 晚，已知大小复验时抓到的第二处）。
  total = dry
    ? sizeOf(raw) - sizeOf(doomed)
    : sizeOf(raw.filter((f) => fs.existsSync(f.full)));

  if (pinned) logger('media', `有 ${pinned} 个登记过的，这次不碰`);

  if (removed) {
    logger('media', `${dry ? '（试跑，没删）' : ''}清掉 ${removed} 个旧${re === VIDEO_RE ? '视频' : '图'}，`
      + `腾出 ${(freed / 1024 / 1024).toFixed(1)}MB，还剩 ${(total / 1024 / 1024).toFixed(1)}MB`);
  }
  return { removed, freed, kept: raw.length - removed, bytes: total, planned: doomed.length };
}
