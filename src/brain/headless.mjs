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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ROOT } from '../config.mjs';

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

const DEFAULTS = {
  node: GUESS.node,
  cli: GUESS.cli,
  profile: 'headless',
  // 默认就在项目自己目录里干活：她画的东西、写的文件都落在这儿，不散到别的工作区
  workspace: ROOT,
  timeoutMs: 120000,
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  credentialsFile: path.join(os.homedir(), '.dsh', '.credentials.yaml'),
  // DSH 的沙箱档位：workspace-write（默认，动不了工作区外）/ danger-full-access
  // 这里给足权限，安全交给桥里的闸——headless 是非交互的，遇到要审批的动作会直接拒
  permissionMode: 'danger-full-access',
};

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

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
  async run({ prompt, sessionId = null, onEvent = null }) {
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
    const args = [this.cfg.cli, this.cfg.profile, '--json'];
    if (sessionId) args.push('--session-id', sessionId);
    args.push('-');

    this.running += 1;
    const startedAt = Date.now();
    try {
      const result = await this.#spawn(args, String(prompt ?? ''), key, onEvent);
      this.logger?.(
        'brain',
        `headless ${Date.now() - startedAt}ms，${result.text.length} 字，session=${result.sessionId || '?'}`
      );
      return result;
    } finally {
      this.running -= 1;
    }
  }

  #spawn(args, prompt, key, onEvent = null) {
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

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };

      const timer = setTimeout(() => {
        // 连子进程树一起掐：它可能拉起了 SD 这种大程序，只杀爹会剩孤儿占着端口
        killTree(child);
        finish(reject, new Error(`headless 超时（${this.cfg.timeoutMs}ms）`));
      }, this.cfg.timeoutMs);

      const handleLine = (line) => {
        const s = line.trim();
        if (!s) return;
        let ev;
        try { ev = JSON.parse(s); } catch { return; }
        if (ev.type === 'session' && ev.sessionId) sessionId = String(ev.sessionId);
        else if (ev.type === 'final' && typeof ev.text === 'string') finalText = ev.text;
        else if (ev.type === 'text' && typeof ev.text === 'string') streamed += ev.text;
        else if (ev.type === 'status' && ev.usage) {
          usageSeen = true;
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
          const detail = (err || errors.join('; ')).replace(ANSI, '').trim().slice(-400);
          finish(reject, new Error(`headless 退出码 ${code}：${detail || '无输出'}`));
          return;
        }
        if (errors.length && !text) {
          finish(reject, new Error(`headless 报错：${errors.join('; ').slice(-400)}`));
          return;
        }
        finish(resolve, { text, sessionId, usage: usageSeen ? usage : null });
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });
  }
}
