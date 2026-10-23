// 她用什么模型。
//
// 模型不是这个项目选的，是 DSH 那个 profile 的默认值（`agent-default-model`）。
// 这个文件做三件事：
//   1. 读：问 DSH 要一份 compose 好的配置，把 profile 里真正生效的 provider/model 找出来
//      ——`dsh --dump-config` 会把所有 bundle 层叠完的结果打出来，比读 yml 文件准。
//   2. 写：把「这次换一个」写成一份额外的 patch，起进程时用 `--patch` 叠上去。
//      `--patch` 是「在 profile 层之后再叠一层」，所以我们这份永远压过 profile 自己的配置，
//      也不用去改用户 profile 目录里的文件（那是他的地盘）。
//   3. 自己加提供商：panel 里填 Base URL / 协议 / 密钥 / 模型 id，我们也当 `llm-pi-ai`
//      的 providers 写进同一份 patch —— 这样连服务商的 key 都不用动 DSH 的凭据文件，
//      起进程时用环境变量喂给子进程就行。
//
// 起进程的参数顺序有讲究：`--patch` 是启动器参数，必须排在 profile 名之前：
//   dsh --patch <file> headless --json -
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** llm-pi-ai 认的三种协议（DSH「自定义模型 API」里那三项）。 */
export const API_KINDS = ['openai-completions', 'openai-responses', 'anthropic-messages'];

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
 * @returns {{ provider: string, model: string, error?: string, providers?: string[] }}
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
  got.providers = parseProviderIds(text);
  if (!got.provider && !got.model) return { ...got, error: 'dump-config 里没找到 agent-default-model' };
  return got;
}

/**
 * 从 `--dump-config` 输出里把 `llm-pi-ai` 那份 providers 的**名字**挑出来。
 * 只看 key 行（缩进 6 个空格的那种），够用了——面板只需要知道「已经有哪几家」。
 * @param {string} text
 * @returns {string[]}
 */
export function parseProviderIds(text) {
  const lines = String(text || '').split(/\r?\n/);
  const at = lines.findIndex((l) => /^\s*-\s*id:\s*['"]?llm-pi-ai['"]?\s*$/.test(l));
  if (at < 0) return [];
  const out = [];
  let inProviders = false;
  for (let i = at + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*-\s*id:/.test(line)) break;
    if (/^\s*#/.test(line)) continue;
    if (/^\s{4}providers:\s*$/.test(line)) { inProviders = true; continue; }
    if (!inProviders) continue;
    const m = line.match(/^\s{6}([A-Za-z0-9._-]+):\s*$/);
    if (m) out.push(m[1]);
  }
  return out;
}

/**
 * 一个 provider 的 id 能不能用：小写字母开头，只允许小写字母数字点划线。
 * DSH 那边也是这个规矩（它也拿它派生凭据名）。
 * @param {string} id
 */
export function providerIdOk(id) {
  return /^[a-z][a-z0-9._-]{1,40}$/.test(String(id || ''));
}

/** provider id → 喂给子进程的环境变量名。 */
export function keyEnvName(id) {
  return `QAD_LLM_KEY_${String(id || '').toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

/**
 * 从 `~/.dsh/.credentials.yaml` 的 refs 里取一个已有的键（用户可能早就在 DSH 里存过）。
 * 只读、只认 `refs:` 下面那种 `NAME: value` 一行。
 * @param {string} name
 * @param {string} [file]
 * @returns {string}
 */
export function readCredentialRef(name, file = path.join(os.homedir(), '.dsh', '.credentials.yaml')) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const re = new RegExp(`^\\s{2}${String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*(.+)$`, 'm');
    const m = text.match(re);
    if (!m) return '';
    return String(m[1]).trim().replace(/^['"]|['"]$/g, '');
  } catch {
    return '';
  }
}

/**
 * 算出起子进程时要补的环境变量：每个自定义 provider 一条。
 * 优先用面板里填的 key，没填就去 DSH 凭据里找同名 ref。
 * @param {Record<string, any>} providers
 * @returns {Record<string, string>}
 */
export function providerEnv(providers = {}) {
  const env = {};
  for (const [id, p] of Object.entries(providers || {})) {
    if (!p || typeof p !== 'object') continue;
    const key = String(p.apiKey || '').trim() || readCredentialRef(p.apiKeyRef || '');
    if (key) env[keyEnvName(id)] = key;
  }
  return env;
}

/** 一行 YAML 标量（该加引号就加）。 */
function yamlStr(v) {
  const s = String(v ?? '');
  if (!s) return "''";
  return /^[A-Za-z0-9._:@/-]+$/.test(s) ? s : `'${s.replace(/'/g, "''")}'`;
}

/**
 * 把「换模型」和「自己加的提供商」写进同一份 patch。
 * @param {string} dir
 * @param {{ provider?: string, model?: string, providers?: Record<string, any> }} want
 * @returns {string|null}  patch 文件路径；既没模型也没 provider 就返回 null
 */
export function writeModelPatch(dir, want = {}) {
  const provider = String(want.provider || '').trim();
  const model = String(want.model || '').trim();
  const providers = want.providers && typeof want.providers === 'object' ? want.providers : {};
  const ids = Object.keys(providers).filter((id) => providerIdOk(id));

  if ((!provider || !model) && ids.length === 0) return null;

  const lines = [
    '# 由桥自动生成：这一轮用哪个模型、能用哪些自己加的提供商。',
    '# 改这里没用——去面板「模型」页改，或改 config.local.json 的 brain.headless。',
  ];

  if (ids.length) {
    lines.push('- id: llm-pi-ai', '  name: "@deepseek-ai/dsh-llm-pi-ai"', '  config:', '    providers:');
    for (const id of ids) {
      const p = providers[id] || {};
      const api = API_KINDS.includes(p.api) ? p.api : 'openai-completions';
      lines.push(`      ${id}:`);
      lines.push(`        displayName: ${yamlStr(p.displayName || id)}`);
      lines.push(`        apiKeyEnv: ${keyEnvName(id)}`);
      lines.push(`        api: ${api}`);
      lines.push(`        baseURL: ${yamlStr(p.baseURL || '')}`);
      const models = Array.isArray(p.models) ? p.models : [];
      if (models.length) {
        lines.push('        models:');
        for (const m of models) {
          const mid = typeof m === 'string' ? m : m && m.id;
          if (!mid) continue;
          const mname = (typeof m === 'object' && m && m.name) || mid;
          lines.push(`          - id: ${yamlStr(mid)}`, `            name: ${yamlStr(mname)}`);
        }
      }
    }
  }

  if (provider && model) {
    lines.push(
      '- id: agent-default-model',
      '  name: "@deepseek-ai/dsh-agent-default-model"',
      '  config:',
      `    provider: ${yamlStr(provider)}`,
      `    model: ${yamlStr(model)}`,
    );
  }
  lines.push('');

  const body = lines.join('\n');
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
