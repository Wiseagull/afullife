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
    const until = Date.now() + 4000;
    while (pidAlive(pid) && Date.now() < until) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
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
export async function stopBridgeHard(handle, { gracefulMs = 4000 } = {}) {
  const pid = handle?.child?.pid ?? readPid();
  if (!pid) return true;
  if (handle?.child && !handle.child.killed) {
    try { handle.child.kill(); } catch { /* 已经没了 */ }
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = Date.now() + gracefulMs;
  while (pidAlive(pid) && Date.now() < until) await sleep(200);
  if (pidAlive(pid)) {
    note(`优雅停没停住（pid ${pid}），强杀`);
    kill(pid);
    const hard = Date.now() + 2500;
    while (pidAlive(pid) && Date.now() < hard) await sleep(150);
  }
  try { fs.unlinkSync(PID_FILE); } catch { /* 没有就算了 */ }
  note(`桥已停（pid ${pid}${pidAlive(pid) ? '，仍然活着？！' : ''}）`);
  return !pidAlive(pid);
}
