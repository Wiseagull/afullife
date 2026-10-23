#!/usr/bin/env node
// afullife doctor —— 一次问完「装好了没、还活着没、数据有没有坏」。
//
// 为什么要有它：自检原来散在七个脚本里（selftest / probe-gate / probe-social / probe-conflict /
// probe-rules / check-secrets / persona-check），各管一段。装完的人不知道该先跑哪个，出问题时
// 也不知道先看哪儿。doctor 不替它们判定对错，只把**现在这一眼看到的样子**摆出来，分四档：
//
//   正常  这处没问题
//   提示  知道了就行，不用动手（比如桥没开着、小本本还空着）
//   警告  不影响启动，但早晚会咬人（比如表情库有缺文件的条目、某天的事件流特别大）
//   错误  现在就有东西是坏的（比如 Node 版本不够、人格文件没了、data 写不进去）
//
// 有错误退出码 1，否则 0；提示 / 警告不改变退出码。
//
// 用法：
//   node scripts/doctor.mjs           看人话
//   node scripts/doctor.mjs --json    同一份结果，机器读（CI / 面板可以用）
//   node scripts/doctor.mjs --no-net  不碰网络，连本机端口也不连
//
// 它只读：除了读文件、连两个本机端口（3001 SnowLuma / 3220 面板接口），一个字节都不落盘。
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { ROOT, loadConfig, notebookDir, personaDir } from '../src/config.mjs';
import { sniffExt } from '../src/stickers/library.mjs';

const ARGS = new Set(process.argv.slice(2));
const JSON_OUT = ARGS.has('--json');
const NO_NET = ARGS.has('--no-net');

if (ARGS.has('--help') || ARGS.has('-h')) {
  console.log(`afullife doctor —— 装好了没、还活着没、数据有没有坏

  node scripts/doctor.mjs           看人话
  node scripts/doctor.mjs --json    同一份结果，机器读
  node scripts/doctor.mjs --no-net  不碰网络（本机端口也不连）

四档：正常 / 提示 / 警告 / 错误。有错误时退出码 1。
它只读：不动配置、不写数据、不重启任何东西。`);
  process.exit(0);
}

const checks = [];
const add = (level, name, detail = '') => checks.push({ level, name, detail });

const MB = 1024 * 1024;
const fmtBytes = (n) => {
  if (!n) return '0';
  if (n < 1024) return `${n} B`;
  if (n < MB) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * MB) return `${(n / MB).toFixed(1)} MB`;
  return `${(n / (1024 * MB)).toFixed(2)} GB`;
};

const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };

/** 目录里所有文件的数量和总大小（不跟符号链接，免得绕进别人家） */
function dirStat(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.isFile()) continue;
      files += 1;
      try { bytes += fs.statSync(p).size; } catch { /* 读不到就不算体积 */ }
    }
  };
  walk(dir);
  return { files, bytes };
}

function countLines(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    let n = 0;
    for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) n += 1;
    if (text.length && text.charCodeAt(text.length - 1) !== 10) n += 1;
    return n;
  } catch { return 0; }
}

function portOpen(port, host = '127.0.0.1', ms = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (v) => { try { sock.destroy(); } catch { /* 已经关了 */ } resolve(v); };
    sock.setTimeout(ms, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

function readToken() {
  try {
    return fs.readFileSync(path.join(ROOT, 'data', 'web-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

const quiet = { warn() {}, info() {}, error() {}, debug() {} };
const cfg = loadConfig({ logger: quiet });
const dataDir = cfg.dataDir;

// ───────────────────────────── 运行环境 ─────────────────────────────

function checkEnv() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 22) add('ok', 'Node', `v${process.versions.node}`);
  else add('error', 'Node', `v${process.versions.node} 太旧，需要 >= 22（engines 里写死的）`);

  const main = path.join(ROOT, 'src', 'main.mjs');
  if (exists(main)) add('ok', '项目根', ROOT);
  else add('error', '项目根', `${ROOT} 里没有 src/main.mjs，是不是在别处跑的？`);

  const local = path.join(ROOT, 'config.local.json');
  if (exists(local)) add('ok', 'config.local.json', '在');
  else add('info', 'config.local.json', '没有，现在用的是默认配置');

  if (!exists(dataDir)) {
    // 刚 clone 下来还没启动过：data/ 是第一次跑桥时自己建的，不算毛病
    add('info', 'data 目录', `${dataDir} 还没建，第一次启动会自己建`);
  } else {
    try {
      fs.accessSync(dataDir, fs.constants.R_OK | fs.constants.W_OK);
      add('ok', 'data 目录', `${dataDir} 可读可写`);
    } catch {
      add('error', 'data 目录', `${dataDir} 读不了或写不进`);
    }
  }

  const pdir = personaDir(cfg);
  for (const [name, level] of [['core', 'error'], ['group', 'warn'], ['self', 'info']]) {
    const file = path.join(pdir, `${name}.md`);
    if (!exists(file)) {
      add(level, `人格 ${name}.md`, name === 'self' ? '还空着，正常' : `没有 ${file}`);
      continue;
    }
    const size = fs.statSync(file).size;
    if (size === 0) add(name === 'self' ? 'info' : 'warn', `人格 ${name}.md`, '是空文件');
    else add('ok', `人格 ${name}.md`, fmtBytes(size));
  }

  const owners = cfg.owner?.userIds || [];
  if (owners.length) add('ok', '主人号', `${owners.length} 个`);
  else add('warn', '主人号', 'owner.userIds 是空的——没人能让她动手');
}

// ───────────────────────────── 接口 ─────────────────────────────

async function checkPorts() {
  const token = readToken();
  if (token.length >= 16) add('ok', '面板令牌', 'data/web-token 在');
  else add('warn', '面板令牌', '没有 data/web-token——桥没启动过，或者本机接口还是裸的');

  if (NO_NET) {
    add('info', '桥', '--no-net，没连');
    add('info', 'SnowLuma', '--no-net，没连');
    return;
  }

  const port = Number(cfg.web?.port || 3220);
  let bridge = null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers: { 'x-qad-ui': '1', 'x-qad-token': token },
      signal: AbortSignal.timeout(2000),
    });
    bridge = res.ok ? await res.json() : { http: res.status };
  } catch {
    bridge = null;
  }
  if (bridge?.ok) {
    const bits = [`brain=${bridge.brain}`, `${(bridge.rooms || []).length} 个房间在线`];
    if (typeof bridge.pending === 'number') bits.push(`待确认 ${bridge.pending}`);
    add('ok', '桥', `在跑（127.0.0.1:${port}，${bits.join('，')}）`);
  } else if (bridge && bridge.http) {
    add('warn', '桥', `端口 ${port} 有东西在听，但 /api/status 回了 ${bridge.http}（令牌对不上？）`);
  } else {
    add('info', '桥', `没在跑（127.0.0.1:${port} 没人听），要用 QQ 那边就先 node src/main.mjs`);
  }

  const slPort = 3001;
  const sl = await portOpen(slPort);
  add(sl ? 'ok' : 'info', 'SnowLuma', sl ? `在跑（127.0.0.1:${slPort}）` : `没在跑（127.0.0.1:${slPort} 关着）`);
}

// ───────────────────────────── 数据 ─────────────────────────────

function checkStickers() {
  const dir = path.join(dataDir, 'stickers');
  const file = path.join(dir, 'library.json');
  if (!exists(file)) {
    add('info', '表情库', '还没建（收第一张图时自己建）');
    return;
  }
  let lib;
  try { lib = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {
    add('error', '表情库', `${file} 不是合法 JSON`);
    return;
  }
  const items = Array.isArray(lib.items) ? lib.items : [];
  const bytes = items.reduce((s, i) => s + (i.bytes || 0), 0);
  const maxCount = 300;
  const maxMb = 200;
  const headroom = [];
  headroom.push(`还能收 ${Math.max(0, maxCount - items.length)} 张`);
  headroom.push(`还能放 ${Math.max(0, maxMb - bytes / MB).toFixed(0)} MB`);
  add('ok', '表情库', `${items.length} 张 / ${fmtBytes(bytes)}（${headroom.join('，')}，到顶会自己清）`);

  const missing = [];
  const badExt = [];
  const badText = [];
  const groups = new Map();
  const byId = new Map();
  for (const it of items) {
    byId.set(it.id, it);
    const abs = path.isAbsolute(it.file) ? it.file : path.resolve(ROOT, it.file);
    if (!exists(abs)) { missing.push(it.id); continue; }
    const real = sniffExt(abs);
    if (real && path.extname(abs).toLowerCase() !== real) badExt.push(it.id);
    for (const t of it.tags || []) if (/[?\uFFFD]/.test(t)) { badText.push(it.id); break; }
    if (it.when && /[?\uFFFD]/.test(it.when)) badText.push(it.id);
    if (it.hash) {
      if (!groups.has(it.hash)) groups.set(it.hash, []);
      groups.get(it.hash).push(it.id);
    }
  }
  const dupGroups = [...groups.values()].filter((g) => g.length > 1);
  // 「一组重复」本身不是毛病：标了「重复」的就是排队等清库的，没标的才是真的多收了
  const untaggedDup = dupGroups.filter((g) => {
    const tagged = g.filter((id) => (byId.get(id)?.tags || []).includes('重复')).length;
    return tagged < g.length - 1;
  });
  if (missing.length) add('warn', '表情库·缺文件', `${missing.length} 条指向的图不在了：${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ' …' : ''}（确认不要了：node scripts/sticker-lib.mjs drop <id>）`);
  if (badExt.length) add('warn', '表情库·扩展名', `${badExt.length} 条名字和真身对不上（read_image 会拒读）：${badExt.slice(0, 6).join(', ')}${badExt.length > 6 ? ' …' : ''}`);
  if (badText.length) add('warn', '表情库·乱码', `${badText.length} 条标签/语境里带问号或替换符：${badText.slice(0, 6).join(', ')}${badText.length > 6 ? ' …' : ''}`);
  if (untaggedDup.length) add('warn', '表情库·重复', `${untaggedDup.length} 组内容一样但没标「重复」（node scripts/sticker-lib.mjs dedupe 可以标掉）`);
  else if (dupGroups.length) add('info', '表情库·重复', `${dupGroups.length} 组内容一样，都标好了，等清库时先走`);
  if (!missing.length && !badExt.length && !badText.length && !dupGroups.length) {
    add('ok', '表情库·账实相符', '文件都在、名字都对、没有重复组');
  }
}

function checkNotebook() {
  const dir = notebookDir(cfg);
  const limitMb = Number(cfg.notebook?.limitMb || 20480);
  if (!exists(dir)) {
    add('info', '小本本', `${dir} 还没建`);
    return;
  }
  const { files, bytes } = dirStat(dir);
  const usedPct = (bytes / (limitMb * MB)) * 100;
  const detail = `${files} 个文件 / ${fmtBytes(bytes)}（上限 ${limitMb / 1024} GB，用了 ${usedPct < 1 ? usedPct.toFixed(2) : usedPct.toFixed(0)}%）`;
  if (usedPct >= 95) add('error', '小本本', `${detail} —— 快满了，先清旧的再写`);
  else if (usedPct >= 80) add('warn', '小本本', detail);
  else add('ok', '小本本', detail);
}

function checkEvents() {
  const dir = path.join(dataDir, 'events');
  if (!exists(dir)) {
    add('info', '事件流', '还没有 events/（还没收过消息）');
    return;
  }
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  } catch { /* 下面按空处理 */ }
  if (!names.length) {
    add('info', '事件流', '还没有事件文件');
    return;
  }
  let total = 0;
  let biggest = { name: '', bytes: 0, lines: 0 };
  for (const name of names) {
    const p = path.join(dir, name);
    let bytes = 0;
    try { bytes = fs.statSync(p).size; } catch { continue; }
    total += bytes;
    if (bytes > biggest.bytes) biggest = { name, bytes, lines: countLines(p) };
  }
  // 文件名是本地日期（见 src/memory/events.mjs 的 dayKey），别拿 toISOString 的 UTC 日子去对
  const d = new Date();
  const todayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = path.join(dir, `events-${todayKey}.jsonl`);
  const todayLines = exists(today) ? countLines(today) : 0;
  const detail = `${names.length} 天 / ${fmtBytes(total)}；今天 ${todayLines} 条；最大一天 ${biggest.name} ${biggest.lines} 条`;
  // 读的一侧已经只读尾巴了（2026-10-23），所以这里只提示体积：备份、导出、翻旧账会慢
  if (biggest.lines > 50000) add('info', '事件流', `${detail} —— 单日很大，备份/导出会慢（轮转还没做）`);
  else add('ok', '事件流', detail);
}

function checkLogs() {
  const dir = path.join(dataDir, 'logs');
  const today = path.join(dir, `dsh-supervisor.log`);
  if (!exists(today)) {
    add('info', '日志', '没有 dsh-supervisor.log');
    return;
  }
  const size = fs.statSync(today).size;
  let bad = 0;
  try {
    const text = fs.readFileSync(today, 'utf8');
    const lines = text.split('\n').slice(-2000);
    for (const line of lines) if (/失败|错误|超时|ECONNREFUSED|Error:/.test(line)) bad += 1;
  } catch { /* 读不到就不数 */ }
  const detail = `${fmtBytes(size)}；最近 2000 行里 ${bad} 行带失败/超时字样`;
  add(bad > 50 ? 'warn' : 'ok', '日志', detail);
}

// ───────────────────────────── 一致性 ─────────────────────────────

function checkWiring() {
  const roots = cfg.safety?.workspaceRoots || [];
  const gone = roots.filter((r) => !exists(r));
  if (!roots.length) add('info', '工作区白名单', '空的（= 只有项目目录和 data 能动手）');
  else if (gone.length) add('warn', '工作区白名单', `${gone.length} 个路径不在了：${gone.join('、')}`);
  else add('ok', '工作区白名单', `${roots.length} 个都在`);

  if (cfg.brain?.kind === 'headless') {
    const cli = cfg.brain.headless?.cli || '';
    if (!cli) add('info', '大脑', 'headless；没填 brain.headless.cli，靠启动时从 DSH 可执行文件旁边自动探');
    else if (/[\\/]/.test(cli) && !exists(cli)) add('error', '大脑', `headless.cli 指向的文件不在：${cli}`);
    else add('ok', '大脑', `headless（${cli || '自动探测'}）`);
  } else {
    add('info', '大脑', `kind=${cfg.brain?.kind || 'none'}（只收不说话）`);
  }

  const sl = cfg.snowluma?.dir || '';
  if (sl && !exists(sl)) add('warn', 'SnowLuma 目录', `config 里写的 ${sl} 不在了`);
}

// ───────────────────────────── 输出 ─────────────────────────────

const MARK = { ok: '正常', info: '提示', warn: '警告', error: '错误' };
const PAD = 6;

function print() {
  const counts = { ok: 0, info: 0, warn: 0, error: 0 };
  for (const c of checks) counts[c.level] += 1;

  console.log(`afullife doctor  ${new Date().toLocaleString('zh-CN', { hour12: false })}`);
  console.log('');
  for (const c of checks) {
    const tag = `[${MARK[c.level]}]`.padEnd(PAD + 2);
    console.log(`${tag}${c.name}${c.detail ? ` —— ${c.detail}` : ''}`);
  }
  console.log('');
  console.log(`正常 ${counts.ok} / 提示 ${counts.info} / 警告 ${counts.warn} / 错误 ${counts.error}`);
  if (counts.error) console.log('先修错误那几条，其余可以不急。');
  else if (counts.warn) console.log('能跑；警告那几条是早晚会咬人的。');
  else console.log('没事。');
  return counts;
}

async function main() {
  checkEnv();
  await checkPorts();
  checkStickers();
  checkNotebook();
  checkEvents();
  checkLogs();
  checkWiring();

  const counts = print();
  if (JSON_OUT) console.log(JSON.stringify({ ok: counts.error === 0, counts, checks }, null, 2));
  process.exitCode = counts.error ? 1 : 0;
}

main().catch((err) => {
  console.error('doctor 自己挂了：', err && err.stack ? err.stack : err);
  process.exitCode = 2;
});

