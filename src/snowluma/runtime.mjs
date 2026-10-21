// SnowLuma 本体放哪儿、有没有在跑。
//
// 找的顺序：配置里写的 snowluma.dir → 项目自带的 vendor/snowluma。
// 不猜别人硬盘上的布局：找不到就明说，让人用 scripts/find-snowluma.mjs 指一下。
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { ROOT } from '../config.mjs';

/** 这几个位置里第一个像样的 */
export function resolveDir(cfg = {}) {
  const want = [];
  const configured = cfg.snowluma?.dir || cfg.onebot?.snowlumaDir;
  if (configured) want.push(configured);
  want.push(path.join(ROOT, 'vendor', 'snowluma'));


  for (const dir of want) {
    try {
      if (fs.statSync(path.join(dir, 'index.mjs')).isFile()) {
        return { dir, bundled: dir.startsWith(path.join(ROOT, 'vendor')) };
      }
    } catch { /* 看下一个 */ }
  }
  return null;
}

/** 有东西在这个端口上听吗 */
export function isPortOpen(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

/** 从 onebot 的 wsUrl 里拿端口 */
export function portOf(url, fallback = 3001) {
  try {
    return Number(new URL(url).port) || fallback;
  } catch {
    return fallback;
  }
}
