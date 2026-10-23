// 她用什么模型。
//
// 模型不是这个项目选的，是 DSH 那个 profile 的默认值（`agent-default-model`）。
// 这个文件做两件事：
//   1. 读：问 DSH 要一份 compose 好的配置，把 profile 里真正生效的 provider/model 找出来
//      ——`dsh --dump-config` 会把所有 bundle 层叠完的结果打出来，比读 yml 文件准。
//   2. 写：把「这次换一个」写成一份额外的 patch，起进程时用 `--patch` 叠上去。
//      `--patch` 是「在 profile 层之后再叠一层」，所以我们这份永远压过 profile 自己的配置，
//      也不用去改用户 profile 目录里的文件（那是他的地盘）。
//
// 起进程的参数顺序有讲究：`--patch` 是启动器参数，必须排在 profile 名之前：
//   dsh --patch <file> headless --json -
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 从 `--dump-config` 的输出里挑出 `agent-default-model` 那一块。
 * 不引 YAML 库：只要这一块里的 provider / model 两行。
 * @param {string} text
 * @returns {{ provider: string, model: string }}
 */
export function parseDefaultModel(text) {
  const lines = String(text || '').split(/\r?\n/);
  const at = lines.findIndex((l) => /^\s*-\s*id:\s*['"]?agent-default-model['"]?\s*$/.test(l));
  if (at < 0) return { provider: '', model: '' };
  const out = { provider: '', model: '' };
  for (let i = at + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*-\s*id:/.test(line)) break;      // 下一块了
    if (/^\s*#/.test(line)) continue;          // 注释行（dump 里带 bundle 分隔注释）
    const m = line.match(/^\s+(provider|model):\s*['"]?([^'"\s#]+)['"]?\s*$/);
    if (m) out[m[1]] = m[2];
    if (out.provider && out.model) break;
  }
  return out;
}

/**
 * 问 DSH：这个 profile 现在生效的模型是什么。
 * 要跑一次 CLI（约 1–3 秒），调用方自己缓存。
 * @returns {{ provider: string, model: string, error?: string }}
 */
export function readProfileModel({ node, cli, profile = 'headless', timeoutMs = 20000 }) {
  if (!node || !cli) return { provider: '', model: '', error: '没找到 DSH 的 node/cli（见 README 第 3 步）' };
  const r = spawnSync(node, [cli, '--profile', profile, '--dump-config'], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    // DSH 的可执行文件其实是 Electron，要这么跑才是纯 node（否则它去开窗口）
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  if (r.error) return { provider: '', model: '', error: String(r.error.message || r.error) };
  const text = `${r.stdout || ''}${r.stderr || ''}`;
  const got = parseDefaultModel(text);
  if (!got.provider && !got.model) return { provider: '', model: '', error: 'dump-config 里没找到 agent-default-model' };
  return got;
}

/**
 * 把「这次用哪个模型」写成一份 patch 文件。返回文件路径；没指定就返回 null（= 跟 profile 默认）。
 * 文件名固定，内容变了才重写（起进程前调用，别每次都写盘）。
 * @param {string} dir           放 patch 的目录（项目 data/）
 * @param {{provider?: string, model?: string}} want
 * @returns {string|null}
 */
export function writeModelPatch(dir, want = {}) {
  const provider = String(want.provider || '').trim();
  const model = String(want.model || '').trim();
  if (!provider || !model) return null;
  const body = [
    '# 由桥自动生成：这一轮用哪个模型（改这里没用，去面板「用量」页改，或改 config.local.json）',
    '- id: agent-default-model',
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    '  config:',
    `    provider: ${provider}`,
    `    model: ${model}`,
    '',
  ].join('\n');
  const file = path.join(dir, 'model-patch.yml');
  try {
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (old !== body) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, body, 'utf8');
    }
  } catch {
    return null;   // 写不了就当没指定，别把回话也拖挂
  }
  return file;
}
