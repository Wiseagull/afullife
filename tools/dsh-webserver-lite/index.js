// dsh-webserver-lite —— 最小 webServer 服务。
//
// 为什么需要它：DSH 桌面版自带 webServer（页面要它服务），但 headless profile 里没有。
// dsh-image-gen 声明了 inject: [credentials, webServer]，缺一个就一直 pending，
// 工具也就永远长不出来。这里补一个够用的实现：监听 127.0.0.1 的随机端口，
// 实现 register({kind, path, handler}) 这一套，别的什么都不做。
//
// 安全性：只 bind 127.0.0.1；没有鉴权，因为 headless 没有浏览器会来敲它，
// 真被本机程序敲到也只能拿到插件自己注册的路由（图片二进制、健康检查之类）。
//
// 注意：这里所有字段都用普通属性、不用 #private —— Cordis 的 Service 外面套了一层
// Proxy，私有字段过不去（实测报 "Cannot read private member #routes from an object
// whose class did not declare it"）。

import http from 'node:http';

export const name = 'webserver-lite';
export const inject = [];

const HOST = '127.0.0.1';

class WebServerLite {
  constructor(config = {}) {
    this.routes = [];
    this.server = null;
    this.listenPort = Number(config.port) || 0; // 0 = 让系统挑一个空闲端口
    this.log = typeof config.logger === 'function' ? config.logger : () => {};
    this._start();
  }

  /** 真正在监听的端口（0 表示还没起来） */
  get port() {
    const addr = this.server?.address();
    return addr && typeof addr === 'object' ? addr.port : 0;
  }

  get baseUrl() {
    const p = this.port;
    return p ? `http://${HOST}:${p}` : '';
  }

  /**
   * 插件用这个挂路由。
   * @param {{kind?: 'exact'|'prefix', path: string, handler: (req, res) => unknown}} route
   * @returns {() => void} 卸掉这条路由
   */
  register({ kind = 'exact', path: routePath, handler } = {}) {
    if (typeof handler !== 'function') {
      throw new Error('webserver-lite: handler 必须是函数');
    }
    // 个别插件给的是不带斜杠的裸路径或完整 URL，这里统一成 pathname
    let p = String(routePath ?? '').trim();
    if (/^https?:\/\//i.test(p)) {
      try {
        p = new URL(p).pathname;
      } catch {
        /* 解析不了就按原样 */
      }
    }
    if (!p.startsWith('/')) p = '/' + p;

    const route = { kind, path: p, handler };
    this.routes.push(route);
    return () => {
      const i = this.routes.indexOf(route);
      if (i >= 0) this.routes.splice(i, 1);
    };
  }

  _start() {
    this.server = http.createServer((req, res) => {
      let pathname = '/';
      try {
        pathname = new URL(req.url || '/', `http://${HOST}`).pathname;
      } catch {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: 'bad url' }));
      }
      // 精确匹配优先，再试前缀，避免 /api/x 被 /api 抢走
      const exact = this.routes.find((r) => r.kind !== 'prefix' && r.path === pathname);
      const route = exact || this.routes.find((r) => r.kind === 'prefix' && pathname.startsWith(r.path));
      if (!route) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: 'no route', path: pathname }));
      }
      try {
        return route.handler(req, res);
      } catch (err) {
        this.log('[webserver-lite] 路由出错', route.path, err?.message || err);
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        if (!res.writableEnded) res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
        return undefined;
      }
    });

    this.server.on('error', (err) => {
      this.log('[webserver-lite] 监听失败', err?.message || err);
    });

    this.server.listen(this.listenPort, HOST, () => {
      this.log(`[webserver-lite] 已监听 ${this.baseUrl}`);
    });
    // 别让这个 server 拖住进程退出
    this.server.unref?.();
  }

  _stop() {
    try {
      this.server?.close();
    } catch {
      /* 已经关了就算了 */
    }
    this.server = null;
    this.routes = [];
  }
}

export function apply(ctx, config = {}) {
  const service = new WebServerLite(config);
  // 不依赖 @deepseek-ai/cordis：profile 的 node_modules 里解析不到它，
  // import 一失败整个插件就挂，webServer 服务永远不出现，image-gen 就一直 pending。
  const dispose = ctx.reflect.provide('webServer', service);
  ctx.effect(() => () => {
    dispose();
    service._stop();
  }, 'webserver-lite: 关闭监听');
}
