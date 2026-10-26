// 接法 B：为一条消息起一次 DSH 运行，拿回它的回答。
//
// 已实测通过（2026-10-20）：
//   ELECTRON_RUN_AS_NODE=1 "<DSH 安装目录>\DeepSeek Harness.exe" ^
//     "<DSH 安装目录>\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js>" ^
//     headless "只回复两个字：在的"          → 3.3 秒，打印「在的」
//     headless --session-id <id> "刚才的暗号是什么"  → 答出上一轮记的暗号
//
// 要点：
//  · 用 Electron 的可执行文件跑 asar 里的 CLI（--run-as-node 走纯 node 模式，能读 asar）。
//  · 必须给 DEEPSEEK_API_KEY，否则报 MISSING_CREDENTIAL；本机密钥在 ~/.dsh/.credentials.yaml。
//  · cwd 决定它加载哪个工作区的 AGENTS.md —— 人格就是这么带进来的。
//  · --json 吐 NDJSON 事件，第一行就能拿到 sessionId，用它换下一轮的 --session-id。
//  · 任务文本走 stdin（参数写 `-`），省得为引号、换行和长度操心。
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ROOT } from '../config.mjs';
import { writeModelPatch, providerEnv, readDshProviders } from './model.mjs';

/**
 * 默认从"正在跑我自己的这个进程"推：
 * 桥是被 DSH 用 `ELECTRON_RUN_AS_NODE=1 <DeepSeek Harness.exe>` 拉起来的，
 * 所以 process.execPath 就是 DSH 本体，CLI 在它旁边的 app.asar 里。
 * 推不出来就请用户填 brain.headless.node / cli（README 第 3 步有说明）。
 */
function guessDsh() {
  const exe = process.execPath || '';
  const dir = exe ? path.dirname(exe) : '';
  const cli = dir
    ? path.join(dir, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    : '';
  return { node: exe, cli: fs.existsSync(cli) ? cli : '' };
}
const GUESS = guessDsh();

/**
 * 退出码非 0，但这一轮其实成了——final 已经交完，只是收尾（关 MCP server、拆子进程树）崩了。
 *
 * 判据是两条独立证据，缺一条就算失败：
 *   1. final 事件到过。不管里面有没有字——模型什么都没说，也是把话说完了。
 *   2. stdout 里一个 error 事件都没有。
 *
 * 退出码本身不进判据：它记的是"进程怎么退的"，不是"这一轮有没有结果"。
 *
 * 为什么要有这条：2026-10-24 光 upkeep/distill 就因此白丢五轮，日志里只剩一句
 * 「windows-computer-use MCP server 0.2.5 ready」，看不出所以然。2026-10-25 09:14
 * 体检那次是 7 条事件、最后一条 final、没有 error、stderr 只有 MCP 启动横幅，唯一
 * 不对的是 final 里一个字都没有——那是模型没说话，不是子进程崩了，按空回复交回去
 * 比记一次失败诚实。
 *
 * 用 sawFinal 而不是"最后一条事件是不是 final"：后者会被 final 之后任何一条事件
 * （比如带 usage 的 status）顶掉，于是本该放行的又按失败走。
 */
export function finishedDespiteExit({ sawFinal = false, errors = [] } = {}) {
  if (sawFinal !== true) return false;
  // 脏数据当失败：宁可多记一次失败，也不能拿一个不是数组的东西当作"没有 error"。
  if (!Array.isArray(errors)) return false;
  return errors.length === 0;
}

const DEFAULTS = {
  node: GUESS.node,
  cli: GUESS.cli,
  profile: 'headless',
  // 用哪个模型：{ provider, model }。空就用 profile 自己的默认（agent-default-model）。
  // 选了就写一份 patch 用 --patch 叠上去，见 src/brain/model.mjs 顶上那段。
  model: null,
  // 自己加的提供商（面板「模型」页填的），形状见 src/brain/model.mjs
  providers: {},
  // 默认就在项目自己目录里干活：她画的东西、写的文件都落在这儿，不散到别的工作区
  workspace: ROOT,
  timeoutMs: 120000,
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  credentialsFile: path.join(os.homedir(), '.dsh', '.credentials.yaml'),
  // DSH 的沙箱档位：workspace-write（默认，动不了工作区外）/ danger-full-access
  // 这里给足权限，安全交给桥里的闸——headless 是非交互的，遇到要审批的动作会直接拒
  permissionMode: 'danger-full-access',
};

/** 给别的模块用：这套默认从哪来的（面板要读 profile 默认模型，得知道 node / cli）。 */
export function dshDefaults() {
  return { node: DEFAULTS.node, cli: DEFAULTS.cli, profile: DEFAULTS.profile };
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

// 撞到墙钟上限时，如果这一轮几十秒内还在出事件，就再给一小段宽限。
//
// 起因是 2026-10-26 16:16:00 那一拍：笔记 16:15:59 刚落盘，差一秒收尾，
// 却被按「超时」整轮扔掉。撞墙≠卡死，判据得分开：还在出事件说明它在干活，
// 卡死的（事件早停了）一秒都不宽限。宽限只给一次，不然墙就是假的。
const TIMEOUT_GRACE_MS = 60_000;
// 多久之内有过事件算「还在动」。比宽限还长就没意义了，所以同一个数。
const FRESH_MS = TIMEOUT_GRACE_MS;

/** 连子进程一起杀：Windows 下  只杀爹。 */
function killTree(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === 'win32' && child.pid) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      child.kill('SIGKILL');
    }
  } catch { /* ignore */ }
}

export class HeadlessBrain {
  constructor(opts = {}) {
    this.cfg = { ...DEFAULTS, ...opts };
    this.logger = opts.logger || null;
    this.running = 0;
  }

  get kind() { return 'headless'; }

  /**
   * 面板里改了 brain.headless.*（模型、provider、cli、超时…）之后原地换掉。
   * 为什么需要：构造时是把配置**展开拷进来**的（`{...DEFAULTS, ...opts}`），
   * 面板改完只动 cfg 里那份，这个副本不动，于是「模型」页改了要重启才认（2026-10-23 踩过）。
   * 只补传进来的键，别的（默认值、logger）留着。
   */
  reconfigure(next = {}) {
    Object.assign(this.cfg, next);
    return this.cfg;
  }

  #apiKey() {
    const name = this.cfg.apiKeyEnv;
    if (process.env[name]) return process.env[name];
    const file = this.cfg.credentialsFile;
    if (!file || !fs.existsSync(file)) return '';
    try {
      const text = fs.readFileSync(file, 'utf8');
      const m = text.match(new RegExp(`^\\s*${name}:\\s*(\\S+)\\s*$`, 'm'));
      return m ? m[1] : '';
    } catch {
      return '';
    }
  }

  /**
   * @param {{prompt: string, sessionId?: string|null, onEvent?: (ev:object)=>('abort'|void)}} input
   *   onEvent 每收到一个 NDJSON 事件就同步调一次；返回 'abort' 就当场掐断这一轮。
   * @returns {Promise<{text: string, sessionId: string|null}>}
   */
  async run({ prompt, sessionId = null, onEvent = null, profile = null, model = null }) {
    const key = this.#apiKey();
    if (!key) {
      throw new Error(`找不到 ${this.cfg.apiKeyEnv}：环境变量没有，${this.cfg.credentialsFile} 里也没有`);
    }

    if (!this.cfg.cli || !fs.existsSync(this.cfg.cli)) {
      throw new Error(
        '找不到 DSH 的命令行入口：在 config.local.json 里填 brain.headless.cli'
        + '（形如 <DSH 安装目录>/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js），'
        + 'node 填 <DSH 安装目录>/DeepSeek Harness.exe',
      );
    }
    // 按轮换 profile：闲聊用轻的那套（工具少，每步省两万 token），要动手才用全量
    const args = [this.cfg.cli];
    // 指定了模型就先叠一层 patch。注意：带 --patch 时 profile 必须用 --profile 显式给，
    // 写成位置参数（dsh --patch x headless）会被拒：--profile <name> is required。
    // 面板里加的自定义提供商也算在同一份 patch 里（它们的 key 走环境变量，不进 DSH 凭据）
    // 提供商三路合起来：下载者本机 DSH 里已有的（desktop 里加的中转站）+ 面板里自己加的
    const providers = { ...readDshProviders(), ...(this.cfg.providers || {}) };
    const extraEnv = providerEnv(providers);
    // 这一轮用哪个模型：调用方传了就用传的（决策/看图各有专属模型），没传用配置里的。
    const pick = (m) => (m && String(m.provider || '').trim() && String(m.model || '').trim() ? m : null);
    const override = pick(model);
    const fallback = pick(this.cfg.model);
    const chosen = override || fallback;
    // 三份 patch 互不覆盖：对话用固定的那份，决策/看图按 (provider/model) 各占一个文件。
    // 不能只写一份——同时跑的两轮会互相改掉对方的模型。
    const sameAsDefault = !override
      || !fallback
      || (override.provider === fallback.provider && override.model === fallback.model);
    const fileName = sameAsDefault
      ? 'model-patch.yml'
      : `model-patch-${crypto.createHash('sha1').update(`${chosen.provider}/${chosen.model}`).digest('hex').slice(0, 8)}.yml`;
    const patch = writeModelPatch(path.join(ROOT, 'data'), {
      ...(chosen || {}),
      providers,
    }, fileName);
    const prof = profile || this.cfg.profile;
    if (patch) args.push('--patch', patch, '--profile', prof, '--json');
    else args.push(prof, '--json');
    if (sessionId) args.push('--session-id', sessionId);
    args.push('-');

    this.running += 1;
    const startedAt = Date.now();
    try {
      const result = await this.#spawn(args, String(prompt ?? ''), key, onEvent, extraEnv);
      // 退出码非 0 但 final 已到的那轮：结果照用，但得在日志里留一行，别让它悄悄过去
      if (result.exitWarn) this.logger?.('brain', result.exitWarn);
      this.logger?.(
        'brain',
        `headless ${Date.now() - startedAt}ms，${result.text.length} 字，session=${result.sessionId || '?'}`
        + (chosen ? `，模型 ${chosen.provider}/${chosen.model}` : '')
      );
      return result;
    } finally {
      this.running -= 1;
    }
  }

  #spawn(args, prompt, key, onEvent = null, extraEnv = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.cfg.node, args, {
        cwd: this.cfg.workspace,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          DSH_PERMISSION_MODE: this.cfg.permissionMode,
          [this.cfg.apiKeyEnv]: key,
          ...extraEnv,
        },
      });

      let buf = '';
      let err = '';
      let settled = false;
      let sessionId = null;
      let finalText = '';
      let streamed = '';
      const errors = [];
      // 一轮用掉多少 token：DSH 在 status 事件里带 usage（一步一条，这里累加）。
      // inputTokens 是新喂进去的，cacheReadTokens 是命中缓存的那部分（便宜得多）。
      const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };
      let usageSeen = false;
      // 一步 = 模型看一遍上下文再决定下一步。步数用来算“每步上下文多大”，
      // 那个数才是真正决定单轮成本的东西（会话越长它越大）。
      let steps = 0;
      // 超时的时候要知道卡在哪儿：最后一次事件是什么、多久之前、一共收到多少字节。
      // 只在超时那条错误里出现，正常路径不受影响。
      let lastEventAt = Date.now();
      let lastEventKind = '';
      // final 到过没有。判「退出码非 0 但这一轮成了」要用它——不能拿 lastEventKind 判，
      // 那条会被 final 之后任何事件顶掉。
      let sawFinal = false;
      let eventCount = 0;
      let stdoutBytes = 0;

      let timer = null;
      let graced = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        fn(value);
      };

      // 宽限可以配：自测要把它设小，不然一个 1.2 秒的超时会被宽限拖到一分钟，
      // 假 cli 自己先退了，超时根本没发生。
      const graceMs = Number(this.cfg.graceMs ?? TIMEOUT_GRACE_MS);
      const deadline = () => {
        const stall = Date.now() - lastEventAt;
        // 还在出事件：再给一次宽限，到点照杀。只给一次——不然上限就不是上限了。
        if (graceMs > 0 && !graced && eventCount > 0 && stall <= FRESH_MS) {
          graced = true;
          this.logger?.('brain', `这一轮撞到 ${Math.round(this.cfg.timeoutMs / 1000)}s 上限，但最后一条事件只在 ${Math.round(stall / 1000)}s 前（还在干活，不是卡死），再给 ${Math.round(graceMs / 1000)}s 收尾`);
          timer = setTimeout(deadline, graceMs);
          return;
        }
        // 连子进程树一起掐：它可能拉起了 SD 这种大程序，只杀爹会剩孤儿占着端口
        killTree(child);
        const where = lastEventKind
          ? `最后一条事件 ${lastEventKind} 在 ${Math.round(stall / 1000)}s 前，共 ${eventCount} 条 / ${Math.round(stdoutBytes / 1024)}KB`
          : `一条事件都没收到（0KB），卡在起进程或读 prompt 那一步`;
        const e = new Error(`headless 超时（${this.cfg.timeoutMs}ms，${where}）`);
        // 让调用方凭字段分清「卡死了」和「一直在干活、只是这一拍太长」，别去解析文案。
        e.code = 'HEADLESS_TIMEOUT';
        e.stallMs = stall;
        e.eventCount = eventCount;
        finish(reject, e);
      };

      timer = setTimeout(deadline, this.cfg.timeoutMs);

      const handleLine = (line) => {
        const s = line.trim();
        if (!s) return;
        let ev;
        try { ev = JSON.parse(s); } catch { return; }
        lastEventAt = Date.now();
        lastEventKind = String(ev.type || '?');
        eventCount += 1;
        if (ev.type === 'session' && ev.sessionId) sessionId = String(ev.sessionId);
        else if (ev.type === 'final') {
          sawFinal = true;
          if (typeof ev.text === 'string') finalText = ev.text;
        }
        else if (ev.type === 'text' && typeof ev.text === 'string') streamed += ev.text;
        else if (ev.type === 'status' && ev.usage) {
          usageSeen = true;
          steps += 1;
          for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens']) {
            const n = Number(ev.usage[k]);
            if (Number.isFinite(n)) usage[k] += n;
          }
        }
        else if (ev.type === 'error') errors.push(String(ev.message || ev.error || JSON.stringify(ev)));

        // 闸挂在这里：看到 tool_call 当场判，红了就掐。
        if (onEvent && !settled) {
          let r;
          try { r = onEvent(ev); } catch (e) { errors.push(String(e?.message || e)); }
          if (r === 'abort') {
            try { child.kill(); } catch { /* ignore */ }
            const e = new Error('gate-blocked');
            e.code = 'GATE_BLOCKED';
            e.gate = ev;
            finish(reject, e);
          }
        }
      };

      child.stdout.on('data', (b) => {
        stdoutBytes += b.length;
        buf += b.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          handleLine(line);
        }
      });
      child.stderr.on('data', (b) => { err += b.toString('utf8'); });

      child.on('error', (e) => finish(reject, new Error(`起不来：${e?.message ?? e}`)));

      child.on('close', (code) => {
        if (buf.trim()) handleLine(buf);
        const text = (finalText || streamed).replace(ANSI, '').trim();
        if (code !== 0) {
          // 判据在 finishedDespiteExit 上：final 到过 + 一个 error 事件都没有，两条都占才算成。
          // 退出码仍带出去（exitWarn），由调用方记一笔；缺一条就还按失败走。
          if (finishedDespiteExit({ sawFinal, errors })) {
            finish(resolve, {
              text,
              sessionId,
              usage: usageSeen ? usage : null,
              steps: usageSeen ? steps : 0,
              exitWarn: text
                ? `headless 退出码 ${code}（final 已到，按成功处理）`
                : `headless 退出码 ${code}（final 为空，按空回复处理）`,
            });
            return;
          }
          // 退出码非 0 时以前只报 stderr 的尾巴，可那里多半是宿主自己的启动横幅
          // （「windows-computer-use MCP server 0.2.5 ready」这种），真正的原因在 stdout 的
          // error 事件里，被丢掉了——11 次体检失败因此一直只有一个看不出所以然的 MCP 行。
          // 现在两边都报：先 stdout 的 error，再 stderr 去掉横幅后剩下的，最后补一句事件计数。
          const fromStdout = errors.join('; ').replace(ANSI, '').trim();
          const noise = /MCP server .*ready/i;
          const errLines = err.replace(ANSI, '').trim().split('\n').map((s) => s.trim());
          const meaningful = errLines.filter((s) => s && !noise.test(s));
          const fromStderr = (meaningful.length ? meaningful : errLines).join(' ').slice(-400);
          const seen = `${eventCount} 条事件，最后 ${lastEventKind || '无'}`;
          const detail = [fromStdout, fromStderr].filter(Boolean).join(' | ');
          finish(reject, new Error(`headless 退出码 ${code}：${((detail || '无输出') + `（${seen}）`).slice(-700)}`));
          return;
        }
        if (errors.length && !text) {
          finish(reject, new Error(`headless 报错：${errors.join('; ').slice(-400)}`));
          return;
        }
        finish(resolve, { text, sessionId, usage: usageSeen ? usage : null, steps: usageSeen ? steps : 0 });
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });
  }
}
