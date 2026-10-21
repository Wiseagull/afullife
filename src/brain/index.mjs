// 脑子：统一接口 run({ prompt, sessionId }) -> { text, sessionId } | null
// 换实现不影响身体。
//
// 曾经还有两条路：'inject'（往活着的会话注入）和 'home'（插件进程内直接驱动会话）。
// 都是绕开 headless 子进程的实验，定案走 headless 之后就不再被任何配置选中，
// 2026-10-21 连同 plugin/ 那边配套的代码一起删掉了 —— 仓库里没有它们，别去找。
import { HeadlessBrain } from './headless.mjs';

export function createBrain(cfg, logger) {
  const kind = cfg.brain?.kind || 'none';

  if (kind === 'none') {
    return {
      kind,
      async run() { return null; },
    };
  }
  if (kind === 'headless') return new HeadlessBrain({ ...cfg.brain.headless, logger });

  throw new Error(`未知的 brain.kind: ${kind}（只支持 none / headless）`);
}
