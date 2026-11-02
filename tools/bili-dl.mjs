// 从 B 站抓一条低清 mp4 到本地，给 vw.py / video_* 用。
// 用法: node tmp/bili-dl.mjs BV1GDZqY2EAd [输出路径]
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const bvid = process.argv[2];
const out = process.argv[3] || path.join('tmp', `${bvid}.mp4`);
if (!bvid) { console.error('用法: node tmp/bili-dl.mjs <BV号> [输出路径]'); process.exit(1); }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const H = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', 'Accept-Language': 'zh-CN,zh;q=0.9' };

const view = await (await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { headers: H })).json();
if (view.code !== 0) { console.error('view 失败:', view.code, view.message); process.exit(1); }
const { cid, title, pages } = view.data;
console.log('标题:', title);
console.log('分P:', pages.length, '时长:', view.data.duration, '秒');

const q = new URLSearchParams({ bvid, cid: String(cid), qn: '16', fnval: '0', platform: 'html5', high_quality: '1', fourk: '0' });
const play = await (await fetch(`https://api.bilibili.com/x/player/playurl?${q}`, { headers: H })).json();
if (play.code !== 0) { console.error('playurl 失败:', play.code, play.message); process.exit(1); }
const durl = play.data.durl || [];
console.log('清晰度:', play.data.quality, '段数:', durl.length, '格式:', durl[0] ? durl[0].url.slice(0, 60) : '无');
if (!durl.length) { console.error('没有 durl，可能是 DASH-only，需要 fnval=16 + 音频轨合并'); process.exit(1); }

const res = await fetch(durl[0].url, { headers: H });
if (!res.ok) { console.error('下载失败:', res.status); process.exit(1); }
const buf = Buffer.from(await res.arrayBuffer());
writeFileSync(out, buf);
console.log('已存:', out, (buf.length / 1048576).toFixed(1), 'MB');
