// Host 侧：在 DSH 自己的 web 服务上挂一条 /qad 前缀路由，转发到桥的本地接口。
//
// 为什么要这道转发：面板跑在 DSH 页面里，直接 fetch 别的端口会被页面的
// CSP（connect-src）挡掉，浏览器只报一句 `Failed to fetch`。走同源就没有
// 跨端口这回事——面板请求 /qad/...，宿主这边替它去敲 127.0.0.1:3220。
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBridge, stopBridge, stopBridgeHard, waitBridgeUp } from './supervisor.js';
import { readToken, TOKEN_HEADER } from '../src/web/token.mjs';

export const name = 'afullife-panel';
export const inject = ['webServer'];

// 桥的端口跟着项目的配置走（web.port），不写死 —— 别人改了端口面板也得跟得上
const PROJECT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function bridgePort() {
  for (const name of ['config.local.json', 'config.example.json']) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, name), 'utf8'));
      const port = Number(cfg?.web?.port);
      if (Number.isFinite(port) && port > 0) return port;
    } catch { /* 这个文件没有或读不动，试下一个 */ }
  }
  return 3220;
}
const UPSTREAM = `http://127.0.0.1:${bridgePort()}`;

let bridge = null; // 插件热重载时会再 apply 一次，别起第二只

export function apply(ctx) {
  // 桥跟着 DSH 起落：DSH 开着，桥就该在
  if (!bridge) bridge = startBridge();
  const handle = bridge;
  ctx.effect(() => () => { stopBridge(handle); bridge = null; }, 'qad: 桥随 DSH 起落');

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: '/qad',
        handler: async (req, res) => {
          const url = new URL(req.url, 'http://127.0.0.1');
          const target = UPSTREAM + url.pathname.replace(/^\/qad/, '') + url.search;

          const chunks = [];
          for await (const c of req) chunks.push(c);

          // 面板上的「重启桥」：杀掉当前这只，再起一只新的。不走转发。
          if (url.pathname === '/qad/api/restart' && req.method === 'POST') {
            const t0 = Date.now();
            try {
              await stopBridgeHard(bridge);
              bridge = startBridge({ force: true });
              // 起完不等于成了：旧的还占着锁时新桥会 exit(1)，而这里什么都不做的话
              // 面板照样显示「重启成功」。等几秒确认它还活着再回话。
              const up = await waitBridgeUp(bridge);
              if (!up) throw new Error('新桥起来又退了（多半旧的还占着 lock），看 data/logs 里的日志');
              const pid = bridge?.child?.pid ?? bridge?.adoptedPid ?? null;
              const t = JSON.stringify({ ok: true, pid, ms: Date.now() - t0 });
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(t), 'cache-control': 'no-store' });
              return res.end(t);
            } catch (err) {
              const t = JSON.stringify({ error: '重启失败：' + (err?.message ?? err) });
              res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(t) });
              return res.end(t);
            }
          }

          try {
            const upstream = await fetch(target, {
              method: req.method,
              headers: {
                'x-qad-ui': '1',
                // 桥要令牌（见 src/web/token.mjs）。每次现读：桥可能是刚起来才写的。
                [TOKEN_HEADER]: readToken(path.join(PROJECT_DIR, 'data')),
                'content-type': req.headers['content-type'] || 'application/json',
              },
              body: chunks.length ? Buffer.concat(chunks) : undefined,
            });
            const text = await upstream.text();
            res.writeHead(upstream.status, {
              'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
              'content-length': Buffer.byteLength(text),
              'cache-control': 'no-store',
            });
            res.end(text);
          } catch (err) {
            const text = JSON.stringify({
              error: '桥没开（' + UPSTREAM + '）：' + (err && err.message ? err.message : String(err)),
            });
            res.writeHead(503, {
              'content-type': 'application/json; charset=utf-8',
              'content-length': Buffer.byteLength(text),
            });
            res.end(text);
          }
        },
      }),
    'qad-panel: /qad 转发到桥',
  );
}
