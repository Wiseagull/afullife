// 把某个 profile 里装着的插件，搬一份到另一个 profile 去。
//
// 为什么要复制而不是 `dsh plugin add`：对方选的都是他已经装在自己机器上的，
// 本地就有文件，复制过去不用联网、版本也跟他界面里的一模一样。
//
// 搬完一定要验：`--dump-config` 合不上就整个回滚。有些插件挂着 bundle 的皮，
// 宿主代码却依赖只有图形界面才有的服务，装上是起不来的。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const DSH_HOME = path.join(os.homedir(), '.dsh');
export const DSH_PROFILES = path.join(DSH_HOME, 'profiles');

/** 纯粹的界面插件：没有宿主入口，无界面环境跑不了 */
const UI_ONLY = new Set([
  'dsh-better-sidebar',
  'dsh-whale-widget',
  'dsh-skin-market',
  '@smalltailqwq/dsh-client-ui-skin-maid-atelier',
]);

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** 读一个 profile 里装了什么，并标类型 */
export function readProfilePlugins(profile = 'desktop') {
  const dir = path.join(DSH_PROFILES, profile);
  const pkg = readJson(path.join(dir, 'package.json'));
  if (!pkg) return null;

  const deps = pkg.dependencies || {};
  const bundles = new Set(pkg.dsh?.profile?.bundles || []);
  const list = [];

  for (const name of Object.keys(deps)) {
    const pj = readJson(path.join(dir, 'node_modules', name, 'package.json'));
    if (!pj) continue;
    const d = pj.dsh || {};
    const hasBundle = Boolean(d.bundle?.patch);
    const hasClient = Boolean(d.client);
    const hasHostEntry = Boolean(d.facets?.host?.entry || d.host?.entry || pj.main);
    list.push({
      name,
      version: pj.version || deps[name],
      spec: deps[name],
      bundle: hasBundle,
      client: hasClient,
      uiOnly: UI_ONLY.has(name) || (hasClient && !hasBundle && !hasHostEntry),
      mounted: bundles.has(name),
    });
  }
  return { profile, dir, list };
}

/** 她自己的面板插件，不参与装卸 */
export const SELF_PLUGIN = 'afullife-panel';

/** 按开关算出来的列表：桌面装着的每个插件，她那边有没有、能不能搬 */
export function listToggleable(from = 'desktop', to = 'headless') {
  const a = readProfilePlugins(from);
  const b = readProfilePlugins(to);
  if (!a) return { error: `没有 ${from} 这个 profile` };
  const have = new Set((b?.list || []).map((p) => p.name));
  return {
    from,
    to,
    plugins: a.list
      .filter((p) => p.name !== SELF_PLUGIN)
      .map((p) => ({
        name: p.name,
        version: p.version,
        uiOnly: p.uiOnly,
        bundle: p.bundle,
        installed: have.has(p.name),
        reason: p.uiOnly ? '只在页面里画东西，无界面环境跑不了'
          : !p.bundle ? '不是可整包挂载的 bundle'
          : null,
      })),
  };
}

/** 哪些装在 from 里、但 to 里还没有 */
export function diffProfiles(from = 'desktop', to = 'headless') {
  const a = readProfilePlugins(from);
  const b = readProfilePlugins(to);
  if (!a) return { error: `没有 ${from} 这个 profile` };
  const have = new Set((b?.list || []).map((p) => p.name));
  return {
    from,
    to,
    missing: a.list.filter((p) => !have.has(p.name)),
    installed: (b?.list || []).map((p) => p.name),
  };
}

function backup(profileDir, tag) {
  const dir = path.join(profileDir, 'backup', tag);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['package.json', 'cordis.patch.yml', 'cordis.yml']) {
    const src = path.join(profileDir, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, f));
  }
  return dir;
}

/** 校验 profile 能不能合上（不真的跑任务） */
function dumpConfig(cli, runtime, profile, cwd) {
  return new Promise((resolve) => {
    const args = [cli, profile, '--dump-config'];
    const child = spawn(runtime, args, {
      cwd,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => child.kill(), 60000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

/**
 * 把 from 里的插件搬进 to。
 * @param {string[]} names 要搬的包名
 * @param {object} opts { from='desktop', to='headless', cli, runtime, logger }
 */
export async function installPlugins(names, { from = 'desktop', to = 'headless', cli, runtime, logger } = {}) {
  const srcInfo = readProfilePlugins(from);
  const dstInfo = readProfilePlugins(to);
  if (!srcInfo) return { ok: false, error: `没有 ${from} 这个 profile` };
  if (!dstInfo) return { ok: false, error: `没有 ${to} 这个 profile` };

  const srcPkgFile = path.join(srcInfo.dir, 'package.json');
  const dstPkgFile = path.join(dstInfo.dir, 'package.json');
  const srcPkg = JSON.parse(fs.readFileSync(srcPkgFile, 'utf8'));
  const dstPkg = JSON.parse(fs.readFileSync(dstPkgFile, 'utf8'));

  const skipped = [];
  const todo = [];
  for (const n of names) {
    const p = srcInfo.list.find((x) => x.name === n);
    if (!p) { skipped.push({ name: n, why: `${from} 里没有这个包` }); continue; }
    if (p.uiOnly) { skipped.push({ name: n, why: '只在页面里，无界面环境跑不了' }); continue; }
    if (!p.bundle) { skipped.push({ name: n, why: '不是可整包挂载的 bundle，需要手写挂载条目' }); continue; }
    if (dstInfo.list.some((x) => x.name === n)) { skipped.push({ name: n, why: '已经装过了' }); continue; }
    todo.push(p);
  }
  if (!todo.length) return { ok: true, installed: [], skipped };

  const tag = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = backup(dstInfo.dir, tag);
  logger?.info?.('tools', `改动前已备份到 ${backupDir}`);

  const copied = [];
  try {
    // 1. 复制包目录
    for (const p of todo) {
      const src = path.join(srcInfo.dir, 'node_modules', p.name);
      const dst = path.join(dstInfo.dir, 'node_modules', p.name);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.cpSync(src, dst, { recursive: true, dereference: true });
      copied.push(dst);
    }

    // 2. 写清单
    dstPkg.dependencies = dstPkg.dependencies || {};
    dstPkg.dsh = dstPkg.dsh || {};
    dstPkg.dsh.profile = dstPkg.dsh.profile || {};
    const bundles = new Set(dstPkg.dsh.profile.bundles || []);
    for (const p of todo) {
      dstPkg.dependencies[p.name] = srcPkg.dependencies[p.name];
      bundles.add(p.name);
    }
    dstPkg.dsh.profile.bundles = [...bundles];
    fs.writeFileSync(dstPkgFile, JSON.stringify(dstPkg, null, 2), 'utf8');

    // 3. 验
    if (cli && runtime) {
      const r = await dumpConfig(cli, runtime, to, dstInfo.dir);
      if (r.code !== 0) {
        throw new Error(`装上之后 profile 合不上：${(r.err || r.out || '').trim().split('\n').slice(-3).join(' ')}`);
      }
    }

    logger?.info?.('tools', `装入 ${todo.map((p) => p.name).join(', ')}`);
    return { ok: true, installed: todo.map((p) => p.name), skipped, backupDir };
  } catch (err) {
    // 回滚
    for (const dst of copied) {
      try { fs.rmSync(dst, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    for (const f of ['package.json', 'cordis.patch.yml', 'cordis.yml']) {
      const b = path.join(backupDir, f);
      if (fs.existsSync(b)) fs.copyFileSync(b, path.join(dstInfo.dir, f));
    }
    logger?.warn?.('tools', `失败已回滚：${err?.message ?? err}`);
    return { ok: false, error: String(err?.message ?? err), skipped, backupDir };
  }
}

/**
 * 把 to 里的插件卸掉（目录、依赖、bundles 三处一起清），失败回滚。
 */
export async function uninstallPlugins(names, { to = 'headless', cli, runtime, logger } = {}) {
  const dstInfo = readProfilePlugins(to);
  if (!dstInfo) return { ok: false, error: `没有 ${to} 这个 profile` };

  const dstPkgFile = path.join(dstInfo.dir, 'package.json');
  const dstPkg = JSON.parse(fs.readFileSync(dstPkgFile, 'utf8'));

  const removed = [];
  const skipped = [];
  for (const n of names) {
    if (n === SELF_PLUGIN) { skipped.push({ name: n, why: '这是面板自己' }); continue; }
    if (!dstInfo.list.some((x) => x.name === n)) { skipped.push({ name: n, why: '本来就没装' }); continue; }
    removed.push(n);
  }
  if (!removed.length) return { ok: true, removed: [], skipped };

  const tag = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = backup(dstInfo.dir, tag);
  const trash = path.join(dstInfo.dir, 'backup', `${tag}-trash`);

  try {
    // 先挪走而不是删：验不过还能完整放回去
    fs.mkdirSync(trash, { recursive: true });
    for (const n of removed) {
      const d = path.join(dstInfo.dir, 'node_modules', n);
      if (fs.existsSync(d)) fs.renameSync(d, path.join(trash, n.replace(/[/\\]/g, '__')));
    }

    for (const n of removed) {
      if (dstPkg.dependencies) delete dstPkg.dependencies[n];
    }
    if (dstPkg.dsh?.profile?.bundles) {
      dstPkg.dsh.profile.bundles = dstPkg.dsh.profile.bundles.filter((x) => !removed.includes(x));
    }
    fs.writeFileSync(dstPkgFile, JSON.stringify(dstPkg, null, 2), 'utf8');

    if (cli && runtime) {
      const r = await dumpConfig(cli, runtime, to, dstInfo.dir);
      if (r.code !== 0) {
        throw new Error(`卸掉之后 profile 合不上：${(r.err || r.out || '').trim().split('\n').slice(-3).join(' ')}`);
      }
    }

    fs.rmSync(trash, { recursive: true, force: true });
    logger?.info?.('tools', `卸掉 ${removed.join(', ')}`);
    return { ok: true, removed, skipped, backupDir };
  } catch (err) {
    // 放回去
    for (const n of removed) {
      const t = path.join(trash, n.replace(/[/\\]/g, '__'));
      if (fs.existsSync(t)) {
        try { fs.renameSync(t, path.join(dstInfo.dir, 'node_modules', n)); } catch { /* ignore */ }
      }
    }
    for (const f of ['package.json', 'cordis.patch.yml', 'cordis.yml']) {
      const b = path.join(backupDir, f);
      if (fs.existsSync(b)) fs.copyFileSync(b, path.join(dstInfo.dir, f));
    }
    logger?.warn?.('tools', `卸载失败已回滚：${err?.message ?? err}`);
    return { ok: false, error: String(err?.message ?? err), skipped, backupDir };
  }
}
