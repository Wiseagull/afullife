// 让她在闲下来的时候自己醒一段，不用主人下命令。
//
// 规则很朴素：隔一段随机的时间掷一次，掷到了就开一段。段结束再重新排下一次。
// 开销全在"掷"上，掷不中不发消息、不调模型。
//
// 排期要落盘：桥每重启一次就重掷一遍的话，她一天可以一次都醒不来——
// 开机后接着上次定的时间走，只有真到了才醒。
import fs from 'node:fs';
import path from 'node:path';

export function startAutoFree({ cfg, freeTime, logger, queue, stateFile = null }) {
  const auto = () => cfg.freeTime?.auto || {};
  const log = (msg) => logger?.info?.('free-auto', msg);
  const file = stateFile || path.join(cfg.dataDir || 'data', 'free-auto.json');

  let timer = null;
  let watching = null;
  let stopped = false;

  const readNext = () => {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Number(j?.nextAt) || 0;
    } catch {
      return 0;
    }
  };

  const writeNext = (nextAt) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ nextAt }, null, 2), 'utf8');
      fs.renameSync(tmp, file);
    } catch { /* 写不下就退化成内存排期 */ }
  };

  const delayMs = () => {
    const min = Math.max(60_000, Number(auto().minGapMs ?? 2 * 3600_000));
    const max = Math.max(min + 60_000, Number(auto().maxGapMs ?? 6 * 3600_000));
    return Math.round(min + Math.random() * (max - min));
  };

  const arm = (d, why) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, Math.max(3000, d));
    log(`下一次大约 ${Math.round(d / 60000)} 分钟后（${why || '排期'}）`);
  };

  const schedule = (why) => {
    if (stopped) return;
    const d = delayMs();
    writeNext(Date.now() + d);
    arm(d, why);
  };

  /** 开机：接着上次定的时间；已经过点了就一分钟后醒 */
  const resume = () => {
    if (stopped) return;
    const nextAt = readNext();
    if (!nextAt) return schedule('还没有排过');
    const left = nextAt - Date.now();
    if (left <= 0) {
      log('上次定的时间已经过了，一分钟后就醒');
      return arm(60_000, '补上错过的');
    }
    return arm(left, `接着上次（还剩 ${Math.round(left / 60000)} 分钟）`);
  };

  async function tick() {
    timer = null;
    if (stopped) return;

    if (!auto().enabled) return schedule('总开关关着');
    if (freeTime.status().running) return schedule('上一段还没结束');

    writeNext(0);
    log('自己醒来一段');
    const r = freeTime.start({});
    if (!r.ok) {
      log(`开不了：${r.error}`);
      return schedule('开不了，等会儿再说');
    }
    // 盯着这一段结束，再排下一次
    if (watching) clearInterval(watching);
    watching = setInterval(() => {
      if (!freeTime.status().running) {
        clearInterval(watching);
        watching = null;
        schedule('上一段结束了');
      }
    }, 30_000);
  }

  if (freeTime.status().running) {
    // 重启时正好有一段在跑（其实不会，桥一停它就没了），保险起见别叠
    schedule('启动时检测到正在跑');
  } else {
    resume();
  }

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (watching) clearInterval(watching);
    },
    status() {
      const nextAt = readNext();
      return {
        enabled: !!auto().enabled,
        nextAt,
        inMs: nextAt ? Math.max(0, nextAt - Date.now()) : 0,
      };
    },
  };
}
