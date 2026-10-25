// 让桥跟着 DSH 一起起、一起走。
//
// DSH 是 Electron，主进程里 `process.execPath` 就是 DeepSeek Harness.exe；
// 带上 ELECTRON_RUN_AS_NODE=1 它就是一个干净的 node，不用另找解释器。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 这个文件在 <项目根>/plugin/ 里，往上一层就是项目根 —— 换台电脑、换个目录照样能用
const BRIDGE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PID_FILE = path.join(BRIDGE_DIR, 'data', 'bridge.pid');
const OWNER_FILE = path.join(BRIDGE_DIR, 'data', 'bridge.owner');
const LOG_FILE = path.join(BRIDGE_DIR, 'data', 'logs', 'dsh-supervisor.log');

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readPid() {
  try { return Number(fs.readFileSync(PID_FILE, 'utf8').trim()) || 0; } catch { return 0; }
}

function readOwner() {
  try { return Number(fs.readFileSync(OWNER_FILE, 'utf8').trim()) || 0; } catch { return 0; }
}

function kill(pid) {
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true });
    return true;
  } catch { return false; }
}

/**
 * 连子进程一起杀。
 *
 * 桥是 Electron 二进制带的 node，直接 /F 偶尔只杀掉外层、里面的 DSH 会话
 * 还挂着端口（3220 就是这么被老进程占住的）。/T 会顺着进程树一起收。
 */
function killTree(pid) {
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    return true;
  } catch { return false; }
}

function note(line) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
  } catch { /* 记不下就算了 */ }
}

/**
 * 起桥。已经在跑（pid 文件里的进程还活着）就不重复起，只是接管观察。
 * @param {{force?: boolean}} [opts] force = 不管 pid 文件说什么，先清干净再起
 * @returns {{child?: import('node:child_process').ChildProcess, adoptedPid?: number}}
 */
export function startBridge(opts = {}) {
  const pid = readPid();
  if (opts.force && pidAlive(pid)) {
    note(`强制重启：先清掉 pid ${pid}`);
    kill(pid);
    // 这里是同步函数，阻塞多久 DSH 的 web 就卡多久——所以只等 4 秒。
    // 真正该等的活在 stopBridgeHard 里（异步，12 秒），走到这儿正常早就清干净了。
    const until = Date.now() + 4000;
    while (pidAlive(pid) && Date.now() < until) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
    if (pidAlive(pid)) {
      note(`强制重启：pid ${pid} 等了几秒还没退，强杀整棵进程树`);
      killTree(pid);
      const hard = Date.now() + 4000;
      while (pidAlive(pid) && Date.now() < hard) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
      }
    }
  } else if (pidAlive(pid)) {
    const owner = readOwner();
    if (owner === process.pid) {
      note(`桥已经在跑（pid ${pid}），不重复启动`);
      return { adoptedPid: pid };
    }
    // 上一代 DSH 留下的桥：它自己也快收工了，但别等——先清掉再起新的
    note(`发现上一代的桥（pid ${pid}，归 ${owner || '?'} 管），先清掉`);
    kill(pid);
    const until = Date.now() + 3000;
    while (pidAlive(pid) && Date.now() < until) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    }
  }

  let fd = 'ignore';
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fd = fs.openSync(LOG_FILE, 'a');
  } catch { /* 打不开日志就丢到 null */ }

  const child = spawn(process.execPath, ['src/main.mjs'], {
    cwd: BRIDGE_DIR,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      // 桥靠这个盯着 DSH：DSH 一没，它自己也退出
      QAD_PARENT_PID: String(process.pid),
    },
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  });

  note(`桥已启动（pid ${child.pid}）`);

  child.on('exit', (code, sig) => {
    note(`桥退出（code=${code} signal=${sig || '-'}）`);
  });
  child.on('error', (err) => {
    note(`桥启动失败：${err?.message ?? err}`);
  });

  return { child };
}

/** DSH 退出时把桥一起带走（只带走自己起的；别人起的不动） */
export function stopBridge(handle) {
  if (!handle?.child || handle.child.killed) return;
  try {
    handle.child.kill();
    note('DSH 关闭，桥已停');
  } catch (err) {
    note(`停桥失败：${err?.message ?? err}`);
  }
}

/**
 * 停桥，且**等它真的没了**。面板上那个「重启桥」用它：
 * 只是 kill() 完就立刻 startBridge，pid 文件还没来得及被清，
 * 新进程会以为"已经有一只"直接退出——桥就这么停在半路了。
 */
export async function stopBridgeHard(handle, { gracefulMs = 12000 } = {}) {
  // 这里等的不是「kill 发出去了」，是「它真的没了」。桥收到 SIGTERM 后要等后台队列
  // 收尾（src/main.mjs 给了 8 秒上限），原来只等 4 秒——2026-10-25 15:02 面板上
  // 「重启桥」就卡在这：旧桥还在，新桥抢锁失败 exit(1)，UI 却显示成功。
  //
  // 另外 handle 里的 pid 可能早就死了（DSH 热重载换过一代），这时要回退到 pid 文件，
  // 否则会对着一个死 pid「等它退出」，真正在跑的那只一个字节都没动。
  const fromChild = handle?.child?.pid;
  const fromAdopt = handle?.adoptedPid;
  const pid = (fromChild && pidAlive(fromChild)) ? fromChild
    : (fromAdopt && pidAlive(fromAdopt)) ? fromAdopt
      : readPid();
  if (!pid) return true;
  if (handle?.child && !handle.child.killed) {
    try { handle.child.kill(); } catch { /* 已经没了 */ }
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = Date.now() + gracefulMs;
  while (pidAlive(pid) && Date.now() < until) await sleep(200);
  if (pidAlive(pid)) {
    note(`优雅停没停住（pid ${pid}），强杀整棵进程树`);
    killTree(pid);
    const hard = Date.now() + 4000;
    while (pidAlive(pid) && Date.now() < hard) await sleep(150);
  }
  // 关键：杀不掉的时候**别清 pid 文件**。
  // 清了它，新起的那只就以为自己是唯一一只，照常连上 QQ —— 于是两只桥
  // 同时在线，同一句回两遍（2026-10-23 早上就这么撞过一次）。
  // 留着 pid 文件，新桥看到 "已经有一个在跑（pid …）" 会自己退出，至少只有一只。
  if (pidAlive(pid)) {
    note(`停不掉（pid ${pid}），pid 文件留着不让第二只起来`);
    throw new Error(`停不掉旧的桥（pid ${pid}）：先别重启，否则会变成两只一起回话`);
  }
  try { fs.unlinkSync(PID_FILE); } catch { /* 没有就算了 */ }
  note(`桥已停（pid ${pid}）`);
  return true;
}

/**
 * 起来之后它是不是**还活着**。面板点「重启」最怕的不是起不来，是
 * 「起来了、一秒内又悄悄退了」——那时 UI 报成功、端口还归旧的那只，
 * 要等到她该说话却没人回才发现。2026-10-25 15:02 就是这样。
 * @returns {Promise<boolean>} true = 到点还活着
 */
export async function waitBridgeUp(handle, ms = 5000) {
  const pid = handle?.child?.pid;
  if (!pid) return !!handle?.adoptedPid;
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!pidAlive(pid)) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
  return pidAlive(pid);
}
