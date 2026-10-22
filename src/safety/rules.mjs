// 规则：哪些工具调用可以直接做，哪些得先问一声。
// 这里是死板的表，不是判断——死板才可靠，才测得出、改得动。
//
// 三档：allow（不打扰）/ note（做，但记账）/ block（停下来问他）

import fs from 'node:fs';
import path from 'node:path';

/** 只在看、不动手的东西。 */
const READ_ONLY_TOOLS = new Set([
  'read', 'glob', 'grep', 'web_search', 'web_fetch',
  'todo_write', 'list_agents', 'get_goal', 'job_list', 'job_output',
]);

/** 能派生出"看不见的下一步"的工具 —— 子代理干什么，桥看不见，所以按红处理。 */
const OPAQUE_TOOLS = new Set(['subagent', 'subagent_fork', 'workflow']);

/** 读写白名单：这几个地方随便动，其余一律问。
 *  默认空着，启动时由 main 按配置灌进来（项目目录、data、小本本、她干活的工作区…）。
 *  写死在代码里等于把别人的目录当成我的——别人一装，她写哪儿都被拦。 */
export const WORKSPACE_ROOTS = [];

/** 换一批白名单。启动时调一次就够。 */
export function setWorkspaceRoots(roots = []) {
  WORKSPACE_ROOTS.length = 0;
  for (const r of roots) {
    const s = String(r || '').trim();
    if (s) WORKSPACE_ROOTS.push(s);
  }
}

// 判断一个路径在不在白名单里。
//
// 2026-10-22 外部评审指出的洞：老实现是纯字符串前缀比较，
// `data\..\..\..\Windows\System32\drivers\etc\hosts` 会被判成"在白名单内"。
// 所以现在先 path.resolve 把 .. 摊平（相对路径以项目根为基准），
// 存在的话再 realpath 一次，把 junction / 符号链接 / 8.3 短名也摊平，然后才比。
// 路径判断要能跨平台：2026-10-22 CI 加了 windows-latest 之后发现，
// 同一份用例在 Linux 上把 "C:\Windows\..." 当成"相对路径、在项目里"，
// 于是"写系统目录"被判成 note。闸的结论不该随跑在哪个系统而变。
const WIN_ABS = /^[A-Za-z]:[\\/]/;
const BACKSLASH = /\\/g;

/** 归一成一个可比较的字符串：绝对、真实（能就 realpath）、正斜杠、小写、去掉结尾斜杠。 */
function normish(p) {
  const raw = String(p || '').trim().replace(/^["']|["']$/g, '');
  if (!raw) return '';
  // Windows 盘符路径：在非 Windows 上没法 realpath，直接按字面归一（结论仍然是"在项目外"）
  if (WIN_ABS.test(raw) && process.platform !== 'win32') {
    return raw.replace(BACKSLASH, '/').replace(/\/+$/, '').toLowerCase();
  }
  const abs = path.resolve(process.cwd(), raw);
  let real = abs;
  try { real = fs.realpathSync.native(abs); } catch { /* 不存在就用解析后的绝对路径 */ }
  return real.replace(BACKSLASH, '/').replace(/\/+$/, '').toLowerCase();
}

function rootList() {
  return WORKSPACE_ROOTS.map((r) => normish(String(r))).filter(Boolean);
}

export function underWorkspace(file) {
  const target = normish(file);
  if (!target) return false;
  return rootList().some((r) => target === r || target.startsWith(r + '/'));
}

/** 命令里出现的盘符路径（粗提取，够用就好）。 */
export function pathsIn(text) {
  return String(text || '').match(/[A-Za-z]:\\[^\s"';|&)]*/g) || [];
}

const COMMAND_RULES = [
  { id: 'rm-recursive', why: '递归删除文件或目录', re: /\brm\s+(-[a-z]*[rf][a-z]*\s+){1,2}|remove-item\b[^|;]*-recurse|\b(del|erase)\s+\/[sfq]|\brmdir\s+\/s|\bri\s+-r/i },
  { id: 'push-or-publish', why: '把东西发到外面', re: /\bgit\s+push\b|\bnpm\s+publish\b|\bgh\s+release\b|\bdocker\s+push\b/i },
  { id: 'outbound-post', why: '往外发网络请求', re: /\bcurl\b[^|;]*(-x\s*post|--data|-d\s|--form|-f\s)|invoke-restmethod|invoke-webrequest[^|;]*-method\s*post|\bwget\b[^|;]*--post/i },
  { id: 'install', why: '安装软件或依赖', re: /\bnpm\s+(i|install|add)\b[^|;]*(-g|--global)|\bpip3?\s+install\b|\bwinget\s+install\b|\bchoco\s+install\b|\bpnpm\s+add\b[^|;]*-g|\bscoop\s+install\b/i },
  { id: 'system-change', why: '改系统设置（注册表/服务/计划任务）', re: /\breg\s+(add|delete|import)\b|set-itemproperty[^|;]*hklm|\b(sc|net)\s+(create|delete|start|stop)\b|schtasks[^|;]*\/create|set-executionpolicy/i },
  { id: 'secret-access', why: '碰密钥或凭据', re: /\.credentials\.yaml|\.ssh[\\/]|id_rsa|cookies\.sqlite|\btoken\b.*\.json/i },
  { id: 'nested-shell', why: '套了一层解释器，桥看不清它真正要做什么', re: /\b(bash|sh|cmd|powershell|pwsh|wsl)\b[^|;]*(\s-c\s|\/c\s|-command\b|-encodedcommand\b)/i },
  { id: 'eval', why: '运行时拼出代码执行，内容不可预知', re: /invoke-expression|\biex\b|\bnode\s+-e\b|\bpython[0-9.]*\s+-c\b|frombase64string/i },
  { id: 'recursive-chmod', why: '批量改权限', re: /chmod\s+-R|\bicacls\b[^|;]*\/grant/i },
];

/** 带写动作的命令，如果目标是白名单外的路径，就拦。 */
const WRITE_VERBS = /\b(copy|move|rename|new-item|set-content|add-content|out-file|remove-item|del|erase|rmdir|mkdir|md|touch|tee)\b|>\s*[A-Za-z]:\\/i;

function verdict(level, ruleId, why, detail) {
  return { level, ruleId, why, detail: detail || '' };
}

/**
 * 判断一次工具调用。
 * @param {string} tool
 * @param {object} input
 */
export function classify(tool, input = {}) {
  if (READ_ONLY_TOOLS.has(tool)) return verdict('allow', 'read-only', '只读');

  if (tool === 'write' || tool === 'edit' || tool === 'ops_write_file' || tool === 'ops_edit_file') {
    const file = input.file_path || input.path || input.filePath || '';
    if (!underWorkspace(file)) {
      return verdict('block', 'write-outside', '往工作区外面写', String(file));
    }
    return verdict('note', 'write-inside', '在工作区里写文件', String(file));
  }

  if (tool === 'pwsh' || tool === 'ops_bash' || tool === 'bash') {
    const cmd = String(input.command || input.script_path || '');
    for (const rule of COMMAND_RULES) {
      if (rule.re.test(cmd)) return verdict('block', rule.id, rule.why, cmd.slice(0, 300));
    }
    const outside = pathsIn(cmd).filter((p) => !underWorkspace(p));
    if (outside.length && WRITE_VERBS.test(cmd)) {
      return verdict('block', 'write-outside-cmd', '这条命令要动工作区外面的路径', outside.join(' '));
    }
    if (outside.length) return verdict('note', 'outside-read', '碰到了工作区外的路径', outside.join(' '));
    return verdict('note', 'command', '跑命令', cmd.slice(0, 200));
  }

  if (OPAQUE_TOOLS.has(tool)) {
    return verdict('block', 'opaque', '它会派生一批桥看不见的动作', tool);
  }

  return verdict('note', 'other', `调了 ${tool}`, '');
}
