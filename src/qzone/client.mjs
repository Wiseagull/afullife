/**
 * QQ 空间（说说）——OneBot 没有这个接口，得自己拼。
 *
 * 路数：QQ 的 cookie 已经在 SnowLuma 手里（它登着号），OneBot 有一个扩展接口
 * `get_cookies`（不是 OneBot 11 标准里的，SnowLuma / NapCat 这类实现都支持），
 * 拿 `user.qzone.qq.com` 域就能要到 skey / p_skey。有这两个再加上 g_tk，
 * 老的那套 taotao 接口就能读能写。
 *
 * 2026-10-23 实测（这台机器）：
 *   GET  emotion_cgi_msglist_v6   → code 0，读回真实说说（"百亿token......"）
 * 也就是说 cookie 与 g_tk 是对的，能读就能写。
 *
 * 注意：这是没写进任何文档的私有接口，QQ 那边随时可能改。所以：
 *   - 发失败只报错、不重试（重试容易连发两条）；
 *   - 能不能用取决于 OneBot 实现给不给 get_cookies——不给就明说。
 */

import fs from 'node:fs';
import path from 'node:path';

const QZONE_DOMAIN = 'user.qzone.qq.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** QQ 的 g_tk：把 skey 过一遍 djb2，取低 31 位。qzone 的老接口都认这个。 */
export function gtk(skey = '') {
  let h = 5381;
  for (let i = 0; i < skey.length; i += 1) h = ((h * 33) + skey.charCodeAt(i)) & 0xffffffff;
  return h & 0x7fffffff;
}

/** "a=1; b=2" → { a: '1', b: '2' } */
export function parseCookies(str = '') {
  const out = {};
  for (const part of String(str).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

/** 从 cookie 串里取出 uin（cookie 里的 uin 带 o 前缀：o3868196316） */
export function uinOf(cookies = {}, fallback = 0) {
  const raw = cookies.uin || cookies.p_uin || cookies.pt2gguin || '';
  const m = String(raw).match(/(\d{5,})/);
  return m ? Number(m[1]) : Number(fallback || 0);
}

/**
 * 向 OneBot 要一份 qzone 的 cookie。
 * @param {{call: (action: string, params?: object) => Promise<any>}} client 桥的 OneBot 客户端
 */
export async function fetchCookies(client, logger = () => {}) {
  if (!client || typeof client.call !== 'function') throw new Error('桥这边没有连 OneBot，拿不到 cookie');
  let res;
  try {
    res = await client.call('get_cookies', { domain: QZONE_DOMAIN });
  } catch (e) {
    throw new Error(`这个 OneBot 实现没给 get_cookies（${e.message}）——QQ 空间这条就发不了`);
  }
  const str = res && (res.cookies || (res.data && res.data.cookies));
  if (!str) throw new Error('get_cookies 没回 cookie——可能还没登录 QQ');
  const cookies = parseCookies(str);
  if (!cookies.skey && !cookies.p_skey) throw new Error('cookie 里没有 skey，写不进去（只能读）');
  logger('qzone', `拿到 cookie（uin ${uinOf(cookies)}，skey ${cookies.skey ? '有' : '无'}）`);
  return { cookies, raw: str, uin: uinOf(cookies), skey: cookies.skey || cookies.p_skey };
}

function headersFor(raw, uin) {
  return {
    Cookie: raw,
    Referer: `https://user.qzone.qq.com/${uin}`,
    Origin: 'https://user.qzone.qq.com',
    'User-Agent': UA,
  };
}

/** 读自己的说说（用来验 cookie 是不是真的对） */
export async function listFeeds({ raw, uin, skey, num = 5 } = {}) {
  const url = `https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6`
    + `?uin=${uin}&ftype=0&sort=0&pos=0&num=${num}&g_tk=${gtk(skey)}&code_version=1&format=json`;
  const r = await fetch(url, { headers: headersFor(raw, uin) });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`空间回了看不懂的东西（HTTP ${r.status}）：${text.slice(0, 120)}`); }
  if (Number(data.code) !== 0) throw new Error(`读说说失败：code ${data.code} ${data.message || ''}`.trim());
  return (data.msglist || []).map((m) => ({
    tid: m.tid,
    text: String(m.content || '').trim(),
    when: m.createTime,
    comments: m.cmtnum,
    likes: m.fwdnum,
  }));
}

/**
 * 先把图传到空间的图床，拿回一个 http 地址 —— 写进说说正文里就能显示。
 *
 * 这个接口（`up.qzone.qq.com/cgi-bin/upload/cgi_upload_image`）是老相册上传那一套，
 * 回包有时是 JSONP（`_Callback({...})`），所以取第一个 { 到最后一个 } 再解析。
 * 它不回 tid，也不产生任何公开内容——只是把字节放到腾讯的图床上，失败就没发出去。
 */
export async function uploadImage({ raw, uin, skey, filePath, logger = () => {} }) {
  if (!filePath) throw new Error('要传哪张图？得给路径');
  if (!fs.existsSync(filePath)) throw new Error(`找不到这张图：${filePath}`);
  const buf = fs.readFileSync(filePath);
  if (buf.length > 20 * 1024 * 1024) throw new Error(`图太大了（${Math.round(buf.length / 1048576)}MB），空间收不下`);
  const name = path.basename(filePath);
  const type = /\.png$/i.test(name) ? 'image/png'
    : /\.gif$/i.test(name) ? 'image/gif'
      : /\.webp$/i.test(name) ? 'image/webp'
        : 'image/jpeg';

  const form = new FormData();
  form.append('uploadtype', '1');
  form.append('batchid', String(Date.now()));
  form.append('httppost', '1');
  form.append('filename', new Blob([buf], { type }), name);
  form.append('file', new Blob([buf], { type }), name);

  const url = `https://up.qzone.qq.com/cgi-bin/upload/cgi_upload_image?g_tk=${gtk(skey)}`;
  const r = await fetch(url, { method: 'POST', headers: headersFor(raw, uin), body: form });
  const text = await r.text();
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  let data = null;
  if (a >= 0 && b > a) { try { data = JSON.parse(text.slice(a, b + 1)); } catch { /* 留给下面报错 */ } }
  if (!data) throw new Error(`图没传上去（HTTP ${r.status}）：${text.slice(0, 160)}`);
  const code = Number(data.ret ?? data.code ?? -1);
  if (code !== 0) throw new Error(`图没传上去：ret ${code} ${data.msg || data.message || ''}`.trim());
  const d = data.data || {};
  const picUrl = d.url || d.pic_url || '';
  if (!picUrl) throw new Error('图床没回地址，这条发不出去（回包缺 data.url）');
  logger('qzone', `图传上去了：${picUrl.slice(0, 80)}`);
  return { url: picUrl, picbo: d.picbo || d.pic_id || '', width: d.width, height: d.height };
}

/**
 * 发一条说说。
 * @returns {Promise<{tid?: string, text: string}>}
 */
export async function publish({ raw, uin, skey, text, images = [], logger = () => {} }) {
  const words = String(text || '').trim();
  if (!words && !images.length) throw new Error('发空的说说不合适');
  if (words.length > 1000) throw new Error(`太长了（${words.length} 字），说说的上限按一千字算`);

  // 配图：先一张张传上去，再拼进正文。空间那边认的是 <img src="…">，
  // 另外还要 richtype=1 + richval（图床给的 picbo），否则它只当普通文字。
  const pics = [];
  for (const f of images) pics.push(await uploadImage({ raw, uin, skey, filePath: f, logger }));
  const imgTags = pics.map((p) => `<img src="${p.url}"/>`).join('');
  const con = imgTags + words;

  const body = new URLSearchParams({
    syn_tweet_verson: '1',
    paramstr: '1',
    who: '1',
    con,
    feedversion: '1',
    ver: '1',
    ugc_right: '1',
    to_sign: '0',
    hostuin: String(uin),
    code_version: '1',
    format: 'json',
    qzreferrer: `https://user.qzone.qq.com/${uin}`,
  });
  if (pics.length) {
    body.set('richtype', '1');
    body.set('richval', pics.map((p) => p.picbo).filter(Boolean).join(','));
  }

  const url = `https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6?g_tk=${gtk(skey)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { ...headersFor(raw, uin), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const raw2 = await r.text();
  let data = null;
  try { data = JSON.parse(raw2); } catch { /* 有时候回 HTML */ }
  if (!data) throw new Error(`发说说失败（HTTP ${r.status}）：${raw2.slice(0, 160)}`);
  const okCode = Number(data.code ?? data.ret ?? -1);
  if (okCode !== 0) {
    const why = data.message || data.msg || '';
    throw new Error(`发说说失败：code ${okCode} ${why}`.trim());
  }
  logger('qzone', `发出去了${pics.length ? `（带 ${pics.length} 张图）` : ''}：${words.slice(0, 40)}`);
  return { tid: data.tid || '', text: words, images: pics.map((p) => p.url) };
}

/** 删一条说说（发错了能收拾） */
export async function removeFeed({ raw, uin, skey, tid }) {
  if (!tid) throw new Error('要删哪条？得给 tid');
  const body = new URLSearchParams({ hostuin: String(uin), tid, t1_source: '1', code_version: '1', format: 'json', qzreferrer: `https://user.qzone.qq.com/${uin}` });
  const url = `https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_delete_v6?g_tk=${gtk(skey)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { ...headersFor(raw, uin), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* ignore */ }
  if (!data || Number(data.code ?? -1) !== 0) throw new Error(`删不掉：${(data && data.message) || text.slice(0, 120)}`);
  return { ok: true };
}
