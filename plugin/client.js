window.__ModuleLoader__.load({
  id: 'afullife-panel',
  factory: (require) => {
    var module = { exports: {} };
    // 这段是 DSH 的模块包装协议要的样子，exports 由 loader 消费
    // eslint-disable-next-line no-unused-vars
    var exports = module.exports;
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;

    // 桥的本地接口。桥没开的时候这里会连不上，面板得自己说清楚。
    const API = '/qad'; // 同源：宿主把 /qad 转给桥，绕开页面的 CSP

    async function api(path, opts) {
      const options = opts || {};
      let res;
      try {
        res = await fetch(API + path, {
          ...options,
          headers: Object.assign(
            { 'x-qad-ui': '1', 'content-type': 'application/json' },
            options.headers || {},
          ),
        });
      } catch (err) {
        throw new Error('连不上桥（' + (err && err.message ? err.message : err) + '）—— 先把它起来：node src/main.mjs');
      }
      const text = await res.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = { error: text };
      }
      if (!res.ok) throw new Error((body && body.error) || 'HTTP ' + res.status);
      return body;
    }

    const S = {
      wrap: { padding: '4px 2px', fontSize: 13, lineHeight: 1.6 },
      tabs: { display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' },
      tab: (on) => ({
        padding: '4px 12px',
        borderRadius: 999,
        border: '1px solid ' + (on ? 'var(--dsh-color-accent, #4c8dff)' : 'rgba(128,128,128,.35)'),
        background: on ? 'var(--dsh-color-accent, #4c8dff)' : 'transparent',
        color: on ? '#fff' : 'inherit',
        cursor: 'pointer',
        fontSize: 12,
      }),
      row: { display: 'flex', alignItems: 'center', gap: 10, margin: '7px 0', flexWrap: 'wrap' },
      label: { minWidth: 116, opacity: 0.75 },
      hint: { fontSize: 11, opacity: 0.55 },
      input: {
        padding: '4px 8px',
        borderRadius: 6,
        border: '1px solid rgba(128,128,128,.35)',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12,
        minWidth: 90,
      },
      area: {
        width: '100%',
        minHeight: 62,
        padding: '6px 8px',
        borderRadius: 6,
        border: '1px solid rgba(128,128,128,.35)',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12,
        fontFamily: 'inherit',
        resize: 'vertical',
      },
      card: {
        border: '1px solid rgba(128,128,128,.22)',
        borderRadius: 8,
        padding: '10px 12px',
        marginBottom: 10,
      },
      btn: (primary) => ({
        padding: '5px 14px',
        borderRadius: 6,
        border: '1px solid ' + (primary ? 'var(--dsh-color-accent, #4c8dff)' : 'rgba(128,128,128,.4)'),
        background: primary ? 'var(--dsh-color-accent, #4c8dff)' : 'transparent',
        color: primary ? '#fff' : 'inherit',
        cursor: 'pointer',
        fontSize: 12,
      }),
      err: { color: '#e5534b', fontSize: 12, margin: '8px 0' },
      ok: { color: '#2da44e', fontSize: 12, margin: '8px 0' },
      item: {
        borderTop: '1px solid rgba(128,128,128,.14)',
        padding: '7px 0',
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
      },
      tiny: { fontSize: 11, opacity: 0.55 },
    };

    function Row(props) {
      return h('div', { style: S.row }, h('span', { style: S.label }, props.label), props.children);
    }

    function Toggle(props) {
      return h(
        'label',
        { style: { display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' } },
        h('input', {
          type: 'checkbox',
          checked: !!props.value,
          onChange: (e) => props.onChange(e.target.checked),
        }),
        props.text ? h('span', { style: S.tiny }, props.text) : null,
      );
    }

    function Num(props) {
      return h('input', {
        type: 'number',
        value: props.value,
        step: props.step || 1,
        onChange: (e) => props.onChange(e.target.value),
        style: Object.assign({}, S.input, { width: 96, minWidth: 96 }),
      });
    }

    // ── 群聊 ────────────────────────────────────────────────────────────
    function GroupTab(props) {
      const cfg = props.cfg;
      const set = props.set;

      const setIn = (path, value) => {
        const next = JSON.parse(JSON.stringify(cfg));
        const keys = path.split('.');
        let o = next;
        for (const k of keys.slice(0, -1)) {
          if (!o[k] || typeof o[k] !== 'object') o[k] = {};
          o = o[k];
        }
        o[keys[keys.length - 1]] = value;
        set(next);
      };
      const g = cfg.group || {};
      const social = g.social || {};
      const send = cfg.send || {};
      const ack = cfg.ack || {};
      const poke = cfg.poke || { enabled: true, text: 0.5, poke: 0.3, silent: 0.2, cooldownMs: 30000 };

      return h(
        'div',
        null,
        h(
          'div',
          { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '回应谁'),
          h(Row, { label: '群聊总开关' }, h(Toggle, { value: g.enabled, onChange: (v) => setIn('group.enabled', v) })),
          h(Row, { label: '@ 我' }, h(Toggle, { value: g.speakOnAt, onChange: (v) => setIn('group.speakOnAt', v) })),
          h(Row, { label: '叫名字' }, h(Toggle, { value: g.speakOnName, onChange: (v) => setIn('group.speakOnName', v) })),
          h(
            Row,
            { label: '唤醒关键词' },
            h('textarea', {
              style: Object.assign({}, S.area, { minHeight: 44 }),
              value: (g.keywords || []).join(', '),
              placeholder: 'deepseek —— 出现就一定接',
              onChange: (e) =>
                setIn(
                  'group.keywords',
                  e.target.value.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean),
                ),
            }),
          ),
          h(Row, { label: '我的名字' }, h('textarea', {
            style: Object.assign({}, S.area, { minHeight: 40 }),
            value: (g.names || []).join(', '),
            onChange: (e) =>
              setIn('group.names', e.target.value.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean)),
          })),
          h(
            Row,
            { label: '连发聚批' },
            h(Num, { value: cfg.debounceMs || 0, step: 100, onChange: (v) => setIn('debounceMs', Number(v)) }),
            h('span', { style: S.hint }, '毫秒。改这个要重启桥'),
          ),
        ),

        h(
          'div',
          { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '干活前先垫一句'),
          h(Row, { label: '垫话' }, h(Toggle, { value: ack.enabled !== false, onChange: (v) => setIn('ack.enabled', v) }), h('span', { style: S.hint }, '她要忙一阵的时候，先说一句，别让人干等')),
          h(Row, { label: '等多久再说' }, h(Num, {
            value: Math.round((ack.delayMs || 0) / 1000), step: 5,
            onChange: (v) => setIn('ack.delayMs', Number(v) * 1000),
          }), h('span', { style: S.hint }, '秒')),
          h(Row, { label: '私聊说' }, h('textarea', {
            style: Object.assign({}, S.area, { minHeight: 40 }),
            value: (ack.private || []).join(' | '),
            placeholder: '嗯……我想想',
            onChange: (e) =>
              setIn('ack.private', e.target.value.split(/[|｜\s]+/).map((x) => x.trim()).filter(Boolean)),
          })),
          h(Row, { label: '群里说' }, h('textarea', {
            style: Object.assign({}, S.area, { minHeight: 40 }),
            value: (ack.group || []).join(' | '),
            placeholder: '（我想想…）',
            onChange: (e) =>
              setIn('ack.group', e.target.value.split(/[|｜\s]+/).map((x) => x.trim()).filter(Boolean)),
          })),
          h('div', { style: S.hint }, '写几个就用几个，随机挑一句。全删光 = 不垫话，让她安静想完再说。'),
        ),

        h(
          'div',
          { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '被戳一戳'),
          h(Row, { label: '理不理' }, h(Toggle, { value: poke.enabled !== false, onChange: (v) => setIn('poke.enabled', v) })),
          h(Row, { label: '她说一句' }, h(Num, { value: poke.text, step: 0.05, onChange: (v) => setIn('poke.text', Number(v)) }), h('span', { style: S.hint }, '权重')),
          h(Row, { label: '戳回去' }, h(Num, { value: poke.poke, step: 0.05, onChange: (v) => setIn('poke.poke', Number(v)) }), h('span', { style: S.hint }, '权重')),
          h(Row, { label: '不理他' }, h(Num, { value: poke.silent, step: 0.05, onChange: (v) => setIn('poke.silent', Number(v)) }), h('span', { style: S.hint }, '权重')),
          h(Row, { label: '冷却' }, h(Num, {
            value: Math.round((poke.cooldownMs || 0) / 1000), step: 5,
            onChange: (v) => setIn('poke.cooldownMs', Number(v) * 1000),
          }), h('span', { style: S.hint }, '秒内再戳不理，防互相戳个没完')),
          h('div', { style: S.hint }, '三个权重按比例抽，不用凑成 1。比如 0.5 / 0.3 / 0.2 = 一半说话、三成戳回去、两成不理。'),
        ),

        h(
          'div',
          { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '什么时候开口（状态机）'),
          h(Row, { label: '自动接话' }, h(Toggle, { value: social.enabled, onChange: (v) => setIn('group.social.enabled', v) })),
          h(Row, { label: '观望期接话概率' }, h(Num, {
            value: social.triggerProbability, step: 0.01,
            onChange: (v) => setIn('group.social.triggerProbability', Number(v)),
          }), h('span', { style: S.hint }, '0–1')),
          h(Row, { label: '活跃时长' }, h(Num, {
            value: Math.round((social.activeDurationMs || 0) / 60000), step: 1,
            onChange: (v) => setIn('group.social.activeDurationMs', Number(v) * 60000),
          }), h('span', { style: S.hint }, '分钟')),
          h(Row, { label: '冷场多久试探' }, h(Num, {
            value: Math.round((social.idleWindowMs || 0) / 60000), step: 1,
            onChange: (v) => setIn('group.social.idleWindowMs', Number(v) * 60000),
          }), h('span', { style: S.hint }, '分钟')),
          h(Row, { label: '试探概率' }, h(Num, {
            value: social.idleRetryProbability, step: 0.01,
            onChange: (v) => setIn('group.social.idleRetryProbability', Number(v)),
          })),
          h(Row, { label: '主动开话题' }, h(Toggle, {
            value: social.proactive?.enabled,
            onChange: (v) => setIn('group.social.proactive.enabled', v),
            text: '安静很久时自己找个话头',
          })),
          h(Row, { label: '安静多久才开' }, h(Num, {
            value: Math.round((social.proactive?.idleThresholdMs || 0) / 60000), step: 1,
            onChange: (v) => setIn('group.social.proactive.idleThresholdMs', Number(v) * 60000),
          }), h('span', { style: S.hint }, '分钟')),
          h(Row, { label: '开话题概率' }, h(Num, {
            value: social.proactive?.probability, step: 0.01,
            onChange: (v) => setIn('group.social.proactive.probability', Number(v)),
          })),
          h(Row, { label: '故意沉默' }, h(Num, {
            value: social.skipProbability, step: 0.01,
            onChange: (v) => setIn('group.social.skipProbability', Number(v)),
          }), h('span', { style: S.hint }, '能接也选择不接的概率')),
          h(Row, { label: '一次最多几个字' }, h(Num, {
            value: social.maxReplyChars, step: 10,
            onChange: (v) => setIn('group.social.maxReplyChars', Number(v)),
          })),
        ),

        h(
          'div',
          { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '怎么发'),
          h(Row, { label: '拆成几条' }, h(Toggle, {
            value: send.split, onChange: (v) => setIn('send.split', v),
            text: '像真人那样一条条发，而不是一大段',
          })),
          h(Row, { label: '条间隔' }, h(Num, {
            value: send.gapMs, step: 100, onChange: (v) => setIn('send.gapMs', Number(v)),
          }), h('span', { style: S.hint }, '毫秒')),
          h(Row, { label: '回复审计' }, h(Toggle, {
            value: cfg.safety?.auditReply, onChange: (v) => setIn('safety.auditReply', v),
            text: '群里遮住本机路径和密钥',
          })),
          h(Row, { label: '主人号' }, h('input', {
            style: S.input,
            value: (cfg.owner?.userIds || []).join(', '),
            placeholder: '只有这些号能让她动手',
            onChange: (e) => setIn('owner.userIds', e.target.value.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean)),
          }), h('span', { style: S.hint }, '别人的私聊照样回，只是没有动手权限。改这个要重启桥')),
        ),
      );
    }

    // ── 记忆 ────────────────────────────────────────────────────────────
    function NotesTab(props) {
      const [notes, setNotes] = useState([]);
      const [draft, setDraft] = useState({ text: '', kind: '事实', weight: 2 });
      const [err, setErr] = useState('');
      const [editing, setEditing] = useState({});

      const load = useCallback(async () => {
        try {
          const r = await api('/api/notes');
          setNotes(r.notes || []);
          setErr('');
        } catch (e) {
          setErr(e.message);
        }
      }, []);
      useEffect(() => { load(); }, [load]);

      const add = async () => {
        if (!draft.text.trim()) return;
        try {
          await api('/api/notes', { method: 'POST', body: JSON.stringify(draft) });
          setDraft({ text: '', kind: draft.kind, weight: draft.weight });
          load();
        } catch (e) { setErr(e.message); }
      };
      const drop = async (id) => {
        try { await api('/api/notes/' + id, { method: 'DELETE' }); load(); } catch (e) { setErr(e.message); }
      };
      const save = async (id) => {
        const v = editing[id];
        if (!v) return;
        try {
          await api('/api/notes/' + id, { method: 'PATCH', body: JSON.stringify(v) });
          const n = Object.assign({}, editing); delete n[id]; setEditing(n); load();
        } catch (e) { setErr(e.message); }
      };

      return h(
        'div',
        null,
        err ? h('div', { style: S.err }, err) : null,
        h('div', { style: Object.assign({}, S.card) },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '记一条'),
          h('textarea', {
            style: S.area, value: draft.text, placeholder: '记什么？比如「他不喜欢被叫宝宝」',
            onChange: (e) => setDraft(Object.assign({}, draft, { text: e.target.value })),
          }),
          h('div', { style: S.row },
            h('input', { style: S.input, value: draft.kind,
              onChange: (e) => setDraft(Object.assign({}, draft, { kind: e.target.value })) }),
            h(Num, { value: draft.weight, onChange: (v) => setDraft(Object.assign({}, draft, { weight: Number(v) })) }),
            h('button', { style: S.btn(true), onClick: add }, '记下'),
          ),
        ),
        h('div', { style: S.tiny }, '共 ' + notes.length + ' 条'),
        notes.map((n) =>
          h('div', { key: n.id, style: S.item },
            h('div', { style: { flex: 1 } },
              editing[n.id]
                ? h('input', {
                    style: Object.assign({}, S.input, { width: '100%' }),
                    value: editing[n.id].text,
                    onChange: (e) => setEditing(Object.assign({}, editing, { [n.id]: Object.assign({}, editing[n.id], { text: e.target.value }) })),
                  })
                : h('div', null, n.text),
              h('div', { style: S.tiny }, '[' + n.kind + '] 权重 ' + n.weight + (n.room ? ' · ' + n.room : '') + ' · ' + n.id),
            ),
            editing[n.id]
              ? h('button', { style: S.btn(true), onClick: () => save(n.id) }, '存')
              : h('button', { style: S.btn(false), onClick: () => setEditing(Object.assign({}, editing, { [n.id]: { text: n.text } })) }, '改'),
            h('button', { style: S.btn(false), onClick: () => drop(n.id) }, '删'),
          ),
        ),
      );
    }

    // ── 工具 ────────────────────────────────────────────────────────────
    function ToolsTab() {
      const [data, setData] = useState(null);
      const [busy, setBusy] = useState('');
      const [err, setErr] = useState('');
      const [msg, setMsg] = useState('');
      const load = useCallback(async () => {
        try { const r = await api('/api/tools'); setData(r); setErr(''); } catch (e) { setErr(e.message); }
      }, []);
      useEffect(() => { load(); }, [load]);

      const toggle = async (p, on) => {
        setBusy(p.name); setErr(''); setMsg('');
        try {
          const r = await api('/api/tools/toggle', { method: 'POST', body: JSON.stringify({ name: p.name, on }) });
          const skipped = (r.skipped || []).length ? '；跳过：' + r.skipped.map((s) => s.why).join('、') : '';
          setMsg((on ? '装上了：' : '卸掉了：') + p.name + skipped);
          await load();
        } catch (e) { setErr(p.name + '：' + e.message); }
        setBusy('');
      };

      const plugins = (data && data.plugins) || [];
      const usable = plugins.filter((p) => !p.reason);
      const blocked = plugins.filter((p) => p.reason);

      return h('div', null,
        err ? h('div', { style: S.err }, err) : null,
        msg ? h('div', { style: S.ok }, msg) : null,
        h('div', { style: S.tiny }, '她跑在无界面的 profile 里，工具比界面少。勾上就装、取消就卸，立刻生效（下一轮对话就是新进程）。装的文件是从你本机复制的，不联网；卸之前会先备份，验不过自动回滚。'),
        !data ? h('div', { style: S.tiny }, '读取中…') : null,

        usable.map((p) =>
          h('label', { key: p.name, style: S.item },
            h('input', {
              type: 'checkbox',
              checked: !!p.installed,
              disabled: busy === p.name,
              onChange: (e) => toggle(p, e.target.checked),
            }),
            h('div', { style: { flex: 1 } },
              h('div', null, p.name),
              h('div', { style: S.tiny }, 'v' + p.version + (busy === p.name ? ' · 处理中…' : '')),
            ),
          ),
        ),

        blocked.length ? h('div', { style: { marginTop: 14 } },
          h('div', { style: S.tiny }, '这些搬不过去：'),
          blocked.map((p) => h('div', { key: p.name, style: S.tiny }, '· ' + p.name + ' —— ' + p.reason)),
        ) : null,
      );
    }

    // ── 待确认 ──────────────────────────────────────────────────────────
    function PendingTab() {
      const [items, setItems] = useState([]);
      const [err, setErr] = useState('');
      const load = useCallback(async () => {
        try { const r = await api('/api/pending'); setItems(r.pending || []); setErr(''); } catch (e) { setErr(e.message); }
      }, []);
      useEffect(() => { load(); }, [load]);
      const close = async (id) => {
        try { await api('/api/pending/' + id, { method: 'POST', body: JSON.stringify({ action: 'close' }) }); load(); } catch (e) { setErr(e.message); }
      };
      const open = items.filter((p) => p.status !== 'closed');
      return h('div', null,
        err ? h('div', { style: S.err }, err) : null,
        h('div', { style: S.tiny }, '这里是我发现「对不上」的地方 —— 先问你，不擅自改记忆。'),
        open.length === 0 ? h('div', { style: S.tiny }, '暂时没有。') : null,
        open.map((p) =>
          h('div', { key: p.id, style: S.item },
            h('div', { style: { flex: 1 } },
              h('div', null, '记忆里是：' + (p.noteText || '')),
              h('div', { style: S.tiny }, '这次听到：' + (p.claim || '')),
            ),
            h('button', { style: S.btn(false), onClick: () => close(p.id) }, '知道了'),
          ),
        ),
      );
    }

    // ── 房间（跨房间记忆开关）─────────────────────────────────────────
    function NotebookTab() {
      const [info, setInfo] = useState(null);
      const [err, setErr] = useState('');
      const [cur, setCur] = useState('');
      const [text, setText] = useState('');

      const load = useCallback(async () => {
        try { setInfo(await api('/api/notebook')); setErr(''); } catch (e) { setErr(e.message); }
      }, []);
      useEffect(() => { load(); }, [load]);

      const open = async (p) => {
        try {
          const r = await api('/api/notebook/file?path=' + encodeURIComponent(p));
          setCur(p);
          setText(r.text || '');
        } catch (e) { setErr(e.message); }
      };

      const files = (info && info.files) || [];
      return h('div', null,
        err ? h('div', { style: S.err }, err) : null,
        h('div', { style: S.tiny },
          '她自己的本子。' + (info ? '共 ' + files.length + ' 页，上限 ' + info.limitMb + 'MB。' : '读取中…') +
          ' 内容不进仓库（只留空架子），所以每个人下载之后，各人一本。'),
        h('div', { style: { display: 'flex', gap: 12, marginTop: 10, alignItems: 'flex-start' } },
          h('div', { style: { width: 220, flexShrink: 0, maxHeight: 420, overflow: 'auto' } },
            files.length ? files.map((f) =>
              h('div', {
                key: f.path,
                style: Object.assign({}, S.item, { cursor: 'pointer', fontWeight: cur === f.path ? 600 : 400 }),
                onClick: () => open(f.path),
              },
                h('div', { style: { flex: 1 } },
                  h('div', { style: { fontSize: 12 } }, f.path),
                  h('div', { style: S.tiny }, (f.bytes / 1024).toFixed(1) + 'KB · ' + new Date(f.mtime).toLocaleString()),
                ),
              ),
            ) : h('div', { style: S.tiny }, '还是空的。她写第一条之后就有了。'),
          ),
          h('div', { style: { flex: 1, minWidth: 0 } },
            cur
              ? h('div', null,
                  h('div', { style: { fontSize: 12, marginBottom: 6 } }, cur + '（只读）'),
                  h('pre', {
                    style: Object.assign({}, S.area, {
                      minHeight: 360,
                      maxHeight: 460,
                      overflow: 'auto',
                      whiteSpace: 'pre-wrap',
                      fontFamily: 'ui-monospace, Consolas, monospace',
                      fontSize: 12,
                      margin: 0,
                    }),
                  }, text),
                  h('div', { style: { marginTop: 6 } },
                    h('span', { style: S.tiny }, '只读——这是她自己的地方，要改让她自己动手。')),
                )
              : h('div', { style: S.tiny }, '点左边挑一页看看。'),
          ),
        ),
      );
    }


    function RoomsTab() {
      const [rooms, setRooms] = useState([]);
      const [err, setErr] = useState('');
      const load = useCallback(async () => {
        try { const r = await api('/api/rooms'); setRooms(r.rooms || []); setErr(''); } catch (e) { setErr(e.message); }
      }, []);
      useEffect(() => { load(); }, [load]);

      const flip = async (room, key, value) => {
        try {
          await api('/api/rooms', { method: 'POST', body: JSON.stringify(Object.assign({ room }, { [key]: value })) });
          load();
        } catch (e) { setErr(e.message); }
      };

      return h('div', null,
        err ? h('div', { style: S.err }, err) : null,
        h('div', { style: S.tiny }, '各房间各记各的账。「能看别处」= 我在这个房间能不能看到别的事；「能让别处看」= 这个房间的事能不能被别的房间看到。'),
        rooms.map((r) =>
          h('div', { key: r.room, style: S.item },
            h('div', { style: { flex: 1 } },
              h('div', null, r.name || r.room),
              h('div', { style: S.tiny }, r.room + (r.session ? ' · 会话 ' + r.session.slice(8, 16) : ' · 还没开过会话')),
            ),
            h('label', { style: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 } },
              h('input', { type: 'checkbox', checked: !!r.read, onChange: (e) => flip(r.room, 'read', e.target.checked) }),
              '能看别处',
            ),
            h('label', { style: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 } },
              h('input', { type: 'checkbox', checked: !!r.share, onChange: (e) => flip(r.room, 'share', e.target.checked) }),
              '能让别处看',
            ),
          ),
        ),
      );
    }

    // ── 事件 ────────────────────────────────────────────────────────────
    function EventsTab() {
      const [events, setEvents] = useState([]);
      const [err, setErr] = useState('');
      useEffect(() => {
        api('/api/events?limit=60')
          .then((r) => setEvents(r.events || []))
          .catch((e) => setErr(e.message));
      }, []);
      return h('div', null,
        err ? h('div', { style: S.err }, err) : null,
        h('div', { style: S.tiny }, '最近 60 条（最新的在最上面）'),
        events.slice().reverse().map((e, i) =>
          h('div', { key: i, style: S.item },
            h('div', { style: { flex: 1 } },
              h('div', null, (e.fromName || e.from || '?') + '：' + String(e.text || '').slice(0, 200)),
              h('div', { style: S.tiny }, new Date(e.ts || e.at || Date.now()).toLocaleString() + ' · ' + (e.room || '')),
            ),
          ),
        ),
      );
    }

    // ── 会话 ────────────────────────────────────────────────────────────
    function SessionsTab() {
      const [st, setSt] = useState(null);
      const [err, setErr] = useState('');
      const load = useCallback(async () => {
        try { setSt(await api('/api/status')); setErr(''); } catch (e) { setErr(e.message); }
      }, []);
      useEffect(() => { load(); }, [load]);
      const reset = async (room) => {
        try { await api('/api/sessions/reset', { method: 'POST', body: JSON.stringify({ room }) }); load(); } catch (e) { setErr(e.message); }
      };
      return h('div', null,
        err ? h('div', { style: S.err }, err) : null,
        st ? h('div', { style: S.tiny }, '脑子：' + st.brain + ' · 记忆 ' + st.notes + ' 条 · 待确认 ' + st.pending + ' 条') : null,
        (st && st.rooms ? st.rooms : []).map((r) =>
          h('div', { key: r.room, style: S.item },
            h('div', { style: { flex: 1 } },
              h('div', null, r.room),
              h('div', { style: S.tiny }, (r.state ? '状态 ' + r.state + ' · ' : '') + '会话 ' + (r.session || '（还没开）')),
            ),
            h('button', { style: S.btn(false), onClick: () => reset(r.room) }, '换个新会话'),
          ),
        ),
        h('div', { style: S.tiny }, '「换新会话」= 让她忘掉那段对话的细节，但记忆和事件都还在。权限或人格改了之后要用它。'),
      );
    }

    // ── 人设（三层，各改各的）─────────────────────────────────────────
    const PERSONA_TABS = [
      ['core', '核心卡', '我是谁、和他是什么关系、说话底线。每轮必读，拆不掉的那部分。'],
      ['group', '群聊手册', '群里的说话方式、回复频率、表情包、群文化。只在群里补给她，私聊不进上下文。'],
      ['self', '我自己的部分', '她自己的喜好与改动日志。改这个要开高级权限 —— 那是她自己的地方。'],
    ];

    function PersonaTab(props) {
      const cfg = props.cfg || {};
      const [which, setWhich] = useState('core');
      const [meta, setMeta] = useState(null);
      const [drafts, setDrafts] = useState({});
      const [unlocked, setUnlocked] = useState(false);
      const [err, setErr] = useState('');
      const [msg, setMsg] = useState('');
      const [busy, setBusy] = useState(false);
      const [tryText, setTryText] = useState('');
      const [tryOut, setTryOut] = useState(null);
      const [tryBusy, setTryBusy] = useState(false);
      const [full, setFull] = useState(false);
      const [allowed, setAllowed] = useState(!!(cfg.web && cfg.web.allowFullAccess));

      const load = useCallback(async (w) => {
        try {
          const r = await api('/api/persona?file=' + w);
          setMeta(r);
          setDrafts((d) => ({ ...d, [w]: r.text || '' }));
          setErr('');
        } catch (e) { setErr(e.message); }
      }, []);
      useEffect(() => { load(which); }, [which, load]);

      const locked = which === 'self' && !unlocked;
      const draft = drafts[which] == null ? '' : drafts[which];
      const info = PERSONA_TABS.find((t) => t[0] === which) || PERSONA_TABS[0];

      const save = async () => {
        setBusy(true);
        try {
          const r = await api('/api/persona', {
            method: 'POST',
            body: JSON.stringify({ file: which, text: draft, advanced: unlocked }),
          });
          setMsg('已保存 ' + (r.bytes || 0) + ' 字节，下一句就按新的来（旧版已备份）');
          setErr('');
        } catch (e) { setErr(e.message); setMsg(''); }
        setBusy(false);
      };

      const runTry = async (withFull) => {
        setTryBusy(true);
        setTryOut(null);
        try {
          const r = await api('/api/try', {
            method: 'POST',
            body: JSON.stringify({ file: which, text: tryText, full: !!withFull }),
          });
          setTryOut(r);
          setErr('');
        } catch (e) { setErr(e.message); }
        setTryBusy(false);
      };

      return h('div', null,
        err ? h('div', { style: S.err }, err) : null,
        msg ? h('div', { style: S.tiny }, msg) : null,
        h('div', { style: { display: 'flex', gap: 6, marginBottom: 8 } },
          PERSONA_TABS.map(([id, label]) =>
            h('div', { key: id, style: S.tab(which === id), onClick: () => setWhich(id) }, label),
          ),
        ),
        h('div', { style: S.tiny }, info[2]),
        meta ? h('div', { style: S.tiny }, (meta.path || '') + ' · ' + (meta.bytes || 0) + ' 字节') : null,

        which === 'self'
          ? h('div', { style: { ...S.item, marginTop: 10 } },
            h('div', { style: { flex: 1, fontSize: 12 } },
              unlocked ? '高级权限已开 —— 改完记得保存。' : '这一页默认只读。那是她自己的地方，要看清楚了再动。',
            ),
            h('button', {
              style: S.btn(!unlocked),
              onClick: () => { setUnlocked(!unlocked); setMsg(''); },
            }, unlocked ? '收起权限' : '开高级权限'),
          )
          : null,

        h('textarea', {
          value: draft,
          readOnly: locked,
          onChange: (e) => setDrafts((d) => ({ ...d, [which]: e.target.value })),
          spellCheck: false,
          style: {
            width: '100%', minHeight: 320, marginTop: 10, padding: 10, resize: 'vertical',
            fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12, lineHeight: 1.6,
            borderRadius: 8, border: '1px solid rgba(128,128,128,.35)', boxSizing: 'border-box',
            background: locked ? 'rgba(128,128,128,.08)' : 'transparent',
            opacity: locked ? 0.75 : 1,
          },
        }),

        h('div', { style: { display: 'flex', gap: 8, marginTop: 10 } },
          h('button', { style: S.btn(true), disabled: busy || locked, onClick: save }, busy ? '保存中…' : '保存'),
          h('button', { style: S.btn(false), onClick: () => load(which) }, '放弃改动，重新载入'),
        ),

        // 试一试：拿正在看的这份人设，真的说一句话
        h('div', { style: { ...S.card, marginTop: 12 } },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '试一试这张人设'),
          h('textarea', {
            style: Object.assign({}, S.area, { minHeight: 56 }),
            value: tryText,
            placeholder: '说一句，看看她会怎么回。比如：在吗',
            onChange: (e) => setTryText(e.target.value),
          }),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' } },
            h('button', {
              style: S.btn(true),
              disabled: tryBusy || !tryText.trim(),
              onClick: () => runTry(full && allowed),
            }, tryBusy ? '她想一会儿…' : (full && allowed ? '试一试（真的去做）' : '试一试')),
            allowed
              ? h('label', { style: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, cursor: 'pointer' } },
                  h('input', { type: 'checkbox', checked: full, onChange: (e) => setFull(e.target.checked) }),
                  '给她全套权限（会真的动电脑，可能装东西、删文件）')
              : h('button', {
                  style: S.btn(false),
                  onClick: async () => {
                    if (!window.confirm('允许「试一试」拿到全套权限？\n开了以后，她在试的时候能真的改你电脑上的东西。')) return;
                    try {
                      await api('/api/config', { method: 'POST', body: JSON.stringify({ web: { allowFullAccess: true } }) });
                      setAllowed(true);
                      setMsg('全套权限已开；不想用了再点一次旁边那个开关');
                    } catch (e) { setErr(e.message); }
                  },
                }, '允许全套权限'),
          ),
          h('div', { style: S.tiny }, '默认在沙箱里跑：能读能写项目里，出不去。'),
          tryOut
            ? h('div', { style: { marginTop: 10, padding: 10, borderRadius: 8, background: 'rgba(128,128,128,.10)', fontSize: 12, lineHeight: 1.7, whiteSpace: 'pre-wrap' } },
                (tryOut.text || '（她什么都没说）') + '\n\n— ' + (tryOut.ms || 0) + 'ms · ' + (tryOut.brain === 'full' ? '全套权限' : '沙箱'))
            : null,
        ),
      );
    }

    function FreeTab(props) {
      const cfg = props.cfg || {};
      const set = props.set;
      const f = cfg.freeTime || {};
      const [st, setSt] = useState(null);
      const [busy, setBusy] = useState(false);
      const [err, setErr] = useState('');

      const setIn = (path, value) => {
        const next = JSON.parse(JSON.stringify(cfg));
        const keys = path.split('.');
        let o = next;
        for (const k of keys.slice(0, -1)) {
          if (!o[k] || typeof o[k] !== 'object') o[k] = {};
          o = o[k];
        }
        o[keys[keys.length - 1]] = value;
        set(next);
      };

      const pull = async () => {
        try { setSt(await api('/api/free')); } catch (e) { setErr(e.message); }
      };
      useEffect(() => {
        pull();
        const t = setInterval(pull, 5000);
        return () => clearInterval(t);
      }, []);

      const go = async (action) => {
        setBusy(true);
        try {
          const r = await api('/api/free', { method: 'POST', body: JSON.stringify({ action }) });
          setSt({ status: r.status });
          setErr('');
          if (action === 'start' && !r.ok) setErr(r.error || '开不了');
        } catch (e) { setErr(e.message); }
        setBusy(false);
      };

      const running = !!(st && st.status && st.status.running);
      const s = (st && st.status) || null;

      return h('div', null,
        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '这一段'),
          h(Row, { label: '一段多长' },
            h(Num, { value: Math.round((Number(f.durationMs) || 1800000) / 60000), step: 5, onChange: (v) => setIn('freeTime.durationMs', Math.max(1, Number(v)) * 60000) }),
            h('span', { style: S.hint }, '分钟')),
          h(Row, { label: '多久叫她一拍' },
            h(Num, { value: Math.round((Number(f.beatMs) || 75000) / 1000), step: 15, onChange: (v) => setIn('freeTime.beatMs', Math.max(15, Number(v)) * 1000) }),
            h('span', { style: S.hint }, '秒')),
          h(Row, { label: '最多说几句' },
            h(Num, { value: Number(f.maxMessages) || 3, step: 1, onChange: (v) => setIn('freeTime.maxMessages', Math.max(0, Number(v))) })),
          h(Row, { label: '你刚说过话就让路' },
            h(Num, { value: Math.round((Number(f.skipIfActiveMs ?? 300000)) / 60000), step: 1, onChange: (v) => setIn('freeTime.skipIfActiveMs', Math.max(0, Number(v)) * 60000) }),
            h('span', { style: S.hint }, '分钟内不打扰，0 = 不让路')),
          h(Row, { label: '能看到什么程度' },
            h('select', {
              style: S.area,
              value: f.permission || 'look',
              onChange: (e) => setIn('freeTime.permission', e.target.value),
            },
              h('option', { value: 'look' }, '只看不动（截图、读文件、上网）'),
              h('option', { value: 'act' }, '可以动手（开程序、点鼠标、写文件）'),
              h('option', { value: 'full' }, '全套（能装东西、改设置）'),
            )),
          h(Row, { label: '两段之间至少隔' },
            h(Num, { value: Math.round((Number(f.minGapMs) || 3600000) / 60000), step: 10, onChange: (v) => setIn('freeTime.minGapMs', Math.max(0, Number(v)) * 60000) }),
            h('span', { style: S.hint }, '分钟')),
        ),

        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '自己找时间醒来'),
          h(Row, { label: '让她自己醒' },
            h(Toggle, {
              value: !!(f.auto && f.auto.enabled),
              onChange: (v) => setIn('freeTime.auto', Object.assign({}, f.auto, { enabled: v })),
            }),
            h('span', { style: S.hint }, '隔一阵掷一次骰子，掷到了就醒')),
          h(Row, { label: '隔多久掷一次' },
            h(Num, {
              value: Math.round((Number(f.auto && f.auto.minGapMs) || 7200000) / 60000), step: 30,
              onChange: (v) => setIn('freeTime.auto', Object.assign({}, f.auto, { minGapMs: Math.max(1, Number(v)) * 60000 })),
            }),
            h('span', { style: S.hint }, '到'),
            h(Num, {
              value: Math.round((Number(f.auto && f.auto.maxGapMs) || 21600000) / 60000), step: 30,
              onChange: (v) => setIn('freeTime.auto', Object.assign({}, f.auto, { maxGapMs: Math.max(2, Number(v)) * 60000 })),
            }),
            h('span', { style: S.hint }, '分钟之间')),
        ),

        h('div', { style: S.card },
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h('button', {
              style: S.btn(true),
              disabled: busy || running,
              onClick: () => go('start'),
            }, running ? '正在进行' : '现在就开始一段'),
            h('button', {
              style: S.btn(false),
              disabled: busy || !running,
              onClick: () => go('stop'),
            }, '让她收工'),
            s
              ? h('span', { style: S.hint }, running
                  ? `还剩 ${Math.round(s.remainingMs / 60000)} 分钟 · 已 ${s.beats} 拍 · 说了 ${s.messages}/${s.maxMessages} 句`
                  : (s.reason ? `上一段：${s.reason}` : '没在自由活动'))
              : null,
          ),
          h('div', { style: { ...S.tiny, marginTop: 6 } }, '开始之前记得先保存上面的设置。'),
          err ? h('div', { style: S.err }, err) : null,
        ),
      );
    }

    function SnowLumaButton(props) {
      const [busy, setBusy] = useState(false);
      const [note, setNote] = useState('');

      const wake = async () => {
        setBusy(true);
        setNote('正在唤醒…');
        try {
          const r = await api('/api/snowluma/up', { method: 'POST' });
          if (r && r.ok) {
            setNote(r.started ? '起来了' : '本来就在跑');
            // 地址以后端为准：SnowLuma 抢不到 5099 时会退到 5100
            if (r.url) window.open(r.url, '_blank', 'noopener');
          } else {
            setNote('没唤醒：' + ((r && r.error) || '不清楚'));
          }
        } catch (e) {
          setNote('没唤醒：' + e.message);
        }
        setBusy(false);
        setTimeout(() => setNote(''), 6000);
      };

      return h('button', {
        style: Object.assign({}, S.btn(false), props.style || {}, busy ? { opacity: 0.6 } : null),
        title: '没在跑就先静默拉起来，再打开它自己的网页（登录、看连接、改协议）',
        disabled: busy,
        onClick: wake,
      }, busy ? '唤醒中…' : (note || '唤醒并打开 SnowLuma'));
    }

    function Panel() {
      const [tab, setTab] = useState('group');
      const [cfg, setCfg] = useState(null);
      const [err, setErr] = useState('');
      const [msg, setMsg] = useState('');
      const [busyRestart, setBusyRestart] = useState(false);

      useEffect(() => {
        api('/api/config')
          .then((r) => setCfg(r.config))
          .catch((e) => setErr(e.message));
      }, []);

      const save = async () => {
        try {
          const r = await api('/api/config', { method: 'POST', body: JSON.stringify(cfg) });
          setMsg('已保存：' + (r.touched || []).join('、') + (r.restartRequired ? '（要重启桥才全生效）' : ''));
          setErr('');
        } catch (e) { setErr(e.message); setMsg(''); }
      };

      const tabs = [
        ['group', '群聊'],
        ['free', '自由活动'],
        ['notebook', '小本本'],
        ['notes', '记忆'],
        ['rooms', '房间'],
        ['tools', '工具'],
        ['persona', '人设'],
        ['pending', '待确认'],
        ['events', '事件'],
        ['sessions', '会话'],
      ];

      return h('div', { style: S.wrap },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 } },
          h('div', { style: { fontSize: 15, fontWeight: 600 } }, 'AFL 通道'),
          h('div', { style: S.tiny }, 'QQ 这边怎么说话、记得什么'),
          h(SnowLumaButton, { style: { marginLeft: 'auto' } }),
          h('button', {
            style: S.btn(false),
            title: '杀掉现在这只桥，再起一只新的（正在说话的那一轮会中断）',
            disabled: busyRestart,
            onClick: async () => {
              if (!window.confirm('重启桥？正在进行的那一轮会中断。')) return;
              setBusyRestart(true);
              try {
                const r = await api('/api/restart', { method: 'POST' });
                alert('桥已重启（pid ' + (r && r.pid) + '，' + (r && r.ms) + 'ms）');
                // 重启完成后重新拉一次配置。
                // 2026-10-22：这里原本写的是 await loadStatus()，可根本没有这个函数——
                // 于是重启明明成功了，面板却弹「重启失败：loadStatus is not defined」。
                try {
                  const again = await api('/api/config');
                  setCfg(again.config);
                  setErr('');
                } catch (e2) { setErr(e2.message); }
              } catch (e) {
                alert('重启失败：' + (e && e.message ? e.message : e));
              } finally {
                setBusyRestart(false);
              }
            },
          }, busyRestart ? '重启中…' : '重启桥'),
        ),
        h('div', { style: S.tabs }, tabs.map(([id, label]) =>
          h('div', { key: id, style: S.tab(tab === id), onClick: () => setTab(id) }, label),
        )),
        err ? h('div', { style: S.err }, err) : null,
        msg ? h('div', { style: S.ok }, msg) : null,

        tab === 'group'
          ? (cfg
              ? h(GroupTab, { cfg, set: setCfg })
              : h('div', { style: S.tiny }, '读取配置中…'))
          : null,
        tab === 'group' && cfg ? h('div', { style: { marginTop: 10 } }, h('button', { style: S.btn(true), onClick: save }, '保存')) : null,

        tab === 'free' ? (cfg ? h(FreeTab, { cfg, set: setCfg }) : h('div', { style: S.tiny }, '读取配置中…')) : null,
        tab === 'free' && cfg ? h('div', { style: { marginTop: 10 } }, h('button', { style: S.btn(true), onClick: save }, '保存')) : null,
        tab === 'notes' ? h(NotesTab) : null,
        tab === 'notebook' ? h(NotebookTab) : null,
        tab === 'rooms' ? h(RoomsTab) : null,
        tab === 'tools' ? h(ToolsTab) : null,
        tab === 'persona' ? (cfg ? h(PersonaTab, { cfg, set: setCfg }) : h('div', { style: S.tiny }, '读取配置中…')) : null,
        tab === 'pending' ? h(PendingTab) : null,
        tab === 'events' ? h(EventsTab) : null,
        tab === 'sessions' ? h(SessionsTab) : null,
      );
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          { name: 'settings.section', id: 'afullife-panel', order: 92, label: 'AFL 通道' },
          Panel,
        ),
      );
    }

    module.exports = { inject: ['slots'], apply };
    return module.exports;
  },
});
