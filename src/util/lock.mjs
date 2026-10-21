// 一个进程锁：同一个 data 目录只许起一个桥。
// 不然两个桥同时连着 SnowLuma，同一句话会被回两遍。
import fs from 'node:fs';
import path from 'node:path';

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * @param {string} file pid 文件路径
 * @returns {{ok:true, release:()=>void} | {ok:false, pid:number|null}}
 */
export function acquireLock(file, { heartbeatFile = null, staleMs = 120000 } = {}) {
  try {
    const old = Number(String(fs.readFileSync(file, 'utf8')).trim());
    if (old && old !== process.pid && alive(old)) {
      // 进程还在，但心跳停了 —— 它卡死了（停不下来又占着锁），当僵尸处理
      let stale = false;
      if (heartbeatFile) {
        try {
          stale = Date.now() - fs.statSync(heartbeatFile).mtimeMs > staleMs;
        } catch {
          stale = true;           // 从来没写过心跳 = 不是新版本的桥
        }
      }
      if (!stale) return { ok: false, pid: old };
    }
  } catch { /* 文件不存在，正常 */ }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(process.pid), 'utf8');

  const release = () => {
    try {
      const now = Number(String(fs.readFileSync(file, 'utf8')).trim());
      if (now === process.pid) fs.unlinkSync(file);
    } catch { /* ignore */ }
  };
  return { ok: true, release };
}
