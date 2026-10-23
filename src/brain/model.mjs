// 她用什么模型。
//
// 模型不是这个项目选的，是 DSH 那个 profile 的默认值（`agent-default-model`）。
// 这个文件做四件事：
//   1. 读：问 DSH 要一份 compose 好的配置，把 profile 里真正生效的 provider/model 找出来
//      ——`dsh --dump-config` 会把所有 bundle 层叠完的结果打出来，比读 yml 文件准。
//   2. 写：把「这次换一个」写成一份额外的 patch，起进程时用 `--patch` 叠上去。
//      `--patch` 是「在 profile 层之后再叠一层」，所以我们这份永远压过 profile 自己的配置，
//      也不用去改用户 profile 目录里的文件（那是他的地盘）。
//   3. 借用：下载者可能早就在自己的 DSH（desktop 那个 profile）里加过中转站。这里把那份
//      `llm-pi-ai.providers` 读出来，原样搬进我们的 patch —— 她就能直接用，不用重填一遍。
//   4. 自己加：面板里填 Base URL / 协议 / 密钥 / 模型 id，也写进同一份 patch。
//      密钥不进 DSH 凭据文件，起进程时用环境变量喂给子进程。
//
// 起进程的参数顺序有讲究：`--patch` 是启动器参数，必须排在 profile 名之前：
//   dsh --patch <file> headless --json -
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** llm-pi-ai 认的三种协议（DSH「自定义模型 API」里那三项）。 */
export const API_KINDS = ['openai-completions', 'openai-responses', 'anthropic-messages'];

const NL = /\r?\n/;
const BACKSLASH = String.fromCharCode(92);

/**
 * 从 `--dump-config` 的输出里挑出 `agent-default-model` 那一块。
 * 不引 YAML 库：只要这一块里的 provider / model 两行。
 * @param {string} text
 * @returns {{ provider: string, model: string }}
 */
export function parseDefaultModel(text) {
  const lines = String(text || '').split(NL);
  const head = new RegExp("^\\s*-\\s*id:\\s*['\"]?agent-default-model['\"]?\\s*$");
  const at = lines.findIndex((l) => head.test(l));
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
 * 从 `--dump-config` 输出里把 `llm-pi-ai` 那份 providers 的**名字**挑出来。
 * @param {string} text
 * @returns {string[]}
 */
export function parseProviderIds(text) {
  return Object.keys(parseProviderTable(text));
}

/**
 * 把 `--dump-config` 里 `llm-pi-ai.providers` 整块读出来（含每家有哪些模型）。
 * 只认那几层缩进：4 providers / 6 家名 / 8 字段 / 8 models / 10 "- id" / 12 name。
 * @param {string} text
 * @returns {Record<string, {displayName?: string, apiKeyEnv?: string, api?: string, baseURL?: string, models: {id: string, name?: string}[]}>}
 */
export function parseProviderTable(text) {
  const lines = String(text || '').split(NL);
  const head = new RegExp("^\\s*-\\s*id:\\s*['\"]?llm-pi-ai['\"]?\\s*$");
  const at = lines.findIndex((l) => head.test(l));
  if (at < 0) return {};
  const out = {};
  let cur = null;
  let inModels = false;
  for (let i = at + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s{0,2}-\s*id:/.test(line)) break;   // 只认顶层那条，别被 models 里的 - id 打断
    if (/^\s*#/.test(line)) continue;
    if (/^\s{4}providers:\s*$/.test(line)) continue;

    const nameOnly = line.match(/^\s{6}([A-Za-z0-9._-]+):\s*$/);
    if (nameOnly) {
      cur = { models: [] };
      out[nameOnly[1]] = cur;
      inModels = false;
      continue;
    }
    if (!cur) continue;

    if (/^\s{8}models:\s*$/.test(line)) { inModels = true; continue; }

    const field = line.match(/^\s{8}(displayName|apiKeyEnv|api|baseURL):\s*(.*)$/);
    if (field) {
      cur[field[1]] = field[2].trim().replace(/^['"]|['"]$/g, '');
      inModels = false;
      continue;
    }

    if (inModels) {
      const mid = line.match(/^\s{10}-\s*id:\s*(.*)$/);
      if (mid) {
        cur.models.push({ id: mid[1].trim().replace(/^['"]|['"]$/g, '') });
        continue;
      }
      const mname = line.match(/^\s{12}name:\s*(.*)$/);
      if (mname && cur.models.length) {
        cur.models[cur.models.length - 1].name = mname[1].trim().replace(/^['"]|['"]$/g, '');
      }
    }
  }
  return out;
}

function dumpConfig({ node, cli, profile, timeoutMs = 20000 }) {
  const r = spawnSync(node, [cli, '--profile', profile, '--dump-config'], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    // DSH 的可执行文件其实是 Electron，要这么跑才是纯 node（否则它去开窗口）
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  if (r.error) return null;
  return `${r.stdout || ''}${r.stderr || ''}`;
}

/**
 * 问 DSH：这个 profile 现在生效的模型是什么。
 * 要跑一次 CLI（约 1–3 秒），调用方自己缓存。
 * @returns {{ provider: string, model: string, error?: string, providers?: string[] }}
 */
export function readProfileModel({ node, cli, profile = 'headless', timeoutMs = 20000 }) {
  if (!node || !cli) return { provider: '', model: '', error: '没找到 DSH 的 node/cli（见 README 第 3 步）' };
  const text = dumpConfig({ node, cli, profile, timeoutMs });
  if (text == null) return { provider: '', model: '', error: '读不到 dump-config' };
  const got = parseDefaultModel(text);
  got.providers = parseProviderIds(text);
  if (!got.provider && !got.model) return { ...got, error: 'dump-config 里没找到 agent-default-model' };
  return got;
}

/** 读出来的提供商表缓存一会儿（读文件很快，但别每轮都读）。 */
const TABLE_CACHE = new Map();

/**
 * 读下载者本机 DSH 里已经配好的提供商（他在设置里加的中转站、自建网关）。
 *
 * 直接读 profile 目录里的 patch 文件——`desktop` 这个 profile 被 Electron 独占，
 * CLI 的 `--dump-config` 会拒（`profile "desktop" is managed exclusively by the
 * Electron application`），所以不能靠问 DSH，只能读它的配置文件。
 *
 * @param {string} [dshHome]  默认 ~/.dsh
 * @returns {Record<string, any>}
 */
export function readDshProviders(dshHome = path.join(os.homedir(), '.dsh'), { ttlMs = 60 * 1000, force = false } = {}) {
  const hit = TABLE_CACHE.get(dshHome);
  if (!force && hit && Date.now() - hit.at < ttlMs) return hit.table;

  const table = {};
  const profilesDir = path.join(dshHome, 'profiles');
  let names = [];
  try {
    names = fs.readdirSync(profilesDir);
  } catch {
    return table;
  }
  // 顺序决定谁压谁：先 desktop（用户平时在那儿加），再用别的 profile 补
  names.sort((a, b) => (a === 'desktop' ? 1 : b === 'desktop' ? -1 : 0));
  for (const name of names) {
    for (const f of ['cordis.patch.yml', 'cordis.yml']) {
      const file = path.join(profilesDir, name, f);
      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const got = parseProviderTable(text);
      for (const [id, p] of Object.entries(got)) {
        if (!table[id]) table[id] = { ...p, fromProfile: name };
      }
    }
  }
  TABLE_CACHE.set(dshHome, { at: Date.now(), table });
  return table;
}

/**
 * 一个 provider 的 id 能不能用：小写字母开头，只允许小写字母数字点划线。
 * DSH 那边也是这个规矩（它也拿它派生凭据名）。
 * @param {string} id
 */
export function providerIdOk(id) {
  return /^[a-z][a-z0-9._-]{1,40}$/.test(String(id || ''));
}

/** provider id → 喂给子进程的环境变量名（自己加的那家才用它；借来的沿用原来的名字）。 */
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
    const safe = String(name).replace(/[.*+?^${}()|[\]\\]/g, `\\$&`);
    const m = text.match(new RegExp(`^\\s{2}${safe}:\\s*(.+)$`, 'm'));
    if (!m) return '';
    return String(m[1]).trim().replace(/^['"]|['"]$/g, '');
  } catch {
    return '';
  }
}

/**
 * 算出起子进程时要补的环境变量：每家提供商一条。
 * 优先面板里填的 key，其次凭据里的 ref 名，最后按 provider 自己的 apiKeyEnv 名字去凭据里找。
 * @param {Record<string, any>} providers
 * @returns {Record<string, string>}
 */
export function providerEnv(providers = {}) {
  const env = {};
  for (const [id, p] of Object.entries(providers || {})) {
    if (!p || typeof p !== 'object') continue;
    const key = String(p.apiKey || '').trim()
      || readCredentialRef(p.apiKeyRef || '')
      || (p.apiKeyEnv ? readCredentialRef(p.apiKeyEnv) : '');
    const name = p.apiKeyEnv || keyEnvName(id);
    if (key && !process.env[name]) env[name] = key;   // 已有的环境变量不覆盖
  }
  return env;
}

/** 一行 YAML 标量（该加引号就加）。 */
function yamlStr(v) {
  const s = String(v ?? '');
  if (!s) return "''";
  const plain = new RegExp(`^[A-Za-z0-9._:@/${BACKSLASH}-]+$`);
  return plain.test(s) ? s : `'${s.replace(/'/g, "''")}'`;
}

/**
 * 把「换模型」和「能用哪些提供商」写进同一份 patch。
 * providers 里三路合起来：DSH 已有那份（借来的）+ 面板里自己加的那份。
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
    '# 由桥自动生成：这一轮用哪个模型、能用哪些提供商。',
    '# 改这里没用——去面板「模型」页改，或改 config.local.json 的 brain.headless。',
  ];

  if (ids.length) {
    lines.push('- id: llm-pi-ai', '  name: "@deepseek-ai/dsh-llm-pi-ai"', '  config:', '    providers:');
    for (const id of ids) {
      const p = providers[id] || {};
      const api = API_KINDS.includes(p.api) ? p.api : 'openai-completions';
      lines.push(`      ${id}:`);
      lines.push(`        displayName: ${yamlStr(p.displayName || id)}`);
      lines.push(`        apiKeyEnv: ${p.apiKeyEnv || keyEnvName(id)}`);
      lines.push(`        api: ${api}`);
      lines.push(`        baseURL: ${yamlStr(p.baseURL || '')}`);
      const models = Array.isArray(p.models) ? p.models : [];
      const list = models
        .map((m) => (typeof m === 'string' ? { id: m } : { id: (m && m.id) || '', name: m && m.name }))
        .filter((m) => m.id);
      if (list.length) {
        lines.push('        models:');
        for (const m of list) {
          lines.push(`          - id: ${yamlStr(m.id)}`, `            name: ${yamlStr(m.name || m.id)}`);
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
