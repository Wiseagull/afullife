// 自己去找 SnowLuma，自己把令牌读出来 —— 不需要使用者手抄，也不依赖 QQ Agent。
//
// SnowLuma 的配置长这样（<dir>/config/onebot_<QQ号>.json）：
//   networks.httpServers[0] = { host, port, accessToken, ... }   ← OneBot 的 HTTP 口
//   networks.wsServers[0]   = { host, port, accessToken, ... }   ← OneBot 的 WebSocket 口
// 两个 accessToken 是分开的两把钥匙。
import fs from 'node:fs';
import path from 'node:path';

/** 常见安装位置，按优先级排。返回第一个像样的（含 index.mjs 的目录）。 */
export function findDir({ configured = '', root = '' } = {}) {
  // 只在"用户明确告诉我的地方"里找，不猜别人的硬盘布局：
  //   1. config.local.json 的 snowluma.dir
  //   2. 项目自己的 vendor/snowluma（不想填路径就把 SnowLuma 放这儿）
  const want = [];
  if (configured) want.push(configured);
  if (root) want.push(path.join(root, 'vendor', 'snowluma'));

  for (const dir of want) {
    try {
      if (fs.statSync(path.join(dir, 'index.mjs')).isFile()) return dir;
    } catch { /* 看下一个 */ }
  }
  return null;
}

function pickServer(list, fallbackPort) {
  const arr = Array.isArray(list) ? list : [];
  for (const s of arr) {
    const port = Number(s?.port);
    if (!Number.isFinite(port) || port <= 0) continue;
    const host = String(s?.host || '127.0.0.1');
    return { host, port, token: String(s?.accessToken || '') };
  }
  return { host: '127.0.0.1', port: fallbackPort, token: '' };
}

/**
 * 从 SnowLuma 的目录里读出 OneBot 的连接信息。
 * 有多个 onebot_*.json 时：给了 uin 就用它，没给就取最新的那个，并报告用了哪份。
 * @returns {{ok: true, dir: string, file: string, uin: string, wsUrl: string, httpUrl: string,
 *            accessToken: string, httpToken: string, candidates: string[]} | {ok: false, reason: string, dir?: string, candidates?: string[]}}
 */
export function readOneBotConfig({ dir, uin = '' } = {}) {
  if (!dir) return { ok: false, reason: '没找到 SnowLuma 的目录' };
  const cfgDir = path.join(dir, 'config');
  let files = [];
  try {
    files = fs.readdirSync(cfgDir).filter((f) => /^onebot_.*\.json$/i.test(f));
  } catch {
    return { ok: false, dir, reason: `这个目录里没有 config/：${cfgDir}` };
  }
  if (!files.length) return { ok: false, dir, reason: 'SnowLuma 还没登录过 QQ（config/ 里没有 onebot_*.json）' };

  const wanted = String(uin || '').trim();
  let file = '';
  if (wanted) {
    file = files.find((f) => f.includes(wanted)) || '';
    if (!file) {
      return {
        ok: false,
        dir,
        candidates: files,
        reason: `config/ 里没有 onebot_${wanted}.json（有的是：${files.join('、')}）`,
      };
    }
  } else if (files.length === 1) {
    file = files[0];
  } else {
    // 好几个号：取最近改过的那个，把候选一起报上去，让人知道选的是谁
    const withTime = files.map((f) => {
      let t = 0;
      try { t = fs.statSync(path.join(cfgDir, f)).mtimeMs; } catch { /* 忽略 */ }
      return { f, t };
    });
    withTime.sort((a, b) => b.t - a.t);
    file = withTime[0].f;
  }

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(cfgDir, file), 'utf8'));
  } catch (err) {
    return { ok: false, dir, candidates: files, reason: `这份配置读不动：${err?.message ?? err}` };
  }

  const http = pickServer(cfg?.networks?.httpServers, 3000);
  const ws = pickServer(cfg?.networks?.wsServers, 3001);
  const guessed = (file.match(/onebot_(\d+)\.json/i) || [])[1] || '';

  return {
    ok: true,
    dir,
    file: path.join(cfgDir, file),
    uin: guessed,
    wsUrl: `ws://${ws.host}:${ws.port}`,
    httpUrl: `http://${http.host}:${http.port}`,
    accessToken: ws.token,
    httpToken: http.token,
    candidates: files,
  };
}
