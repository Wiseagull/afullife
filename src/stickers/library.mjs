// 她自己的表情库。
//
// 两张表不一样：
//   - `mine.json` 是 QQ 里**主人**收藏的表情（只在本机有，只读，借来用）；
//   - 这里这个 library 是**她自己**收的：收到的图先扔进来当"待分类"，
//     之后她按当时的语境打标签（撒娇/无语/开心…），发的时候按情境挑。
//
// 分类靠"当时的上下文"而不是看图：她还看不了图，但知道这图是谁在什么场合发的。
//
// 路径一律存**相对项目根**的相对路径 —— 这个项目要打包给别人，写死 C:\ 或 E:\ 就废了。
import fs from 'node:fs';
import path from 'node:path';

const EXT_OK = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

const toRel = (root, p) => path.relative(root, p).split(path.sep).join('/');

/**
 * 看文件头猜真身。QQ 下来的图统统叫 `.png`，里头可能是 jpg 也可能是 gif；
 * 按名字存下去，后面按图片格式读它的人（比如我自己看图）会被扩展名骗到，
 * 直接报「声明是 png，内容不是」。所以存的时候按真身取名。
 * 猜不出就返回 null，让调用方退回按扩展名走。
 */
const sniffExt = (file) => {
  let b;
  try {
    b = Buffer.alloc(12);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, b, 0, 12, 0); } finally { fs.closeSync(fd); }
  } catch { return null; }
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return '.png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return '.jpg';
  if (b.slice(0, 4).toString('latin1') === 'GIF8') return '.gif';
  if (b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP') return '.webp';
  return null;
};

export class StickerLibrary {
  #file;
  #dir;
  #root;
  #data;
  #logger;

  constructor({ file, dir, root, logger = null }) {
    this.#file = file;
    this.#logger = logger;
    this.#dir = dir;
    this.#root = root || path.dirname(dir);
    try {
      this.#data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(this.#data.tombstones)) this.#data.tombstones = [];
    } catch {
      this.#data = { items: [], seq: 0, tombstones: [] };
    }
    if (!Array.isArray(this.#data.items)) this.#data.items = [];
    fs.mkdirSync(dir, { recursive: true });
    this.#migrate();
  }

  /** 绝对路径 —— 发图、读文件都用它。 */
  abs(item) {
    return path.isAbsolute(item.file) ? item.file : path.resolve(this.#root, item.file);
  }

  all() {
    return this.#data.items.map((it) => ({ ...it, abs: this.abs(it) }));
  }

  get(id) {
    const it = this.#data.items.find((i) => i.id === id);
    return it ? { ...it, abs: this.abs(it) } : null;
  }

  /** 收一张图进库。已经在库里（同来源同名同大小）就不重复收。 */
  add({ src, tags = [], when = '', ctx = '', from = '', room = null, pending = false }) {
    const ext = path.extname(src).toLowerCase();
    if (!EXT_OK.has(ext)) throw new Error(`不是图片：${ext || '(没有扩展名)'}`);
    // 存的时候按文件头取名，不按 QQ 给的假扩展名（见 sniffExt 的注释）
    const sniffed = sniffExt(src);
    const real = sniffed && EXT_OK.has(sniffed) ? sniffed : ext;
    const size = fs.statSync(src).size;
    const originName = path.basename(src);

    const dup = this.#data.items.find((i) => i.originName === originName && i.bytes === size);
    if (dup) return { item: this.get(dup.id), dup: true };

    // 编号别撞上盘上已有的文件：撞了 copyFileSync 会把旧图直接盖掉，图上就真丢了。
    // （2026-10-21 实测发现：桥和 CLI 各拿一份内存，seq 会退回去。）
    const used = new Set([...this.#data.items.map((i) => i.id)]);
    try {
      for (const f of fs.readdirSync(this.#dir)) used.add(f.replace(/\.[^.]+$/, ''));
    } catch { /* 目录还没建就先不管，下面 copyFileSync 自己会报 */ }
    let id;
    do { id = `k${String(++this.#data.seq).padStart(4, '0')}`; } while (used.has(id));
    const dest = path.join(this.#dir, `${id}${real}`);
    fs.copyFileSync(src, dest);

    const item = {
      id,
      file: toRel(this.#root, dest),
      bytes: size,
      tags: tags.filter(Boolean),
      when: String(when || '').trim(),
      ctx: String(ctx || '').trim(),
      from: String(from || '').trim(),
      room,
      originName,
      addedAt: Date.now(),
      usedAt: null,
      used: 0,
      pending: pending ? true : false,
    };
    this.#data.items.push(item);
    this.#save();
    return { item: this.get(id), dup: false };
  }

  /** 还没判断"像不像表情"的那些 */
  pendingAll() {
    return this.all().filter((it) => it.pending === true);
  }

  /** 判断通过：进收藏 */
  approve(id, { tags = [], when = '' } = {}) {
    const it = this.#data.items.find((i) => i.id === id);
    if (!it) return null;
    it.pending = false;
    if (tags.length) it.tags = [...new Set([...(it.tags || []), ...tags.filter(Boolean)])];
    if (when) it.when = String(when).trim();
    this.#save();
    return this.get(id);
  }

  /** 不像表情（截图之类）：移出库，落到 reject 目录留个档，不直接删 */
  reject(id, reason = '') {
    const i = this.#data.items.findIndex((x) => x.id === id);
    if (i < 0) return false;
    const [it] = this.#data.items.splice(i, 1);
    const src = this.abs(it);
    const dir = path.join(this.#dir, '..', 'reject');
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.renameSync(src, path.join(dir, `${it.id}${path.extname(src) || '.png'}`));
    } catch {
      try { fs.unlinkSync(src); } catch { /* 没了就算了 */ }
    }
    // 墓碑：跟 drop()/prune() 一样。以前这里靠「文件已经挪走了、合并时 existsSync 是 false」
    // 侥幸躲过复活；但 Windows 上文件被别的程序占着时 rename 和 unlink 都会失败，
    // 图还在原处，下一次保存就把它原样并回来了（2026-10-22 跑 tmp/test-prune2.mjs 撞出来的）。
    this.#data.tombstones.push({ id, at: new Date().toISOString() });
    const keepFrom = Date.now() - 30 * 24 * 3600 * 1000;
    this.#data.tombstones = this.#data.tombstones.filter((t) => {
      const ts = Date.parse(t?.at || '');
      return Number.isFinite(ts) ? ts >= keepFrom : true;
    });
    const archive = path.join(this.#dir, '..', `reject-${new Date().toISOString().slice(0, 10)}.jsonl`);
    try {
      const line = JSON.stringify({ ...it, reason, rejectedAt: Date.now() });
      fs.appendFileSync(archive, line + String.fromCharCode(10), 'utf8');
    } catch { /* 记不上也别拦着 */ }
    this.#save();
    return true;
  }

  update(id, patch = {}) {
    const it = this.#data.items.find((i) => i.id === id);
    if (!it) return null;
    for (const k of ['tags', 'when', 'from', 'used']) {
      if (patch[k] !== undefined) it[k] = patch[k];
    }
    this.#save();
    return this.get(id);
  }

  drop(id) {
    const i = this.#data.items.findIndex((x) => x.id === id);
    if (i < 0) return false;
    const [it] = this.#data.items.splice(i, 1);
    // 留一块墓碑：万一下次保存要合并盘上的旧数据，别把刚删的又复活回来
    this.#data.tombstones.push({ id, at: new Date().toISOString() });
    const cut = Date.now() - 30 * 24 * 3600 * 1000;
    this.#data.tombstones = this.#data.tombstones.filter((t) => {
      const ts = Date.parse(t?.at || '');
      return Number.isFinite(ts) ? ts >= cut : true;
    });
    try { fs.unlinkSync(this.abs(it)); } catch { /* 文件没了就算了 */ }
    this.#save();
    return true;
  }

  /** 按标签 / 情境词 / 有没有分过类 找。 */
  search({ tags = [], text = '', unclassified = false, limit = 20, includePending = false } = {}) {
    const want = tags.map((t) => String(t).trim()).filter(Boolean);
    return this.all()
      .filter((it) => {
        if (!includePending && it.pending === true) return false;
        if (unclassified && it.tags.length) return false;
        if (want.length && !want.every((t) => it.tags.some((x) => x.includes(t) || t.includes(x)))) return false;
        if (text) {
          const hay = `${it.tags.join(' ')} ${it.when} ${it.from}`.toLowerCase();
          if (!hay.includes(String(text).toLowerCase())) return false;
        }
        return true;
      })
      .sort((a, b) => a.used - b.used || b.addedAt - a.addedAt)
      .slice(0, limit);
  }

  /** 按文件路径反查（发图时用它记账，路径可能带反斜杠/相对写法） */
  findByFile(file) {
    if (!file) return null;
    let target;
    try { target = path.resolve(String(file)); } catch { return null; }
    const hit = this.#data.items.find((i) => {
      try { return path.resolve(this.abs(i)) === target; } catch { return false; }
    });
    return hit ? { ...hit, abs: this.abs(hit) } : null;
  }

  markUsed(id) {
    const it = this.#data.items.find((i) => i.id === id);
    if (!it) return null;
    it.used += 1;
    it.usedAt = Date.now();
    this.#save();
    return this.get(id);
  }

  /** 现在多少张、多大（字节）。 */
  stats() {
    const bytes = this.#data.items.reduce((s, i) => s + (i.bytes || 0), 0);
    return { count: this.#data.items.length, bytes };
  }

  /**
   * 库满了就自己收一收：按“用得多不多”排，用得最少的先走。
   *
   * 排序用的是三段：用过的次数 → 最后一次用的时间 → 什么时候收进来的。
   * 所以从来没发过的、最老的那些最先被删；常用的那些永远排后面。
   *
   * 删掉的不只是记录，磁盘上的图也一起删；记录先写进
   * `data/stickers/archive-YYYY-MM-DD.jsonl`，想捞还能捞。
   *
   * @param {{maxCount?: number, maxMb?: number, dry?: boolean}} limits
   */
  prune({ maxCount = 300, maxMb = 200, dry = false } = {}, logger = () => {}) {
    const limitBytes = maxMb * 1024 * 1024;
    let { count, bytes } = this.stats();
    const over = () => count > maxCount || bytes > limitBytes;
    if (!over()) return { removed: 0, count, bytes };

    // 排序分四档，别把「没用过」直接当 0 次——现在库里绝大多数是空记录，
    // 按 0 次排等于按入库时间排，会专挑最早存的删（2026-10-21 实测发现的问题）。
    //   ⓪ 标了「重复」= 内容跟别人重了 → 最先走（2026-10-22 加的；删了 archive 里还留着）
    //   ① 没标签 = 不知道什么场合用 → 其次
    //   ② 有标签但从没发过 = 还没试过 → 再次，早存的先走
    //   ③ 发过的 → 按「多久没用了」从久到近
    const tier = (it) => {
      const tagged = Array.isArray(it.tags) && it.tags.length > 0;
      if ((it.tags || []).includes('重复')) return -1;
      if (!(it.used > 0)) return tagged ? 1 : 0;
      return 2;
    };
    const victims = [...this.#data.items].sort((a, b) => {
      const t = tier(a) - tier(b);
      if (t !== 0) return t;
      const ta = tier(a);
      if (ta === 2) return (a.usedAt || 0) - (b.usedAt || 0);
      if (ta === 1) return (a.addedAt || 0) - (b.addedAt || 0);
      // 第三档内部：字节大的先走（同样的"没头绪"，先腾地方）
      return (b.bytes || 0) - (a.bytes || 0) || (a.addedAt || 0) - (b.addedAt || 0);
    });

    const gone = [];
    for (const it of victims) {
      if (!over()) break;
      gone.push(it);
      count -= 1;
      bytes -= it.bytes || 0;
    }

    if (dry) {
      logger('sticker', `[dry] 超了，会删 ${gone.length} 张（剩下 ${count} 张 / ${(bytes / 1048576).toFixed(1)}MB）`);
      return { removed: gone.length, count, bytes, dry: true };
    }

    // 先留档再动手
    const archive = path.join(this.#dir, '..', `archive-${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    fs.appendFileSync(
      archive,
      gone.map((it) => JSON.stringify({ ...it, prunedAt: Date.now() })).join('\n') + '\n',
      'utf8',
    );

    const ids = new Set(gone.map((i) => i.id));
    this.#data.items = this.#data.items.filter((i) => !ids.has(i.id));
    // 墓碑：跟 drop() 一样。不写的话，#save() 里的合并会把刚删的从盘上原样复活，
    // 删了个寂寞（2026-10-22 跑 tmp/test-prune.mjs 当场撞出来的）。
    for (const it of gone) this.#data.tombstones.push({ id: it.id, at: new Date().toISOString() });
    const cut = Date.now() - 30 * 24 * 3600 * 1000;
    this.#data.tombstones = this.#data.tombstones.filter((t) => {
      const ts = Date.parse(t?.at || '');
      return Number.isFinite(ts) ? ts >= cut : true;
    });
    this.#save();
    for (const it of gone) {
      // 只删自己库目录里的文件。记录里的路径是相对项目根的，
      // 万一哪天被指到别处（比如有人拿别的目录试跑），也不能误删别人的图。
      const target = this.abs(it);
      if (path.dirname(target) !== path.resolve(this.#dir)) {
        logger('sticker', `跳过：${it.id} 不在库目录里（${target}）`);
        continue;
      }
      try { fs.unlinkSync(target); } catch { /* 文件早没了就算 */ }
    }
    logger('sticker', `库满了，清掉 ${gone.length} 张（用得最少的先走），剩 ${count} 张 / ${(bytes / 1048576).toFixed(1)}MB`);
    return { removed: gone.length, count, bytes };
  }

  /** 老数据里存的是绝对路径，读进来时统一改成相对路径。 */
  #migrate() {
    let dirty = false;
    for (const it of this.#data.items) {
      if (it.file && path.isAbsolute(it.file)) {
        const rel = toRel(this.#root, it.file);
        if (!rel.startsWith('..')) {
          it.file = rel;
          dirty = true;
        }
      }
      if (it.origin !== undefined) {
        it.originName = it.originName || path.basename(String(it.origin));
        delete it.origin;
        dirty = true;
      }
    }
    if (dirty) this.#save();
  }

  /**
   * 落盘。写之前先看看盘上有没有别人（别的进程、手工改过）写进来的条目，
   * 有就并进来再写 —— 否则整份覆盖会把它们抹掉。
   *
   * 为什么还留着这一手：桥是常驻的，内存里的账从启动那刻就固定了。
   * 虽然现在正常路径只有一个写者（CLI 走桥的 HTTP 接口），但只要有人
   * 在桥外面动过 library.json（比如桥忙到 CLI 超时退回本地写、或者手工改），
   * 桥的下一次保存就会把它冲掉。合并是最后一道保险。
   */
  #mergeFromDisk() {
    let disk;
    try {
      disk = JSON.parse(fs.readFileSync(this.#file, 'utf8'));
    } catch {
      return; // 文件不在 / 读不动，就按内存这份写
    }
    const mine = new Map(this.#data.items.map((i) => [i.id, i]));
    const dead = new Set((this.#data.tombstones || []).map((t) => t?.id).filter(Boolean));
    let added = 0;
    for (const it of Array.isArray(disk?.items) ? disk.items : []) {
      if (!it?.id || mine.has(it.id) || dead.has(it.id)) continue;
      if (!fs.existsSync(this.abs(it))) continue; // 记录在、图不在，就别并进来
      mine.set(it.id, it);
      added += 1;
    }
    if (added) {
      this.#data.items = [...mine.values()];
      this.#logger?.('sticker', `合并了盘上 ${added} 条别人写进来的记录`);
    }
    // 编号也得跟着往后退，不能比盘上小，不然又要撞
    const diskSeq = Number(disk?.seq || 0);
    if (Number.isFinite(diskSeq) && diskSeq > this.#data.seq) this.#data.seq = diskSeq;
  }

  #save() {
    this.#mergeFromDisk();
    const tmp = `${this.#file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.#data, null, 1), 'utf8');
    fs.renameSync(tmp, this.#file);
  }
}
