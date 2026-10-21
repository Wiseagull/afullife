// 读出某个 DSH profile 里装了哪些插件，并标出它是什么类型——
// 给安装脚本用：让人挑要加装哪些，也顺手挡住没法在无界面环境跑的。
//
// 用法：node scripts/dsh-plugins.mjs [profile=desktop]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DSH_PROFILES = path.join(os.homedir(), '.dsh', 'profiles');

/** 纯粹的界面插件：没有宿主入口，只在页面里画东西 */
const UI_ONLY = new Set([
  'dsh-better-sidebar',
  'dsh-whale-widget',
  'dsh-skin-market',
  '@smalltailqwq/dsh-client-ui-skin-maid-atelier',
]);

export function readProfile(profile = 'desktop') {
  const dir = path.join(DSH_PROFILES, profile);
  const pkgFile = path.join(dir, 'package.json');
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')); } catch { return null; }

  const deps = Object.keys(pkg.dependencies || {});
  const bundles = new Set(pkg.dsh?.profile?.bundles || []);
  const list = [];

  for (const name of deps) {
    const pdir = path.join(dir, 'node_modules', name);
    let pj = {};
    try { pj = JSON.parse(fs.readFileSync(path.join(pdir, 'package.json'), 'utf8')); } catch { continue; }
    const d = pj.dsh || {};
    const hasBundle = Boolean(d.bundle?.patch);
    const hasClient = Boolean(d.client);
    const hasHostEntry = Boolean(d.facets?.host?.entry || d.host?.entry || pj.main);
    list.push({
      name,
      version: pj.version || '',
      bundle: hasBundle,
      client: hasClient,
      hostEntry: hasHostEntry,
      inBundles: bundles.has(name),
      uiOnly: UI_ONLY.has(name) || (hasClient && !hasBundle && !hasHostEntry),
      patch: d.bundle?.patch || null,
    });
  }
  return { profile, dir, bundles: [...bundles], list };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const which = process.argv[2] || 'desktop';
  const info = readProfile(which);
  if (!info) {
    console.log(`没有这个 profile：${which}`);
    process.exit(1);
  }
  console.log(`${which}  →  ${info.dir}\n`);
  console.log('包名'.padEnd(48), '版本'.padEnd(10), '类型');
  console.log('-'.repeat(84));
  for (const p of info.list) {
    const kind = p.uiOnly ? '只在页面里（无界面跑不了）'
      : p.bundle ? '可整包挂载（bundle）'
      : p.hostEntry ? '有宿主入口（需手挂）'
      : '未知';
    const mark = p.inBundles ? ' ✓已挂' : '';
    console.log(p.name.padEnd(48), String(p.version).padEnd(10), kind + mark);
  }
  console.log(`\n共 ${info.list.length} 个，其中已挂在 bundles 里 ${info.bundles.length} 个`);
}
