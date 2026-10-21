// 跟着爹走：DSH 一没，桥也自己收工，别留个孤儿在后台一直听 QQ。
//
// 只认环境变量 QAD_PARENT_PID（插件起桥时写进去的）。手动 `node src/main.mjs`
// 起的桥没有这个变量，就不受它管。
const DEFAULT_INTERVAL = 15000;

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * @param {{pid?: number, intervalMs?: number, onGone: () => void, isAlive?: (pid:number)=>boolean}} opts
 * @returns {() => void} 停止监视
 */
export function watchParent({ pid, intervalMs = DEFAULT_INTERVAL, onGone, isAlive = alive } = {}) {
  const parent = Number(pid) || 0;
  if (!parent || typeof onGone !== 'function') return () => {};

  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    if (!isAlive(parent)) {
      stopped = true;
      clearInterval(timer);
      onGone();
    }
  }, intervalMs);

  if (typeof timer.unref === 'function') timer.unref();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
