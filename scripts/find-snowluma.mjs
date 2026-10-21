#!/usr/bin/env node
// 帮你把 SnowLuma 装在哪告诉项目。
//
// 用法：
//   node scripts/find-snowluma.mjs                    # 看现在能不能自动找到
//   node scripts/find-snowluma.mjs "D:/soft/SnowLuma" # 告诉它装在哪，验证通过就写进配置
//
// 做了什么：验证那个目录里有没有 index.mjs 和 config/onebot_*.json，
// 然后往 config.local.json 里写 snowluma.dir（以及 onebot.uin，如果有多个号）。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/config.mjs';
import { findDir, readOneBotConfig } from '../src/snowluma/onebot-config.mjs';

const CONFIG = path.join(ROOT, 'config.local.json');

function readLocal() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  } catch {
    return {};
  }
}

function writeLocal(patch) {
  const cur = readLocal();
  const next = { ...cur, ...patch };
  fs.writeFileSync(CONFIG, JSON.stringify(next, null, 2) + '\n', 'utf8');
}

function report(dir) {
  const r = readOneBotConfig({ dir });
  if (!r.ok) {
    console.log(`✗ ${dir}`);
    console.log(`  ${r.reason}`);
    if (r.candidates?.length) console.log(`  可选的号：${r.candidates.join('、')}`);
    return false;
  }
  console.log('✓ 找到 SnowLuma 了');
  console.log(`  目录：${r.dir}`);
  console.log(`  号码：${r.uin || '(没认出来)'}`);
  console.log(`  配置：${path.basename(r.file)}`);
  console.log(`  OneBot：${r.wsUrl}  /  ${r.httpUrl}`);
  console.log(`  令牌：ws ${r.accessToken ? r.accessToken.length + ' 字符' : '缺'}，http ${r.httpToken ? r.httpToken.length + ' 字符' : '缺'}`);
  return true;
}

const arg = process.argv[2];

if (!arg) {
  const local = readLocal();
  const dir = findDir({ configured: local?.snowluma?.dir || '', root: ROOT });
  if (!dir) {
    console.log('✗ 没找到 SnowLuma');
    console.log('');
    console.log('两条路，选一条：');
    console.log('  1) 告诉它装在哪：node scripts/find-snowluma.mjs "D:/你的/SnowLuma"');
    console.log('  2) 把 SnowLuma 整个目录放到 vendor/snowluma/，再跑一次这个命令');
    console.log('');
    console.log('都没有的话，先去装 SnowLuma：https://github.com/SnowLuma/SnowLuma');
    console.log('装好打开 http://localhost:5099（初始密码在它的启动日志里），在 WebUI 里接入 QQ，');
    console.log('再把 OneBot 的 WebSocket（默认 3001）和 HTTP（默认 3000）服务开着，然后回来跑这个命令。');
    process.exit(1);
  }
  if (!report(dir)) process.exit(1);
  if (readLocal()?.snowluma?.dir !== dir) {
    writeLocal({ snowluma: { ...(readLocal().snowluma || {}), dir } });
    console.log(`\n已写进 config.local.json：snowluma.dir = ${dir}`);
  } else {
    console.log('\nconfig.local.json 里已经指对了，不用改。');
  }
  process.exit(0);
}

// 指定了路径：验证 + 写入
const dir = path.resolve(arg.replace(/^["']|["']$/g, ''));
if (!fs.existsSync(dir)) {
  console.log(`✗ 这个目录不存在：${dir}`);
  process.exit(1);
}
if (!report(dir)) process.exit(1);

const local = readLocal();
const sl = { ...(local.snowluma || {}), dir };
const r = readOneBotConfig({ dir });
const patch = { snowluma: sl };
if (r.ok && r.uin) {
  // 只有一个号就直接定下来，多个号就让人自己选（写成 onebot.uin）
  const many = (r.candidates || []).length > 1;
  if (!many) patch.onebot = { ...(local.onebot || {}), uin: String(r.uin) };
  else console.log(`\n这个 SnowLuma 登过好几个号（${r.candidates.join('、')}），默认取最近改过的那份。想指定就在 config.local.json 里写 "onebot": { "uin": "你的号" }。`);
}
writeLocal(patch);
console.log(`\n已写进 config.local.json：snowluma.dir = ${dir}`);
console.log('下一步：node src/main.mjs（或者打开 DSH，桥会自己起）');
