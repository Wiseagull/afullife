// 给你做一套「轻装」profile：聊天的那些轮用它，工具少、每步便宜很多。
//
//   node scripts/make-chat-profile.mjs            # 用 config.local.json 里的 brain.headless.profile 做源
//   node scripts/make-chat-profile.mjs my-chat    # 指定新 profile 名字
//
// 做的事：
//   1. 把源 profile 整个复制一份（node_modules 用软链，不重复占地方）
//   2. bundles 只留 @deepseek-ai/dsh-base + @deepseek-ai/dsh-headless —— 其余插件的工具就不再出现
//   3. cordis.patch.yml 只保留「打开 credentials」，否则连模型都调不通
//   4. 打印接下来要改的一行配置
//
// 为什么有用（2026-10-22 实测，同一句「说说你自己是谁」）：
//   全量 profile：每步 30,967 token
//   轻装 profile：每步  9,558 token
//   差出来的两万多，是那些插件的工具说明——每一轮每一步都要重发一遍。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../src/config.mjs';

const KEEP = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'];
const PATCH = [
  '# 轻装 profile：只留 base + headless。这里的补丁只做一件事——把 credentials 打开，',
  '# 不然拿不到 API key，连一句话都答不出来。',
  '- id: credentials',
  '  disabled: false',
  '',
].join('\n');

const cfg = loadConfig({ cli: {} });
const from = process.argv[2] && !process.argv[2].startsWith('-')
  ? String(cfg.brain?.headless?.profile || 'headless')
  : (cfg.brain?.headless?.profile || 'headless');
const name = (process.argv[2] && process.argv[2].startsWith('-') ? '' : process.argv[2]) || 'headless-chat';

const root = path.join(os.homedir(), '.dsh', 'profiles');
const src = path.join(root, from);
const dst = path.join(root, name);

if (!fs.existsSync(path.join(src, 'package.json'))) {
  console.error(`找不到源 profile：${src}`);
  console.error('先在 config.local.json 里配好 brain.headless.profile，或者确认 DSH 装在这个用户下。');
  process.exit(1);
}
if (from === name) {
  console.error(`新名字不能跟源 profile 一样（${from}）。换个名字，比如 headless-chat。`);
  process.exit(1);
}
if (fs.existsSync(dst)) {
  console.error(`已经存在：${dst}\n想重做就先删掉它。`);
  process.exit(1);
}

fs.mkdirSync(dst, { recursive: true });

// 1. 顶层文件照抄；node_modules 软链过去（Windows 用 junction，不需要管理员权限）
for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
  if (ent.name === 'node_modules') continue;
  const s = path.join(src, ent.name);
  const d = path.join(dst, ent.name);
  if (ent.isDirectory()) fs.cpSync(s, d, { recursive: true });
  else fs.copyFileSync(s, d);
}
const srcNM = path.join(src, 'node_modules');
if (fs.existsSync(srcNM)) {
  try {
    fs.symlinkSync(srcNM, path.join(dst, 'node_modules'), 'junction');
  } catch (e) {
    console.warn('· node_modules 软链没建成（' + e.message + '）——不影响，只是会去上层找包');
  }
}

// 2. bundles 只留 base + headless
const pkgPath = path.join(dst, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.name = name;
const kept = (pkg.dsh?.profile?.bundles || []).filter((b) => KEEP.includes(b));
pkg.dsh = pkg.dsh || {};
pkg.dsh.profile = pkg.dsh.profile || {};
pkg.dsh.profile.bundles = kept.length ? kept : KEEP.slice();
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

// 3. patch 只留 credentials
fs.writeFileSync(path.join(dst, 'cordis.patch.yml'), PATCH);

console.log(`好了：${dst}`);
console.log(`  bundles = ${pkg.dsh.profile.bundles.join(', ')}`);
console.log('');
console.log('接下来在 config.local.json 里加一行（放在 brain.headless 里）：');
console.log(`  "chatProfile": "${name}"`);
console.log('');
console.log('然后重启桥。之后闲聊的轮次会自动走轻装，要动手的轮次仍然用全量。');
