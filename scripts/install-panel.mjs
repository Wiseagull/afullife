#!/usr/bin/env node
// 把「AFL 通道」装进 DSH 的 desktop profile —— 就是那页设置界面，桥也由它拉起来。
//
// 用法：
//   node scripts/install-panel.mjs                # 装进默认的 desktop profile
//   node scripts/install-panel.mjs --profile web  # 装进别的 profile
//   node scripts/install-panel.mjs --dry-run      # 只说要做什么，不落盘
//   node scripts/install-panel.mjs --uninstall    # 卸掉（项目文件不删）
//
// 做三件事：package.json 加一条 link 依赖、把包名写进 dsh.profile.bundles、
// 在 node_modules 里建一个指向本仓库 plugin/ 的目录链接（Windows 用 junction，不要管理员）。
// 不用 pnpm，也不用联网。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.dirname(HERE);              // 项目根
const PLUGIN_DIR = path.join(PROJECT, 'plugin');  // 要被装进去的那个包

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt = '') => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : dflt;
};

const dryRun = flag('dry-run');
const uninstall = flag('uninstall');
const profileName = opt('profile', 'desktop');
const cwdOpt = opt('profile-dir', '');

const PKG_NAME = 'afullife-panel';

function resolveProfileDir() {
  if (cwdOpt) return path.resolve(cwdOpt);
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'profiles', profileName);
}

function say(line = '') {
  console.log(line);
}

const dir = resolveProfileDir();
const pkgFile = path.join(dir, 'package.json');
const modules = path.join(dir, 'node_modules');
const linkPath = path.join(modules, PKG_NAME);

say(`项目：${PROJECT}`);
say(`插件：${PLUGIN_DIR}`);
say(`目标 profile：${dir}`);
say(`模式：${uninstall ? '卸载' : '安装'}${dryRun ? '（dry-run，不落盘）' : ''}`);
say('');

if (!fs.existsSync(PLUGIN_DIR)) {
  console.error(`✗ 找不到插件目录：${PLUGIN_DIR}`);
  process.exit(1);
}
if (!fs.existsSync(pkgFile)) {
  console.error(`✗ 这个目录里没有 package.json：${dir}`);
  console.error('  先确认 DSH 装过、而且要装的是 desktop profile。');
  console.error('  路径不对就用 --profile <名字> 或 --profile-dir <目录> 指定。');
  process.exit(1);
}

function readPkg() {
  return JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
}

function writePkg(pkg) {
  if (dryRun) return;
  // 只留最近一个备份，别在用户的 profile 里堆一堆时间戳
  const bakPrefix = `${pkgFile}.bak-panel-`;
  try {
    for (const f of fs.readdirSync(path.dirname(pkgFile))) {
      if (f.startsWith(path.basename(bakPrefix))) {
        try { fs.rmSync(path.join(path.dirname(pkgFile), f), { force: true }); } catch { /* 删不掉就算了 */ }
      }
    }
  } catch { /* 目录读不动也无所谓 */ }
  fs.copyFileSync(pkgFile, `${bakPrefix}${Date.now()}`);
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
}

function exists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

if (uninstall) {
  const pkg = readPkg();
  const bundles = pkg?.dsh?.profile?.bundles || [];
  if (bundles.includes(PKG_NAME)) {
    pkg.dsh.profile.bundles = bundles.filter((b) => b !== PKG_NAME);
    say('· 从 dsh.profile.bundles 里去掉');
  }
  if (pkg?.dependencies?.[PKG_NAME]) {
    delete pkg.dependencies[PKG_NAME];
    say('· 从 dependencies 里去掉');
  }
  writePkg(pkg);
  if (exists(linkPath)) {
    say('· 删掉 node_modules 里的链接');
    if (!dryRun) {
      try { fs.rmSync(linkPath, { recursive: true, force: true }); } catch (err) {
        console.error(`  ⚠ 没删掉：${err?.message ?? err}（手动删 ${linkPath}）`);
      }
    }
  }
  say('');
  say('卸完了。重启 DSH 之后那页设置就没了（项目文件没动）。');
  process.exit(0);
}

// ── 安装 ────────────────────────────────────────────────
const pkg = readPkg();
pkg.dependencies = pkg.dependencies || {};
pkg.dsh = pkg.dsh || {};
pkg.dsh.profile = pkg.dsh.profile || {};
const bundles = new Set(pkg.dsh.profile.bundles || []);

const wantDep = `link:${PLUGIN_DIR.split(path.sep).join('/')}`;
const changed = [];
if (pkg.dependencies[PKG_NAME] !== wantDep) {
  pkg.dependencies[PKG_NAME] = wantDep;
  changed.push(`dependencies: ${PKG_NAME} = ${wantDep}`);
}
if (!bundles.has(PKG_NAME)) {
  bundles.add(PKG_NAME);
  changed.push('dsh.profile.bundles: 加上 ' + PKG_NAME);
}
pkg.dsh.profile.bundles = [...bundles];

if (changed.length) {
  for (const c of changed) say(`· ${c}`);
  writePkg(pkg);
} else {
  say('· package.json 里已经写好了，不用改');
}

// node_modules 里的目录链接
fs.mkdirSync(modules, { recursive: true });
const already = exists(linkPath);
if (already) {
  let target = '';
  try { target = path.resolve(fs.readlinkSync(linkPath)); } catch { /* 不是链接 */ }
  if (target && path.resolve(target) === path.resolve(PLUGIN_DIR)) {
    say('· node_modules 里的链接已经指对了');
  } else {
    say(`· node_modules 里有个不对的 ${PKG_NAME}（指向 ${target || '未知'}），换成新的`);
    if (!dryRun) {
      try { fs.rmSync(linkPath, { recursive: true, force: true }); } catch { /* 下一步会重建 */ }
    }
  }
}
if (!already || !fs.existsSync(path.join(linkPath, 'package.json'))) {
  if (!dryRun) {
    try {
      fs.symlinkSync(PLUGIN_DIR, linkPath, 'junction');
      say('· 建好 node_modules 链接（junction，不需要管理员）');
    } catch (err) {
      say(`  ⚠ 建链接失败：${err?.message ?? err}`);
      say(`    手动做一个也行：把 ${PLUGIN_DIR} 复制或链接到 ${linkPath}`);
    }
  } else {
    say(`· （dry-run）会建链接 ${linkPath} → ${PLUGIN_DIR}`);
  }
}

// 验一下
say('');
const okPkg = fs.existsSync(path.join(linkPath, 'package.json'));
const okEntry = fs.existsSync(path.join(linkPath, 'index.js'));
say(okPkg && okEntry ? '✓ 装好了' : '⚠ 看起来没装全，检查上面的 ⚠');
say('');
say('下一步：**把 DSH 完全关掉再打开**，然后到「设置」里找「AFL 通道」这一页。');
say('（只是刷新页面不够，宿主插件要重启才会加载。）');
