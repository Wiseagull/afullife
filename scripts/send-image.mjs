#!/usr/bin/env node
// 直连 OneBot HTTP 发一张图，不经过桥。
//
// 为什么要有这个：桥认「发图标记」的地方只有回话那条路（main.mjs 的 sendTurn）。
// 自由活动走的是 freeSay → sender.sendPrivate，裸发文本，[[img:…]] 和 Markdown 图片
// 都会被当成字发出去 —— 2026-10-29 下午连着两次「发了但他看不到」就是这么来的。
// 所以自由活动里要发图，有两条路：桥的 freeSay 补上图通路（要重启才生效），或者用这个脚本。
//
// 用法：
//   node scripts/send-image.mjs <图片路径> [--to=1363262841] [--group=927117959]
// 不给 --to 也不给 --group 就发给主人号。
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { sniffFile } from '../src/media/sniff.mjs';

const MAX_BYTES = 12 * 1024 * 1024;

const args = process.argv.slice(2);
const arg = (k, d = '') => {
  const hit = args.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};

const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('用法：node scripts/send-image.mjs <图片路径> [--to=主人号] [--group=群号]');
  process.exit(2);
}

const abs = path.resolve(file);
if (!fs.existsSync(abs)) {
  console.error(`没有这个文件：${abs}`);
  process.exit(2);
}
const size = fs.statSync(abs).size;
if (size > MAX_BYTES) {
  console.error(`图太大：${(size / 1048576).toFixed(1)}MB（上限 12MB）`);
  process.exit(2);
}
if (!sniffFile(abs)) {
  console.error(`不像图片，不发：${abs}`);
  process.exit(2);
}

const cfg = loadConfig({});
const { httpUrl, httpToken } = cfg.onebot || {};
if (!httpUrl) {
  console.error('配置里没有 OneBot 的 httpUrl（SnowLuma 那张配置没读到？跑 node scripts/doctor.mjs 看看）');
  process.exit(2);
}

const groupId = arg('group');
const userId = arg('to', groupId ? '' : String(cfg.owner?.userIds?.[0] ?? ''));
if (!groupId && !userId) {
  console.error('不知道发给谁：--to=<号> 或 --group=<群号>');
  process.exit(2);
}

const action = groupId ? 'send_group_msg' : 'send_private_msg';
const target = groupId ? { group_id: Number(groupId) } : { user_id: Number(userId) };
const message = [{ type: 'image', data: { file: `base64://${fs.readFileSync(abs).toString('base64')}` } }];

let res;
try {
  res = await fetch(`${String(httpUrl).replace(/\/+$/, '')}/${action}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(httpToken ? { Authorization: `Bearer ${httpToken}` } : {}),
    },
    body: JSON.stringify({ ...target, message }),
    signal: AbortSignal.timeout(60000),
  });
} catch (err) {
  console.error(`连不上 OneBot（${httpUrl}）：${err?.message ?? err}`);
  process.exit(1);
}

const text = await res.text();
let json = null;
try { json = JSON.parse(text); } catch { /* 下面统一报 */ }
if (!res.ok || !json) {
  console.error(`${action} HTTP ${res.status}：${text.slice(0, 300)}`);
  process.exit(1);
}
if (json.status === 'failed' || (json.retcode != null && json.retcode !== 0)) {
  console.error(`${action} 失败 retcode=${json.retcode}：${json.message || json.wording || text.slice(0, 300)}`);
  process.exit(1);
}

console.log(`发出去了：${groupId ? `群 ${groupId}` : `私聊 ${userId}`} ← ${path.basename(abs)}`
  + `（${(size / 1024).toFixed(0)}KB，message_id=${json.data?.message_id ?? '?'}）`);
