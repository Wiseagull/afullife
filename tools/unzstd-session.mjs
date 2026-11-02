#!/usr/bin/env node
// 解一份 DSH 会话记录（.jsonl.zstd）成明文，用来查「这一轮到底发生了什么」。
//
// 为什么要自己切帧：DSH 写会话是分多次追加的，文件里是**多帧** zstd 拼接。
// zlib.zstdDecompressSync(整个 buffer) 只解第一帧就停（实测 20 万字节的文件只出
// 184 字节的 session 头），看着像「这轮什么都没发生」——别被它骗了。
// 这里按帧头 magic 28 b5 2f fd 切开，一帧一帧解，再拼起来。
//
// 用法：
//   node tools/unzstd-session.mjs <session.v4.jsonl.zstd> [输出路径]
//   不给输出路径就打印到 stdout。
//
// 2026-10-28 用它查出来的事：记忆体检撞满 32768 输出上限，assistant 只吐了
// 76536 字的 reasoning、一个 JSON 都没有，turn/end.reason.kind = max-tokens。

import fs from 'node:fs';
import zlib from 'node:zlib';

const [src, dst] = process.argv.slice(2);
if (!src) {
  console.error('用法：node tools/unzstd-session.mjs <session.v4.jsonl.zstd> [输出路径]');
  process.exit(2);
}

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const raw = fs.readFileSync(src);

const starts = [];
for (let i = 0; i + 4 <= raw.length; i += 1) {
  if (raw[i] === MAGIC[0] && raw[i + 1] === MAGIC[1] && raw[i + 2] === MAGIC[2] && raw[i + 3] === MAGIC[3]) starts.push(i);
}
if (!starts.length) {
  console.error('这不是 zstd 文件（没找到帧头）');
  process.exit(1);
}

const parts = [];
let bad = 0;
for (let k = 0; k < starts.length; k += 1) {
  const end = k + 1 < starts.length ? starts[k + 1] : raw.length;
  try {
    parts.push(zlib.zstdDecompressSync(raw.subarray(starts[k], end)));
  } catch {
    bad += 1;                       // 一帧坏了只丢那一帧，别把整份记录废掉
  }
}

const out = Buffer.concat(parts);
if (dst) {
  fs.writeFileSync(dst, out);
  console.log(`帧 ${starts.length}（坏 ${bad}）→ ${out.length} 字节 → ${dst}`);
} else {
  process.stdout.write(out);
  if (bad) console.error(`\n（有 ${bad} 帧解不开，已跳过）`);
}
