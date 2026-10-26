// 把 SnowLuma 拉起来，最好不要有窗口。
//
// SnowLuma 本身是个本地服务（HTTP 3000 / WS 3001 / WebUI 5099），没有界面；
// 会弹出来的只有 node 的控制台窗口，所以 spawn 时 windowsHide + detached，
// 输出直接写进 data/logs/snowluma.log —— 桌面上一闪都不闪。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.mjs';
import { isPortOpen, portOf, resolveDir } from './runtime.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 已经在跑就不动它；没跑就静默拉起来，等端口通。
 * @returns {Promise<{ok:boolean, started:boolean, dir?:string, error?:string}>}
 */
let inFlight = null;

// 同一时刻只许一个人去拉它：面板按钮和看门狗撞在一起时，
// 两边都看见端口没开，就会各起一个，互相抢端口、死给你看。
export function ensureSnowLuma(opts = {}) {
  if (inFlight) return inFlight;
  inFlight = boot(opts).finally(() => { inFlight = null; });
  return inFlight;
}

async function boot({ cfg, logger = () => {}, timeoutMs = 60000 } = {}) {
  const wsPort = portOf(cfg?.onebot?.wsUrl);
  const httpPort = portOf(cfg?.onebot?.httpUrl, 3000);

  if (await isPortOpen(wsPort)) {
    logger('snowluma', `已经在跑了（ws ${wsPort} 通），不重复启动`);
    return { ok: true, started: false };
  }
  if (cfg?.snowluma?.launch === false) {
    return { ok: false, started: false, error: '配置里关了自动启动（snowluma.launch=false）' };
  }

  // 进程已经在（WebUI 通）却还没开 OneBot 端口，多半是 QQ 还没登录。
  // 这时候再 spawn 一个只会互相抢端口——只等，不重开。
  const webuiUp =
    (await isPortOpen(5099, '127.0.0.1', 400)) || (await isPortOpen(5100, '127.0.0.1', 400));
  if (webuiUp) {
    logger('snowluma', '进程已经在（WebUI 通），OneBot 端口还没开——多半是 QQ 没登录，只等不重开');
    return waitPorts({ wsPort, httpPort, timeoutMs, logger, dir: '' });
  }

  const found = resolveDir(cfg);
  if (!found) {
    return {
      ok: false,
      started: false,
      error: '找不到 SnowLuma：把本体放到 <项目>/vendor/snowluma，或在配置里写 snowluma.dir',
    };
  }

  const { dir, bundled } = found;
  // 优先用它自带的 node.exe（版本对得上），没有就用当前进程的 node
  const ownNode = path.join(dir, 'node.exe');
  const exe = fs.existsSync(ownNode) ? ownNode : process.execPath;

  const logDir = path.join(ROOT, 'data', 'logs');
  fs.mkdirSync(logDir, { recursive: true });

  logger('snowluma', `启动 ${bundled ? '项目自带' : '外部'}的那份：${dir}`);

  // 用 wscript 起：detached + windowsHide 在 Windows 上仍会弹一个 node 控制台，
  // 那个窗口一关，SnowLuma 就跟着死。wscript 的 Run(...,0,...) 根本不建控制台。
  const vbs = path.join(logDir, 'launch-hidden.vbs');
  fs.writeFileSync(
    vbs,
    [
      'Set sh = CreateObject("WScript.Shell")',
      'sh.CurrentDirectory = WScript.Arguments(0)',
      'sh.Run """" & WScript.Arguments(1) & """ """ & WScript.Arguments(2) & """", 0, False',
    ].join('\r\n'),
    'utf8',
  );

  const child = spawn('wscript.exe', ['//B', '//NoLogo', vbs, dir, exe, path.join(dir, 'index.mjs')], {
    cwd: dir,
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  child.on('error', (err) => {
    logger('snowluma', `spawn 失败: ${err.message}`);
  });
  child.unref();

  // wscript 交接完就退出，这是正常的；SnowLuma 自己的日志在它 logs/ 目录里

  return waitPorts({ wsPort, httpPort, timeoutMs, logger, dir, started: true });
}

/** 等 OneBot 两个端口开出来（QQ 登录可能要等一会儿） */
async function waitPorts({ wsPort, httpPort, timeoutMs, logger, dir, started = false }) {
  const deadline = Date.now() + timeoutMs;
  let webuiUp = false;
  while (Date.now() < deadline) {
    // 5099/5100 是它自己的网页。这个通了就说明进程活着，只是 OneBot 还没开。
    if (!webuiUp) {
      webuiUp = (await isPortOpen(5099, '127.0.0.1', 300)) || (await isPortOpen(5100, '127.0.0.1', 300));
    }
    if (await isPortOpen(wsPort)) {
      await sleep(400);
      if (await isPortOpen(httpPort)) {
        logger('snowluma', `起来了（ws ${wsPort} / http ${httpPort}）`);
        return { ok: true, started, dir };
      }
    }
    await sleep(700);
  }
  // 进程活着就算起了：OneBot 端口没开多半只是 QQ 还没登录，再等也不会更早。
  // 报「起来了，但没登录」比报「唤醒失败」实在——后者会让人以为白点了。
  if (webuiUp) {
    logger('snowluma', '进程起来了，但 OneBot 端口还没开——多半 QQ 还没登录');
    return { ok: true, started, dir, note: '起来了，但 QQ 还没登录（OneBot 端口没开）' };
  }
  return {
    ok: false,
    started,
    dir,
    error: '等太久了，端口还没通——看一眼 QQ 有没有登录；SnowLuma 日志在它自己的 logs/ 目录',
  };
}
