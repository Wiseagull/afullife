// 桥自己看自己：进程起来之后，src/ 下还有谁被改过？
//
// 2026-11-01 一天里栽了三回同一件事：改完代码、自检全绿，就说"好了"，而跑着的桥
// 还是开机时那份。scripts/probe-stale.mjs 修的是"能不能问"——可它得有人记得问。
// 桥自己从来不问，所以一到夜里、没人提醒的时候，那句话就永远没人说。
//
// 这里补的是另一半：进程活着的时候每几分钟自己扫一眼，发现改过就记一行日志。
// 它只能说一件事，也只该说这一件事——**启动之后**改过的文件没进这个进程。
// "我启动时读的是不是旧代码"它答不了（要能答，那份代码得先进得来）。那条留给外面的探针。
//
// 判据只有"谁比谁新"：拿扫描时刻的 mtime 比进程启动时刻，不看内容。
// touch 过、改完又改回去的也会被点名——和探针同一个口径，宁可多嘴，不可漏嘴。
import fs from 'node:fs';
import path from 'node:path';

// 边界余量：since 之前这么久以内改过的，也算"没进这个进程"。
//
// 方向别搞反。since 取的是**进程启动时刻**，而 src/ 是在启动之后一两秒才逐个 import 的；
// 文件如果在这段缝里被改，进程读到的可能是改前也可能是改后，谁也说不准。
// 所以余量要往 since 的**前面**铺（sinceMs - tolerance），把这段缝盖住；
// 反过来把余量放在 since 之后（加而不是减），就等于主动放过启动后一秒内改过的文件——
// 那正好是"把刚改过的算成已生效"，是最坏的一种错。宁可多嘴，不可漏嘴。
export const TOLERANCE_MS = 3000;

export function walkFiles(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(full, out);
    else if (/\.(mjs|js)$/.test(ent.name)) out.push(full);
  }
  return out;
}

// 比 sinceMs 新的那些文件，最新的排前面。边界给 tolerance 的余量——**往前**铺。
// dir 可以是一个目录，也可以是几个：桥要盯的不止 src/（plugin/ 那份改了要刷新页面或重启 DSH）。
export function staleFrom(dir, sinceMs, tolerance = TOLERANCE_MS) {
  const dirs = Array.isArray(dir) ? dir : [dir];
  const files = [];
  for (const d of dirs) {
    try { walkFiles(d, files); } catch { /* 这个目录不在就跳过，别带崩别的 */ }
  }
  return files
    .map((f) => ({ file: f, mtime: fs.statSync(f).mtimeMs }))
    .filter((x) => x.mtime > sinceMs - tolerance)
    .sort((a, b) => b.mtime - a.mtime);
}

/**
 * 造一个"自己看自己"的看门人。不启动定时器，调用方说 start 才开始。
 *
 * @param {object} o
 * @param {string|string[]} o.dir   看哪些目录（一般是 src/，加上 plugin/、tools/）
 * @param {(tag: string, msg: string) => void} o.logger  记一行（桥传的是自己的 L）
 * @param {number} [o.sinceMs]      从哪一刻算"启动"，默认取本进程真实启动时刻
 * @param {number} [o.intervalMs]   多久扫一次，默认 5 分钟；<= 0 表示不扫
 * @param {number} [o.tolerance]    边界余量
 * @param {number} [o.maxLines]     一次最多点名几个，其余并成一句
 */
export function createStaleWatch({ dir, logger, sinceMs, intervalMs = 5 * 60 * 1000, tolerance = TOLERANCE_MS, maxLines = 5 } = {}) {
  // process.uptime() 是从进程起来算的秒数，比"这个模块被 import 的时刻"更准：
  // 模块是在启动过程里加载的，拿模块时刻当起点，会把启动那几秒改过的文件漏掉。
  const since = Number.isFinite(sinceMs) ? sinceMs : Date.now() - process.uptime() * 1000;
  const reported = new Set(); // `${file}:${mtimeMs}`，同一个版本只说一次
  let timer = null;

  const rel = (f) => {
    const r = path.relative(process.cwd(), f) || f;
    return r.split(path.sep).join('/');
  };

  // 不同的目录，生效的动作不一样——只报"没生效"、不报"该怎么生效"，等于让人自己猜。
  // plugin/ 那两份是宿主侧代码：panel 的面板刷新页面就换，别的是 DSH 本体的一部分。
  const howto = (f) => {
    const r = rel(f);
    if (r.includes('plugin/')) {
      return /client\.js$/.test(r) ? '改完要刷新面板页面' : '改完要重启 DSH（不是重启桥）';
    }
    if (r.includes('tools/')) return '改完要重启桥，她下次调用时才读到新版本';
    return '改完要重启桥';
  };

  /** 扫一次。返回这次**新**点名的文件；没有就返回空数组。 */
  function scan() {
    let found = [];
    try {
      found = staleFrom(dir, since, tolerance);
    } catch {
      return []; // 目录不在了、读不动：什么都不说，绝不拖累心跳
    }
    const fresh = [];
    for (const x of found) {
      const key = `${x.file}:${x.mtime}`;
      if (reported.has(key)) continue;
      reported.add(key);
      fresh.push(x);
    }
    if (!fresh.length) return [];

    try {
      const shown = fresh.slice(0, maxLines);
      for (const x of shown) {
        const when = new Date(x.mtime).toLocaleTimeString('zh-CN', { hour12: false });
        logger?.('stale', `这份还没生效：${rel(x.file)} ${when} 改过，没进我这个进程（${howto(x.file)}）`);
      }
      if (fresh.length > shown.length) {
        logger?.('stale', `……这一轮还有 ${fresh.length - shown.length} 个改过没生效，跑 npm run probe:stale 看全名单`);
      }
    } catch { /* 记不下就算了 */ }
    return fresh;
  }

  function start() {
    if (timer || !(intervalMs > 0)) return api;
    timer = setInterval(() => { scan(); }, intervalMs);
    timer.unref?.(); // 别让它一个人把进程留着不退出
    return api;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    return api;
  }

  const api = {
    scan,
    start,
    stop,
    since,
    get timer() { return timer; },
    get reported() { return reported.size; },
  };
  return api;
}
