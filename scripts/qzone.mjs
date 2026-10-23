#!/usr/bin/env node
// QQ 空间（说说）——她自己用的命令行。
//
// 用法：
//   node scripts/qzone.mjs list [--num=5]        看她自己空间里最近说了什么
//   node scripts/qzone.mjs post "一句话"          发一条说说
//   node scripts/qzone.mjs post "一句话"                       发一条（只发文字：配图那条路没通）
//   node scripts/qzone.mjs delete <tid>          删一条（发错了收拾）
//   node scripts/qzone.mjs check                 只验能不能拿到 cookie
//
// 为什么要绕桥走 HTTP：cookie 在桥连着的那个 OneBot 手里，脚本自己拿不到；
// 而且「谁能发」只该有一个出口，不然闸和审计就会各看一边（表情库那次就是这么出的事）。
//
// 默认是关着的——config.local.json 里 qzone.enabled 改成 true 才能发。
// 发出去的东西是公开的、删不干净（有人截图/转发就收不回），所以别当草稿箱用。

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/config.mjs';
import { loadConfig } from '../src/config.mjs';

const cfg = loadConfig();
const PORT = Number(process.env.QAD_WEB_PORT || cfg.web?.port || 3220);
const TOKEN = (() => {
  try {
    return fs.readFileSync(path.join(ROOT, 'data', 'web-token'), 'utf8').trim();
  } catch {
    return '';
  }
})();

async function api(method, payload) {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/qzone`, {
    method,
    headers: { 'content-type': 'application/json', 'x-qad-ui': '1', 'x-qad-token': TOKEN },
    ...(method === 'GET' ? {} : { body: JSON.stringify(payload || {}) }),
    signal: AbortSignal.timeout(25000),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* keep null */ }
  if (!res.ok) throw new Error((data && (data.error || data.message)) || `HTTP ${res.status}`);
  return data;
}

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name, dflt = '') => {
  const hit = rest.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const words = rest.filter((a) => !a.startsWith('--'));

try {
  if (cmd === 'list') {
    const num = Number(flag('num', '5')) || 5;
    const r = await api('GET');
    console.log(`${r.feeds.length} 条（uin ${r.uin}）：`);
    for (const f of r.feeds.slice(0, num)) console.log(` - tid=${f.tid || '?'}  ${f.text.slice(0, 60)}`);
  } else if (cmd === 'post') {
    const text = words.join(' ').trim();
    const images = flag('img', '').split(',').map((s) => s.trim()).filter(Boolean);
    if (images.length) throw new Error('现在只能发文字：空间那边的图床要一个已存在的相册，这个号没建。');
    if (!text) throw new Error('发什么？把要说的话写在后面');
    const r = await api('POST', { op: 'post', text, images });
    console.log(`发出去了${r.tid ? `（tid=${r.tid}）` : ''}${r.images && r.images.length ? `，带 ${r.images.length} 张图` : ''}：${r.text}`);
    console.log('发错了能删：node scripts/qzone.mjs delete <tid>');
  } else if (cmd === 'delete') {
    const tid = words[0];
    if (!tid) throw new Error('要删哪条？给 tid（list 能看到）');
    await api('POST', { op: 'delete', tid });
    console.log(`删掉了 ${tid}`);
  } else if (cmd === 'check') {
    const r = await api('GET');
    console.log(`能读（uin ${r.uin}），最近一条：${(r.feeds[0] && r.feeds[0].text.slice(0, 40)) || '（空）'}`);
  } else {
    console.log('用法：');
    console.log('  node scripts/qzone.mjs list [--num=5]');
    console.log('  node scripts/qzone.mjs post "一句话"');
    console.log('  node scripts/qzone.mjs delete <tid>');
    console.log('  node scripts/qzone.mjs check');
  }
} catch (e) {
  console.error(`不行：${e.message}`);
  if (/还没开/.test(e.message)) console.error('（把 config.local.json 里 qzone.enabled 改成 true，桥会马上认）');
  process.exit(1);
}
