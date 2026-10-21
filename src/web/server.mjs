// 给 DSH 里那个设置面板用的本地 HTTP 接口。
//
// 只绑 127.0.0.1，只认带 `x-qad-ui: 1` 头的请求，且 Origin 必须是本机的
// DSH 页面（别的网页即使在本机跑，Origin 也对不上，挡掉 CSRF）。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ROOT, notebookDir } from '../config.mjs';
import { ensureSnowLuma } from '../snowluma/launch.mjs';
import { isPortOpen } from '../snowluma/runtime.mjs';
import { listToggleable, installPlugins, uninstallPlugins } from './plugins.mjs';
import { roomView } from '../memory/context.mjs';
import { HeadlessBrain } from '../brain/headless.mjs';
import { SELF_INSTRUCTION } from '../body/prompt.mjs';

const ORIGIN_OK = /^http:\/\/(127\.0\.0\.1|localhost):\d+$/;

/** 允许从面板改的配置路径。改不了的（要重启才算数的）会标出来。 */
const EDITABLE = [
  'group.enabled',
  'group.speakOnAt',
  'group.speakOnName',
  'group.names',
  'group.keywords',
  'group.social',
  'debounceMs',
  'ack',
  'send.split',
  'send.gapMs',
  'send.maxLen',
  'safety.auditReply',
  'freeTime',
  'owner.userIds',
  'memory.rooms',
  'sticker.style',
  'poke',
  'web.allowFullAccess',
];

/** 改了必须重启桥才生效的 */
const NEEDS_RESTART = ['debounceMs', 'owner.userIds'];

function getPath(obj, p) {
  return p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj, p, v) {
  const keys = p.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) {
    if (o[k] == null || typeof o[k] !== 'object') o[k] = {};
    o = o[k];
  }
  o[keys.at(-1)] = v;
}

/** 只挑白名单里的字段，建一个嵌套 patch */
function pickPatch(patch) {
  const out = {};
  let touched = [];
  for (const p of EDITABLE) {
    const v = getPath(patch, p);
    if (v !== undefined) {
      setPath(out, p, v);
      touched.push(p);
    }
  }
  return { patch: out, touched };
}

function json(res, code, body, origin) {
  const s = code === 204 ? '' : JSON.stringify(body ?? null);
  const headers = { 'cache-control': 'no-store' };
  if (s) {
    headers['content-type'] = 'application/json; charset=utf-8';
    headers['content-length'] = Buffer.byteLength(s);
  }
  if (origin) {
    headers['access-control-allow-origin'] = origin;
    headers['access-control-allow-headers'] = 'content-type, x-qad-ui';
    headers['access-control-allow-methods'] = 'GET, POST, PATCH, DELETE, OPTIONS';
    headers['access-control-max-age'] = '600';
  }
  res.writeHead(code, headers);
  res.end(s);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1 << 20) throw new Error('body too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * @param {object} deps
 * @param {object} deps.cfg       当前配置（会被就地改，改完热生效）
 * @param {object} deps.logger
 * @param {object} deps.notes
 * @param {object} deps.pending
 * @param {object} deps.events
 * @param {object} deps.sessions
 * @param {object} deps.router
 * @param {object} deps.gate
 * @param {object} deps.brain
 * @param {(ev: object) => void} [deps.onConfig]
 */
export function startWeb({ cfg, logger, notes, pending, events, sessions, router, gate, brain, roomNames, freeTime, stickerLib, onConfig }) {
  const conf = cfg.web || {};
  if (conf.enabled === false) return null;

  const port = Number(conf.port || 3220);
  // 人设住在项目里；工作区那几个名字是它们的硬链接（同一个文件，两个名字）
  const PERSONA_FILES = { core: 'core.md', group: 'group.md', self: 'self.md' };
  const personaPath = (which = 'core') => path.join(ROOT, 'persona', PERSONA_FILES[which] || 'core.md');
  const localFile = path.join(ROOT, 'config.local.json');

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const hasOrigin = Boolean(origin);
    const sameOrigin = hasOrigin && ORIGIN_OK.test(origin);

    // 浏览器一定会带 Origin；带了就必须是本机的 DSH 页面（挡 CSRF）。
    // 不带 Origin 的是本机程序（curl / DSH 宿主转发），放行。
    if (hasOrigin && !sameOrigin) return json(res, 403, { error: 'origin: only local DSH pages' });

    if (req.method === 'OPTIONS') return json(res, 204, null, origin);
    if (req.headers['x-qad-ui'] !== '1') return json(res, 403, { error: 'missing x-qad-ui' }, origin);

    const url = new URL(req.url, 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
    const [, area, id, action] = parts;

    try {
      // ── 状态 ──
      if (area === 'status' && req.method === 'GET') {
        const rooms = [...new Set(events.readRecent({ limit: 200 }).map((e) => e.room).filter(Boolean))];
        return json(res, 200, {
          ok: true,
          brain: brain.kind,
          rooms: rooms.map((r) => ({
            room: r,
            state: String(r).startsWith('group:') ? router.stateOf(r) : null,
            session: sessions.get(r),
          })),
          notes: notes.all().length,
          pending: pending.all().filter((p) => p.status !== 'closed').length,
          gate: gate && gate.stats ? gate.stats : null,
          configFile: localFile,
        }, origin);
      }

      // ── SnowLuma：没跑就拉起来 ──
      if (area === 'snowluma' && req.method === 'GET') {
        return json(res, 200, { ok: true, running: await isPortOpen(3001), url: 'http://127.0.0.1:5099/' }, origin);
      }
      if (area === 'snowluma' && id === 'up' && req.method === 'POST') {
        const r = await ensureSnowLuma({ cfg, logger: (tag, msg) => logger?.info?.(tag, msg) });
        return json(res, r.ok ? 200 : 500, { ...r, url: 'http://127.0.0.1:5099/' }, origin);
      }
      // ── 自由活动 ──
      if (area === 'free' && req.method === 'GET') {
        return json(res, 200, { ok: true, status: freeTime ? freeTime.status() : null }, origin);
      }
      if (area === 'free' && req.method === 'POST') {
        const body = await readBody(req);
        if (!freeTime) return json(res, 400, { error: '闸没接上' }, origin);
        const r = body?.action === 'stop' ? freeTime.stop() : freeTime.start({ minutes: Number(body?.minutes) || undefined });
        return json(res, r.ok ? 200 : 400, r, origin);
      }
      // ── 配置 ──
      if (area === 'config' && req.method === 'GET') {
        const out = {};
        for (const p of EDITABLE) setPath(out, p, getPath(cfg, p));
        return json(res, 200, { ok: true, config: out, editable: EDITABLE, needsRestart: NEEDS_RESTART }, origin);
      }

      if (area === 'config' && req.method === 'POST') {
        const body = await readBody(req);
        const { patch, touched } = pickPatch(body || {});
        if (!touched.length) return json(res, 400, { error: '没有可改的字段' }, origin);

        // 落盘：并进 config.local.json，别把别人写的字段冲掉
        let local = {};
        try { local = JSON.parse(fs.readFileSync(localFile, 'utf8')) || {}; } catch { local = {}; }
        for (const p of touched) setPath(local, p, getPath(patch, p));
        const tmp = `${localFile}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(local, null, 2), 'utf8');
        fs.renameSync(tmp, localFile);

        // 热生效：直接改内存里那一份
        for (const p of touched) setPath(cfg, p, getPath(patch, p));
        onConfig?.({ touched });

        const restart = touched.some((p) => NEEDS_RESTART.includes(p));
        logger?.info?.('web', `面板改了 ${touched.join(', ')}${restart ? '（要重启桥才生效）' : ''}`);
        return json(res, 200, { ok: true, touched, restartRequired: restart }, origin);
      }

      // ── 记忆条目 ──
      if (area === 'notes' && req.method === 'GET') {
        const room = url.searchParams.get('room');
        const all = notes.all().filter((n) => !room || n.room === room);
        return json(res, 200, { ok: true, notes: all }, origin);
      }

      if (area === 'notes' && req.method === 'POST' && !id) {
        const body = await readBody(req);
        if (!body?.text) return json(res, 400, { error: 'text 不能空' }, origin);
        const note = notes.add({
          kind: body.kind || '事实',
          text: String(body.text).slice(0, 500),
          room: body.room || null,
          weight: Number(body.weight) || 2,
          source: ['ui'],
        });
        return json(res, 200, { ok: true, note }, origin);
      }

      if (area === 'notes' && id) {
        if (req.method === 'DELETE') {
          notes.drop(id);
          return json(res, 200, { ok: true }, origin);
        }
        if (req.method === 'PATCH') {
          const body = await readBody(req);
          const patch = {};
          for (const k of ['text', 'kind', 'weight']) if (body?.[k] !== undefined) patch[k] = body[k];
          const note = notes.update(id, patch);
          return json(res, note ? 200 : 404, note ? { ok: true, note } : { error: '没有这条' }, origin);
        }
      }

      // ── 待确认 ──
      if (area === 'pending' && req.method === 'GET') {
        return json(res, 200, { ok: true, pending: pending.all() }, origin);
      }
      if (area === 'pending' && id && req.method === 'POST') {
        const body = await readBody(req);
        if (body?.action === 'close') {
          pending.close(id);
          return json(res, 200, { ok: true }, origin);
        }
        return json(res, 400, { error: 'action 只认 close' }, origin);
      }

      // ── 房间（跨房间记忆开关）──
      if (area === 'rooms' && req.method === 'GET') {
        const seen = new Set();
        for (const e of events.readRecent({ limit: 400 })) if (e.room) seen.add(e.room);
        for (const s of sessions.entries()) if (s.room) seen.add(s.room);
        for (const id of cfg.owner?.userIds || []) seen.add('private:' + id);
        const rooms = [...seen].sort().map((room) => ({
          room,
          name: roomNames?.nameOf(room) || null,
          ...roomView(cfg, room),
          session: sessions.get(room),
        }));
        return json(res, 200, { ok: true, rooms }, origin);
      }

      if (area === 'rooms' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body?.room) return json(res, 400, { error: '要指定房间' }, origin);
        const cur = roomView(cfg, body.room);
        const next = {
          read: body.read === undefined ? cur.read : !!body.read,
          share: body.share === undefined ? cur.share : !!body.share,
        };
        cfg.memory = cfg.memory || {};
        cfg.memory.rooms = cfg.memory.rooms || {};
        cfg.memory.rooms[body.room] = next;

        let local = {};
        try { local = JSON.parse(fs.readFileSync(localFile, 'utf8')) || {}; } catch { local = {}; }
        setPath(local, 'memory.rooms', cfg.memory.rooms);
        const tmp = `${localFile}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(local, null, 2), 'utf8');
        fs.renameSync(tmp, localFile);
        logger?.info?.('web', `房间 ${body.room}：能看别处=${next.read} 能让别处看=${next.share}`);
        return json(res, 200, { ok: true, room: body.room, ...next }, origin);
      }

      // ── 小本本 ──
      if (area === 'notebook' && req.method === 'GET' && !id) {
        const dir = notebookDir(cfg);
        const files = [];
        const walk = (d) => {
          let ents = [];
          try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
          for (const e of ents) {
            const full = path.join(d, e.name);
            if (e.isDirectory()) walk(full);
            else if (e.isFile() && e.name !== '.gitkeep') {
              const st = fs.statSync(full);
              files.push({
                path: path.relative(dir, full).replace(/\\/g, '/'),
                bytes: st.size,
                mtime: st.mtimeMs,
              });
            }
          }
        };
        walk(dir);
        files.sort((a, b) => b.mtime - a.mtime);
        return json(res, 200, { ok: true, dir, limitMb: cfg.notebook?.limitMb || 20480, files }, origin);
      }

      if (area === 'notebook' && id === 'file') {
        const dir = notebookDir(cfg);
        const target = (p) => {
          const abs = path.resolve(dir, String(p || ''));
          if (!abs.startsWith(path.resolve(dir))) throw new Error('只能读小本本里的文件');
          return abs;
        };
        if (req.method === 'GET') {
          const rel = url.searchParams.get('path');
          if (!rel) return json(res, 400, { error: '要指定 path' }, origin);
          const abs = target(rel);
          if (!fs.existsSync(abs)) return json(res, 404, { error: '没有这一页' }, origin);
          return json(res, 200, { ok: true, path: rel, text: fs.readFileSync(abs, 'utf8') }, origin);
        }
        if (req.method === 'POST') {
          // 小本本是她的私房话：面板只给看，不给改（要改请她自己动手）
          return json(res, 403, { error: '小本本只读，界面不能改' }, origin);
        }
      }

      // ── 事件流 ──
      if (area === 'events' && req.method === 'GET') {
        const limit = Math.min(200, Number(url.searchParams.get('limit')) || 40);
        const room = url.searchParams.get('room');
        return json(res, 200, { ok: true, events: events.readRecent({ room, limit }) }, origin);
      }

      // ── 会话 ──
      if (area === 'sessions' && req.method === 'GET') {
        return json(res, 200, { ok: true, sessions: sessions.entries() }, origin);
      }
      if (area === 'sessions' && action === 'reset' && req.method === 'POST') {
        const body = await readBody(req);
        const room = body?.room;
        if (!room) return json(res, 400, { error: '要指定房间' }, origin);
        sessions.clear(room);
        return json(res, 200, { ok: true }, origin);
      }

      // ── 工具（把界面里装着的插件搬给无界面的她，可热装卸） ──
      if (area === 'tools' && req.method === 'GET' && !id) {
        const d = listToggleable('desktop', brain?.cfg?.profile || 'headless');
        return json(res, 200, { ok: true, ...d }, origin);
      }

      if (area === 'tools' && id === 'toggle' && req.method === 'POST') {
        const body = await readBody(req);
        const name = String(body?.name || '');
        const on = body?.on === true;
        if (!name) return json(res, 400, { error: '没给包名' }, origin);
        const opts = {
          from: 'desktop',
          to: brain?.cfg?.profile || 'headless',
          cli: brain?.cfg?.cli,
          runtime: brain?.cfg?.node,
          logger,
        };
        logger?.info?.('tools', `${on ? '装' : '卸'} ${name}`);
        const r = on
          ? await installPlugins([name], opts)
          : await uninstallPlugins([name], opts);
        return json(res, r.ok ? 200 : 500, r, origin);
      }

      // ── 人设 ──
      // core = 核心卡（每轮必读）/ group = 群聊手册（只在群里补）/ self = 我自己写的部分
      if (area === 'persona' && req.method === 'GET') {
        const which = String(url.searchParams.get('file') || 'core');
        if (!PERSONA_FILES[which]) return json(res, 400, { error: 'file 只认 core / group / self' }, origin);
        const file = personaPath(which);
        let text = '';
        let st = null;
        try { text = fs.readFileSync(file, 'utf8'); st = fs.statSync(file); } catch { /* 还没有就空着 */ }
        return json(res, 200, {
          ok: true, file: which, path: file, text,
          bytes: st?.size ?? 0, mtime: st?.mtimeMs ?? 0,
          editable: which !== 'self', // self 要高级权限才能动
        }, origin);
      }

      if (area === 'persona' && req.method === 'POST') {
        const body = await readBody(req);
        const which = String(body?.file || 'core');
        if (!PERSONA_FILES[which]) return json(res, 400, { error: 'file 只认 core / group / self' }, origin);
        if (which === 'self' && body?.advanced !== true) {
          return json(res, 403, { error: '「我自己的部分」要开高级权限才让改' }, origin);
        }
        const text = String(body?.text ?? '');
        if (text.trim().length < 50) return json(res, 400, { error: '太短了，像是误删，没敢写' }, origin);
        const file = personaPath(which);
        const dir = path.join(ROOT, 'data', 'persona-backups');
        fs.mkdirSync(dir, { recursive: true });
        if (fs.existsSync(file)) {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          fs.cpSync(file, path.join(dir, `${which}-${stamp}.md`));
        }
        fs.writeFileSync(file, text, 'utf8');
        logger?.info?.('web', `人设 ${which} 已更新（${Buffer.byteLength(text)} 字节，旧版已备份）`);
        return json(res, 200, { ok: true, file: which, bytes: Buffer.byteLength(text) }, origin);
      }

      // ── 试一试：拿这份人设真的说一句话 ──
      // 默认沙箱里跑（能读能写项目内，出不去）；只有「高级权限」+「真的去做」
      // 同时打开，才给它一套完整权限 —— 那是主人自己点开的门。
      if (area === 'try' && req.method === 'POST') {
        const body = await readBody(req);
        const text = String(body?.text || '').trim();
        if (!text) return json(res, 400, { error: '要说点什么' }, origin);
        const which = PERSONA_FILES[body?.file] ? body.file : 'self';
        let persona = '';
        try { persona = fs.readFileSync(personaPath(which), 'utf8'); } catch { persona = ''; }
        const full = body?.full === true && cfg.web?.allowFullAccess === true;
        const prompt = [persona, SELF_INSTRUCTION, `他跟你说：${text}`].filter(Boolean).join('\n\n');
        const b = full
          ? new HeadlessBrain({ ...cfg.brain.headless, permissionMode: 'danger-full-access', logger: null })
          : brain;
        const t0 = Date.now();
        const r = await b.run({ prompt });
        return json(res, 200, {
          ok: true,
          text: r?.text || '',
          ms: Date.now() - t0,
          brain: full ? 'full' : 'normal',
        }, origin);
      }

      // ── 表情库：只留一个写者（桥自己）──
      // scripts/sticker-lib.mjs 也走这里；桥没开时它才退回直接写文件——那时它是唯一写者，安全。
      // 不这么做的话两边各拿一份内存、整份写回，谁最后写谁赢（2026-10-21 实测发现的丢条目）。
      if (area === 'stickers') {
        if (!stickerLib) return json(res, 503, { error: '桥这边没接表情库' }, origin);

        if (req.method === 'GET') {
          return json(res, 200, { ok: true, stats: stickerLib.stats(), items: stickerLib.all() }, origin);
        }

        if (req.method === 'POST') {
          const body = await readBody(req);
          const op = String(body?.op || '');

          if (op === 'add') {
            const src = String(body?.src || '').trim();
            if (!src) return json(res, 400, { error: '要 src（图片路径）' }, origin);
            const r = stickerLib.add({
              src,
              tags: body?.tags || [],
              when: String(body?.when || ''),
              ctx: String(body?.ctx || ''),
              from: String(body?.from || ''),
              room: body?.room ?? null,
            });
            logger?.info?.('sticker', `${r.dup ? '已经在库里' : '收下'} ${r.item?.id}`);
            return json(res, 200, { ok: true, item: r.item, dup: r.dup }, origin);
          }

          if (op === 'update') {
            const it = stickerLib.update(String(body?.id || ''), {
              ...(body?.tags !== undefined ? { tags: body.tags } : {}),
              ...(body?.when !== undefined ? { when: String(body.when) } : {}),
              ...(body?.from !== undefined ? { from: String(body.from) } : {}),
              ...(body?.used !== undefined ? { used: Number(body.used) } : {}),
            });
            return json(res, it ? 200 : 404, it ? { ok: true, item: it } : { error: '没有这个 id' }, origin);
          }

          if (op === 'use') {
            const it = stickerLib.markUsed(String(body?.id || ''));
            return json(res, it ? 200 : 404, it ? { ok: true, item: it } : { error: '没有这个 id' }, origin);
          }

          if (op === 'approve') {
            const it = stickerLib.approve(String(body?.id || ''), {
              tags: body?.tags || [],
              when: String(body?.when || ''),
            });
            return json(res, it ? 200 : 404, it ? { ok: true, item: it } : { error: '没有这个 id' }, origin);
          }

          if (op === 'reject') {
            const ok = stickerLib.reject(String(body?.id || ''), String(body?.reason || ''));
            return json(res, ok ? 200 : 404, { ok }, origin);
          }

          if (op === 'drop') {
            const ok = stickerLib.drop(String(body?.id || ''));
            return json(res, ok ? 200 : 404, { ok }, origin);
          }

          if (op === 'prune') {
            const r = stickerLib.prune(
              {
                maxCount: Number(body?.maxCount ?? 300),
                maxMb: Number(body?.maxMb ?? 200),
                dry: body?.dry === true,
              },
              (tag, msg) => logger?.info?.(tag, msg),
            );
            return json(res, 200, { ok: true, ...r }, origin);
          }

          return json(res, 400, { error: `不认识的 op：${op || '(空)'}` }, origin);
        }
      }

      return json(res, 404, { error: `没有 ${req.method} ${url.pathname}` }, origin);
    } catch (err) {
      logger?.warn?.('web', `${req.method} ${url.pathname} 出错：${err?.message ?? err}`);
      return json(res, 500, { error: String(err?.message ?? err) }, origin);
    }
  });

  server.on('error', (err) => logger?.warn?.('web', `监听失败：${err?.message ?? err}`));
  server.listen(port, '127.0.0.1', () => {
    logger?.info?.('web', `面板接口 http://127.0.0.1:${port}/api/status`);
  });
  return server;
}
