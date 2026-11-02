// 现在跑着的桥，是不是最新那份代码？
//
// 2026-11-01 栽了三回：改完代码、自检全绿，就说"好了"，然后忘了桥还开着开机时那份。
// 最典型的是 13:09 把表情库的宽限期从 6 小时改成 24 小时，13:16 才发现它还没生效。
// 这件事没有报错、没有日志、也没有任何人会提醒——只差一个"谁比谁新"的比较。
// 这个脚本就做这一件事：拿日志里最后一次"桥已启动"的时间，去比 src/、plugin/ 下每个文件的
// 修改时间；比它新的，就是没被这个进程读进去的。
//
// 用法：
//   node scripts/probe-stale.mjs            看现在跑的这份是不是最新的
//   node scripts/probe-stale.mjs --json     给机器读
//   node scripts/probe-stale.mjs --log=<路径>   用别的日志（默认 data/logs/dsh-supervisor.log）
//   node scripts/probe-stale.mjs --since="2026-11-01 20:14:50"  日志里查不到时手动钉一个时刻
//
// 退出码：0 = 没有比桥更新的文件；1 = 有（跑的是旧代码）；2 = 判不了（日志里没有启动记录、或者 pid 已不在）。
// 判不了的时候不返回 0——"没查成"和"查过没事"不能长得一样。
//
// 自检（selftest）全绿之后会自动调一次；桥真的比 src/ 旧、而且那个进程还活着，
// 就在最后多印一句「这份还没生效」。不算失败项，也不改退出码。

import fs from 'node:fs';
import path from 'node:path';

// 判据（哪些文件比某一刻新）和桥自己那个看门人共用一份：两处各写一遍，
// 迟早会一个算得宽一个算得窄，然后各说各的真话。
import { TOLERANCE_MS, walkFiles, staleFrom } from '../src/util/stale-watch.mjs';
export { TOLERANCE_MS, walkFiles, staleFrom };

const ROOT = path.resolve(import.meta.dirname, '..');
const DEFAULT_LOG = path.join(ROOT, 'data', 'logs', 'dsh-supervisor.log');
// 两个目录：src/ 是桥自己的代码，plugin/ 是宿主侧（面板要刷页面，其余要重启 DSH）。
const DIRS = [path.join(ROOT, 'src'), path.join(ROOT, 'plugin')];

// 日志 6MB 往上，只读尾巴：启动记录是"最后一条"，不需要整份。
export function readTail(file, bytes = 512 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const from = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// 启动行长这样：[2026-11-01T12:14:50.312Z] 桥已启动（pid 19320）
// 时间戳是 UTC（带 Z），文件时间是本地的——这里全部转成毫秒再比，别拿眼睛比。
// 取最后一条：日志是追加的，前面的启动记录都早就死了。
export function findStart(text) {
  const re = /^\[([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z)\]\s*桥已启动（pid\s*(\d+)）/gm;
  let last = null;
  for (const m of text.matchAll(re)) last = { at: Date.parse(m[1]), pid: Number(m[2]) };
  return last;
}

function alive(pid) {
  try {
    process.kill(pid, 0); // 只探活，不发信号
    return true;
  } catch (e) {
    return e?.code === 'EPERM'; // 活着但不让我们碰，也算活着
  }
}

// 判一次，返回结构化的结果；main() 只负责把它印出来。
// selftest 也调这个——自检跑完那一刻，正是我最容易说"好了"的那一刻，
// 让它自己先答一句"这份还没生效"，比多一道人工步骤靠得住。
// 出错不抛：调用方（自检）不该被一个探针带崩，errors 里带一句原因就好。
export function assess(logPath = DEFAULT_LOG, sinceArg = null) {
  try {
    let start = null;
    if (sinceArg) {
      const at = Date.parse(String(sinceArg).replace(' ', 'T'));
      if (Number.isNaN(at)) return { verdict: 'unknown', reason: `--since="${sinceArg}" 我读不成时间，照 "2026-11-01 20:14:50" 这种写法给` };
      start = { at, pid: null };
    }
    if (!start) {
      if (!fs.existsSync(logPath)) {
        return { verdict: 'unknown', reason: `没有日志：${logPath}。换一份，或者用 --since 手动钉时刻` };
      }
      start = findStart(readTail(logPath));
      if (!start) {
        return { verdict: 'unknown', reason: `日志尾巴里找不到"桥已启动"（${logPath}）。桥可能还没起，或者日志被轮转过——用 --since 手动钉时刻` };
      }
    }
    const files = DIRS.flatMap((d) => { try { return walkFiles(d); } catch { return []; } });
    const stale = staleFrom(DIRS, start.at);
    const pidAlive = start.pid ? alive(start.pid) : null;
    // pid 已经不在：日志里那条启动记录指的是一个死掉的进程，"现在跑着的这份"是谁就不知道了。
    // 这种情况必须单独说，不能混进 fresh 或 stale。
    const verdict = pidAlive === false ? 'unknown' : stale.length ? 'stale' : 'fresh';
    return { verdict, pid: start.pid, pidAlive, startedAt: start.at, scanned: files.length, stale };
  } catch (e) {
    return { verdict: 'unknown', reason: `探针自己出错了：${e?.message || e}` };
  }
}

function usage() {
  // 按标记取，不数行号：行号一挪（今天挪过一次），用法就印成半截代码。
  const lines = fs.readFileSync(import.meta.filename, 'utf8').split('\n');
  const from = lines.findIndex((l) => l.startsWith('// 用法：'));
  const out = [];
  for (let i = from; i >= 0 && i < lines.length && lines[i].startsWith('//'); i += 1) {
    out.push(lines[i].replace(/^\/\/ ?/, ''));
  }
  return out.join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(usage());
    return 0;
  }

  const wantJson = argv.includes('--json');
  const logPath = (argv.find((a) => a.startsWith('--log=')) || `--log=${DEFAULT_LOG}`).slice(6);
  const sinceArg = argv.find((a) => a.startsWith('--since='))?.slice(8);

  const r = assess(logPath, sinceArg);
  if (r.verdict === 'unknown' && r.reason) {
    console.error(r.reason);
    return 2;
  }

  if (wantJson) {
    console.log(JSON.stringify({
      verdict: r.verdict,
      pid: r.pid,
      pidAlive: r.pidAlive,
      startedAt: new Date(r.startedAt).toISOString(),
      logFile: sinceArg ? null : logPath,
      scanned: r.scanned,
      stale: r.stale.map((x) => ({ file: path.relative(ROOT, x.file), changedAt: new Date(x.mtime).toISOString() })),
    }, null, 2));
  } else {
    const when = new Date(r.startedAt).toLocaleString('zh-CN', { hour12: false });
    console.log(`桥：${r.pid ? `pid ${r.pid}，` : ''}${when} 启动${r.pidAlive === false ? '（这个进程已经不在了）' : r.pidAlive ? '（还活着）' : ''}`);
    console.log(`看的是 src/ + plugin/ 下 ${r.scanned} 个 .mjs/.js`);
    if (r.verdict === 'unknown') {
      console.log('  ? 判不了：日志里那个 pid 不在了，现在跑的是哪一份说不准');
      console.log('    看一眼 data/logs/dsh-supervisor.log 最后一条启动记录，或者直接重启桥再跑一次');
    } else if (r.verdict === 'fresh') {
      console.log('  ✓ 没有比它更新的文件——现在跑的这份就是盘上最新的');
    } else {
      console.log(`  ✗ ${r.stale.length} 个文件在它启动之后改过，这些改动还没进进程：`);
      for (const x of r.stale) {
        console.log(`    ${new Date(x.mtime).toLocaleTimeString('zh-CN', { hour12: false })}  ${path.relative(ROOT, x.file)}`);
      }
      console.log('    重启桥才会生效。别把它们当成已经生效了。');
    }
    console.log('  （看的是修改时间，不是内容：touch 过、或者改完又改回去的，也会被算进上面这份名单）');
  }

  return r.verdict === 'fresh' ? 0 : r.verdict === 'stale' ? 1 : 2;
}

// 自检收尾用的一句话。只在"真的旧了、而且那个进程还活着"时给话——
// 桥没起、或者判不了的时候，说"没生效"是冤枉，说"生效了"是撒谎，所以一句都不说。
// 只读传进来的那份结果，不自己再探一遍：这样它能被自检直接喂一个假结果验，
// 也不会在自检收尾时多花一次读 6MB 日志的钱。
export function staleNote(r) {
  if (!r || r.verdict !== 'stale' || r.pidAlive !== true) return null;
  const list = r.stale.slice(0, 5).map((x) => path.relative(ROOT, x.file)).join('、');
  const more = r.stale.length > 5 ? ` 等 ${r.stale.length} 个` : '';
  return `这份还没生效：桥（pid ${r.pid}）${new Date(r.startedAt).toLocaleTimeString('zh-CN', { hour12: false })} 起的，`
    + `之后改过 ${r.stale.length} 个文件没进进程（${list}${more}）`;
}

// 被 selftest import 的时候不要跑——它借 findStart / staleFrom / assess / staleNote。
if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  process.exit(main());
}
