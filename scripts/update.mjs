#!/usr/bin/env node
// 更新：把项目拉到最新，再自检一遍，告诉你还要做什么。
//
//   node scripts/update.mjs             # git 仓库就 git pull，否则教你怎么手动更新
//   node scripts/update.mjs --check     # 只看有没有新版，不改任何东西
//
// 它**不碰**你的东西：data/、persona/、notebook/、config.local.json 一个字节都不动
// （这些本来就在 .gitignore 里，git pull 也不会碰）。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const checkOnly = process.argv.includes('--check');

const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, ...opts });

const say = (s = '') => console.log(s);
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

// 1) 是不是 git 仓库
const isGit = fs.existsSync(path.join(ROOT, '.git'));
if (!isGit) {
  say('这不是一个 git 仓库（多半是解压的 zip），所以没法自动更新。');
  say('');
  say(bold('手动更新三步：'));
  say('  1. 下载最新版的 a-full-life.zip，解压到别的地方');
  say('  2. 把旧目录里这几样复制过去（它们是她的东西，新版本里没有）：');
  say('       data/     她的记忆、事件、表情库、会话');
  say('       persona/  三层人设（你要是改过）');
  say('       notebook/ 她的小本本');
  say('       config.local.json  你的配置');
  say('  3. 用新目录替换旧的，重启 DSH');
  say('');
  say('自检可以随时跑：node scripts/selftest.mjs');
  process.exit(0);
}

// 2) 看看远端有没有新的
const before = run('git', ['rev-parse', 'HEAD']).stdout?.trim() || '';
const remote = run('git', ['remote', 'get-url', 'origin']);
if (remote.status !== 0) {
  say('这个仓库没有配 origin，拉不了。先加一个远端：');
  say('  git remote add origin https://github.com/<你 fork 的地址>.git');
  process.exit(1);
}
say(`远端：${remote.stdout.trim()}`);

const fetch = run('git', ['fetch', '--quiet', 'origin']);
if (fetch.status !== 0) {
  say('拉取失败：');
  say((fetch.stderr || fetch.stdout || '').trim().split('\n').slice(-3).join('\n'));
  process.exit(1);
}

const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).stdout?.trim() || 'main';
const behind = run('git', ['rev-list', '--count', `HEAD..origin/${branch}`]).stdout?.trim() || '0';
const changed = run('git', ['diff', '--name-only', `HEAD..origin/${branch}`]).stdout?.trim().split('\n').filter(Boolean);

if (behind === '0') {
  say('已经是最新的，没有要更新的东西。');
  process.exit(0);
}

say(`\n有 ${behind} 个新提交，动了这些文件：`);
for (const f of changed.slice(0, 20)) say(`  ${f}`);
if (changed.length > 20) say(`  …… 还有 ${changed.length - 20} 个`);

if (checkOnly) {
  say('\n（--check：只看不改。要真更新就去掉这个参数再跑一次）');
  process.exit(0);
}

// 3) 真更新：只快进，冲突就停
say('\n开始更新…');
const pull = run('git', ['pull', '--ff-only', 'origin', branch]);
if (pull.status !== 0) {
  say(bold('没能自动更新（本地有改动或者分叉了）。'));
  say((pull.stderr || pull.stdout || '').trim().split('\n').slice(-5).join('\n'));
  say('');
  say('两个办法：');
  say('  · 你有自己的改动 → git stash && git pull --ff-only && git stash pop');
  say('  · 干脆不要本地改动 → git checkout . && git pull --ff-only');
  process.exit(1);
}
const after = run('git', ['rev-parse', 'HEAD']).stdout?.trim() || '';
say(`更新完成：${before.slice(0, 7)} → ${after.slice(0, 7)}`);

// 4) 自检（更新完第一时间知道有没有坏）
say('\n跑一遍自检…');
const test = run(process.execPath, ['scripts/selftest.mjs']);
const out = (test.stdout || '') + (test.stderr || '');
say(out.trim().split('\n').slice(-3).join('\n'));
if (test.status !== 0) {
  say(bold('\n自检没过。别急着用，先看上面哪里不对；'));
  say('实在不行 git reset --hard ' + before.slice(0, 7) + ' 回到更新前。');
  process.exit(1);
}

// 5) 提示还要做什么
const touched = changed.some((f) => f.startsWith('plugin/'));
say('');
say(bold('接下来要做的事：'));
if (touched) {
  say('  · plugin/ 里的东西变了 → **把 DSH 完全关掉再打开**（宿主插件不会热更新）');
} else {
  say('  · 只改了桥的代码 → 点面板上的「重启桥」，或者重开 DSH');
}
say('  · 只改了界面（plugin/client.js，没有 touched 也会提醒你）→ 刷新一下浏览器页面就够');
say('  · data/ persona/ notebook/ 不会被这次更新碰到');
