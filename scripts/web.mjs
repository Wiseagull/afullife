#!/usr/bin/env node
// 抓网页/接口，吐成能读的文字。
//
// 为什么要它：web_fetch 在本机一律报「resolves to a non-public IP address」——
// DNS 走的是 Clash 的 fake-ip（198.18.0.0/15），工具把这一段当内网就拒了，跟站点没关系。
// Node 的 fetch 走 TUN，实测正常。bsk 那条是另一回事：没连浏览器就起不来。
//
// 用法：
//   node scripts/web.mjs <url>                 抓正文（HTML 去标签、压空行，默认 8000 字）
//   node scripts/web.mjs <url> --max=20000     多要点
//   node scripts/web.mjs <url> --raw           原样输出（调试用、或本来就是纯文本）
//   node scripts/web.mjs <url> --from=汉堡     从第一次出现这个词的地方开始（跳过导航菜单）
//   node scripts/web.mjs <url> --grep=味道     只留提到它的行，前后各带一行上下文
//
// 局限：只认静态 HTML 和 JSON。靠 JS 渲染的站（B 站、微博）抓回来是验证码或空壳，
// 那种还是得等有浏览器的 bsk。

import { writeSync } from 'node:fs';

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
  console.error('用法: node scripts/web.mjs <url> [--max=8000] [--raw]');
  process.exit(1);
}

const url = args[0];
const raw = args.includes('--raw');
const maxArg = args.find((a) => a.startsWith('--max='));
const max = maxArg ? Number(maxArg.split('=')[1]) || 8000 : 8000;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', copy: '©', reg: '®' };
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => named[n.toLowerCase()] ?? m);
}

function htmlToText(html) {
  let s = html.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style|noscript|svg|head)[^>]*>[\s\S]*?<\/\1>/gi, '');
  // 块级元素断行，行内元素只留一格空格
  s = s.replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|table|ul|ol|dl|dd|dt)>/gi, '\n');
  s = s.replace(/<(br|hr)\s*\/?>/gi, '\n');
  s = s.replace(/<\/t[dh]>/gi, '\t');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  s = s.replace(/[ \t\u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

try {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
    redirect: 'follow',
    signal: AbortSignal.timeout(25000),
  });
  const type = res.headers.get('content-type') || '';
  const body = await res.text();
  let out;
  if (raw || /json|text\/plain|xml/.test(type)) {
    if (/json/.test(type)) {
      try { out = JSON.stringify(JSON.parse(body), null, 2); } catch { out = body; }
    } else out = body;
  } else {
    out = htmlToText(body);
  }
  const fromArg = args.find((a) => a.startsWith('--from='));
  if (fromArg) {
    const key = fromArg.slice('--from='.length);
    const at = out.indexOf(key);
    if (at > 0) out = out.slice(at);
    else if (at < 0) console.error(`（没找到「${key}」，返回全文）`);
  }

  const grepArg = args.find((a) => a.startsWith('--grep='));
  if (grepArg) {
    const key = grepArg.slice('--grep='.length);
    const lines = out.split('\n');
    const keep = new Set();
    lines.forEach((ln, i) => {
      if (ln.includes(key)) for (let d = -1; d <= 1; d += 1) if (lines[i + d] !== undefined) keep.add(i + d);
    });
    if (keep.size === 0) console.error(`（全文没有「${key}」）`);
    out = [...keep].sort((a, b) => a - b).map((i) => lines[i]).join('\n');
  }

  const notes = [`URL: ${url}`, `status: ${res.status} ${res.statusText}`, `type: ${type}`, `chars: ${out.length}`];
  if (out.length > max) {
    out = out.slice(0, max);
    notes.push(`已截断到 ${max} 字（--max= 可加）`);
  }
  writeSync(1, notes.join('\n') + '\n\n' + out + '\n');
} catch (e) {
  console.error(`抓取失败: ${e.message}`);
  process.exit(1);
}
