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
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, 'QQ 空间（说说）'),
          h(Row, { label: '让她能发' }, h(Toggle, {
            value: (cfg.qzone || {}).enabled === true,
            onChange: (v) => setIn('qzone.enabled', v),
          }), h('span', { style: S.hint }, '默认关着——外发的东西收不回来')),
          h(Row, { label: '一条最多' }, h(Num, {
            value: (cfg.qzone || {}).maxChars || 1000, step: 100,
            onChange: (v) => setIn('qzone.maxChars', Number(v)),
          }), h('span', { style: S.hint }, '字')),
          h('div', { style: S.hint }, '打开之后她能用 node scripts/qzone.mjs post "…" 发、list 看、delete <tid> 删。她不会自己发——你没明说，她只在嘴上提。'),
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
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '她手头的事'),
          h(Row, { label: '记不记' }, h(Toggle, {
            value: (cfg.doing || {}).enabled !== false,
            onChange: (v) => setIn('doing.enabled', v),
          }), h('span', { style: S.hint }, '她自己说「要去洗澡」才记，不从语气里猜')),
          h(Row, { label: '没说多久' }, h(Num, {
            value: (cfg.doing || {}).defaultMinutes || 20, step: 5,
            onChange: (v) => setIn('doing.defaultMinutes', Number(v)),
          }), h('span', { style: S.hint }, '分钟')),
          h(Row, { label: '忙完还记着' }, h(Num, {
            value: (cfg.doing || {}).afterMinutes ?? 30, step: 5,
            onChange: (v) => setIn('doing.afterMinutes', Number(v)),
          }), h('span', { style: S.hint }, '分钟——「刚忙完」这个尾巴最好接话')),
          h(Row, { label: '在忙时晚说' }, h(Num, {
            value: Math.round(((cfg.doing || {}).busyExtraDelayMs ?? 4000) / 1000), step: 1,
            onChange: (v) => setIn('doing.busyExtraDelayMs', Number(v) * 1000),
          }), h('span', { style: S.hint }, '秒（只延第一条，绝不拦消息）')),
          h('div', { style: S.hint }, '她在自己那段时间里写 <busy:洗澡:20/> 才算数，<busy:done/> 是忙完。这是全局一份——群里说去洗澡，私聊里也是刚洗完。'),
        ),

        h(
          'div',
          { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '她也会困'),
          h(Row, { label: '夜里犯困' }, h(Toggle, {
            value: (cfg.rest || {}).enabled !== false,
            onChange: (v) => setIn('rest.enabled', v),
          }), h('span', { style: S.hint }, '不是关机——夜里回得慢半拍、句子短一点')),
          h(Row, { label: '几点到几点' },
            h(Num, {
              value: (cfg.rest || {}).from ?? 1, step: 1,
              onChange: (v) => setIn('rest.from', Number(v)),
            }),
            h('span', { style: S.hint }, '点到'),
            h(Num, {
              value: (cfg.rest || {}).to ?? 7, step: 1,
              onChange: (v) => setIn('rest.to', Number(v)),
            }),
            h('span', { style: S.hint }, '点（从 > 到 = 跨零点）')),
          h(Row, { label: '夜里晚说' }, h(Num, {
            value: Math.round(((cfg.rest || {}).extraDelayMs ?? 8000) / 1000), step: 1,
            onChange: (v) => setIn('rest.extraDelayMs', Number(v) * 1000),
          }), h('span', { style: S.hint }, '秒')),
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
      const [order, setOrder] = useState('asc');        // asc = 早的在上 / desc = 晚的在上
      const [roomFilter, setRoomFilter] = useState('*'); // '*' = 全部房间 / '' = 没归房间的那些 / 'group:xxx' = 某一个

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

      // 按发生时间排，正序倒序可切；同一天归一组。存储一个字不动，只改这里怎么看。
      const roomOf = (n) => n.room || '';
      const roomLabel = (k) => (k.startsWith('group:') ? '群 ' + k.slice(6)
        : k.startsWith('private:') ? '私聊 ' + k.slice(8) : k || '未分房间');
      const roomKeys = [...new Set(notes.map(roomOf))].filter(Boolean).sort();
      const looseCount = notes.filter((n) => !roomOf(n)).length;
      const shownNotes = roomFilter === '*' ? notes : notes.filter((n) => roomOf(n) === roomFilter);
      const sortedNotes = shownNotes.slice()
        .sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
      if (order === 'desc') sortedNotes.reverse();
      const dayGroups = [];
      for (const n of sortedNotes) {
        const day = String(n.at || '').slice(0, 10) || '没记时间';
        const last = dayGroups[dayGroups.length - 1];
        if (last && last.day === day) last.items.push(n);
        else dayGroups.push({ day, items: [n] });
      }

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
        h('div', { style: Object.assign({}, S.row, { marginTop: 10 }) },
          h('select', {
            style: Object.assign({}, S.input, { flex: 1 }),
            value: roomFilter,
            onChange: (e) => setRoomFilter(e.target.value),
          },
            h('option', { value: '*' }, '全部房间 · ' + notes.length + ' 条'),
            looseCount ? h('option', { value: '' }, '未分房间 · ' + looseCount + ' 条') : null,
            roomKeys.map((k) => h('option', { key: k, value: k },
              roomLabel(k) + ' · ' + notes.filter((n) => roomOf(n) === k).length + ' 条')),
          ),
          h('button', {
            style: S.btn(false),
            onClick: () => setOrder(order === 'asc' ? 'desc' : 'asc'),
          }, order === 'asc' ? '早的在上 ↑' : '晚的在上 ↓'),
        ),
        h('div', { style: S.tiny }, '显示 ' + shownNotes.length + ' / ' + notes.length + ' 条'),
        dayGroups.map((g) =>
          h('div', { key: g.day },
            h('div', { style: Object.assign({}, S.tiny, { margin: '14px 0 4px', fontWeight: 600, opacity: 0.85 }) },
              g.day + ' · ' + g.items.length + ' 条'),
            g.items.map((n) =>
              h('div', { key: n.id, style: n.staleAt ? Object.assign({}, S.item, { opacity: 0.5 }) : S.item },
                h('div', { style: { flex: 1 } },
                  editing[n.id]
                    ? h('input', {
                        style: Object.assign({}, S.input, { width: '100%' }),
                        value: editing[n.id].text,
                        onChange: (e) => setEditing(Object.assign({}, editing, { [n.id]: Object.assign({}, editing[n.id], { text: e.target.value }) })),
                      })
                    : h('div', null, n.text),
                  h('div', { style: S.tiny },
                    '[' + n.kind + '] ' + String(n.at || '').slice(11, 16) + ' · 权重 ' + n.weight
                    + (n.room ? ' · ' + n.room : '') + ' · ' + n.id),
                  n.staleAt ? h('div', { style: S.tiny }, '已过时' + (n.staleWhy ? '：' + String(n.staleWhy).slice(0, 90) : '')) : null,
                ),
                editing[n.id]
                  ? h('button', { style: S.btn(true), onClick: () => save(n.id) }, '存')
                  : h('button', { style: S.btn(false), onClick: () => setEditing(Object.assign({}, editing, { [n.id]: { text: n.text } })) }, '改'),
                h('button', { style: S.btn(false), onClick: () => drop(n.id) }, '删'),
              ),
            ),
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
    // ── 用量 ────────────────────────────────────────────────────────────
    // 每轮花了多少 token，记在 data/usage/ 里；她自己也看得到（提示词里带一句 + scripts/usage.mjs）
    function UsageTab() {
      const [u, setU] = useState(null);
      const [err, setErr] = useState('');
      const [price, setPrice] = useState({ inputPerM: 0, outputPerM: 0, cacheReadPerM: 0 });
      const [currency, setCurrency] = useState('¥');
      const [saving, setSaving] = useState(false);
      const [priceMsg, setPriceMsg] = useState('');
      // 会话轮换阈值：每步上下文超过这个数就换新会话（见 docs/design.md「省钱的三个杠杆」）
      const [rotate, setRotate] = useState(60000);
      const [rotateMsg, setRotateMsg] = useState('');
      const [handover, setHandover] = useState({ enabled: true, inner: true });
      const [handoverMsg, setHandoverMsg] = useState('');
      const saveHandover = async (patch) => {
        const next = Object.assign({}, handover, patch);
        setHandover(next);
        setHandoverMsg('');
        try {
          await api('/api/config', { method: 'POST', body: JSON.stringify({ brain: { headless: { handover: next } } }) });
          setHandoverMsg('存好了');
        } catch (e) {
          setHandoverMsg('没存上：' + e.message);
        }
      };
      const loadRotate = () => api('/api/config')
        .then((r) => {
          const v = r && r.config && r.config.brain && r.config.brain.headless
            ? r.config.brain.headless.rotateAtTokens
            : undefined;
          if (v !== undefined && v !== null) setRotate(v);
          const h = r && r.config && r.config.brain && r.config.brain.headless
            ? r.config.brain.headless.handover
            : undefined;
          if (h && typeof h === 'object') {
            setHandover({ enabled: h.enabled !== false, inner: h.inner !== false });
          }
        })
        .catch(() => {});
      const saveRotate = async () => {
        setRotateMsg('');
        try {
          const n = Math.max(0, Math.round(Number(rotate) || 0));
          await api('/api/config', { method: 'POST', body: JSON.stringify({ brain: { headless: { rotateAtTokens: n } } }) });
          setRotate(n);
          setRotateMsg(n > 0 ? `存好了：每次超过 ${n} token 就换新会话` : '存好了：不换会话（0）');
        } catch (e) {
          setRotateMsg('没存上：' + e.message);
        }
      };
      const load = () => api('/api/usage?days=7')
        .then((r) => {
          setU(r);
          if (r && r.price) setPrice({ inputPerM: r.price.inputPerM || 0, outputPerM: r.price.outputPerM || 0, cacheReadPerM: r.price.cacheReadPerM || 0 });
          if (r && r.currency) setCurrency(r.currency);
        })
        .catch((e) => setErr(e.message));
      useEffect(() => { load(); loadRotate(); }, []);
      const savePrice = async () => {
        setSaving(true);
        setPriceMsg('');
        try {
          await api('/api/config', {
            method: 'POST',
            body: JSON.stringify({
              usage: {
                currency: currency || '¥',
                price: {
                  inputPerM: Number(price.inputPerM) || 0,
                  outputPerM: Number(price.outputPerM) || 0,
                  cacheReadPerM: Number(price.cacheReadPerM) || 0,
                },
              },
            }),
          });
          await load();
          setPriceMsg('存好了，上面的数会按新单价重算');
        } catch (e) {
          setPriceMsg('没存上：' + e.message);
        } finally {
          setSaving(false);
        }
      };
      const priceInput = (label, key) => h('label', { style: { ...S.tiny, display: 'flex', gap: 4, alignItems: 'center' } },
        label,
        h('input', {
          type: 'number',
          value: price[key],
          style: { ...S.input, width: 74 },
          onChange: (e) => setPrice({ ...price, [key]: e.target.value }),
        }),
      );
      const wan = (n) => (n >= 10000 ? (n / 10000).toFixed(1) + ' 万' : String(n || 0));
      const cost = (agg) => (u && u.price && agg && agg.cost !== null && agg.cost !== undefined && agg.cost > 0
        ? ' · ' + u.currency + agg.cost
        : '');
      const today = u && u.today;
      return h('div', null,
        err ? h('div', { style: S.err }, err) : null,
        !u ? h('div', { style: S.tiny }, '读取中…') : null,
        today
          ? h('div', { style: { marginBottom: 10 } },
            h('div', { style: { fontSize: 13, fontWeight: 600 } },
              '今天：' + (today.turns || 0) + ' 轮 / ' + wan(today.totalTokens) + ' token' + cost(today)),
            h('div', { style: S.tiny },
              '新输入 ' + wan(today.inputTokens) + ' · 输出 ' + wan(today.outputTokens)
              + ' · 命中缓存 ' + wan(today.cacheReadTokens)
              + '（缓存便宜得多，命中率高不代表花得多）'),
            !u.price
              ? h('div', { style: S.tiny }, '没填单价，所以只报 token。想看到花费，在 config.local.json 的 usage.price 里按你的模型价填（每百万 token 多少钱）。')
              : null,
          )
          : null,
        today && today.rooms && today.rooms.length
          ? h('div', null,
            h('div', { style: S.tiny }, '按房间：'),
            today.rooms.map((r) => h('div', { key: r.room, style: S.item },
              h('div', { style: { flex: 1 } },
                h('div', null, r.room.replace(/^private:/, '私聊 ').replace(/^group:/, '群 ')),
                h('div', { style: S.tiny }, (r.turns || 0) + ' 轮 · ' + wan(r.totalTokens) + ' token' + cost(r)),
              ),
            )),
          )
          : null,
        u && u.days
          ? h('div', { style: { marginTop: 10 } },
            h('div', { style: S.tiny }, '最近 7 天：'),
            u.days.slice().reverse().map((d) => h('div', { key: d.date, style: S.item },
              h('div', { style: { flex: 1 } },
                h('div', null, d.date + '  ' + wan(d.totalTokens) + ' token' + cost(d)),
                h('div', { style: S.tiny }, (d.turns || 0) + ' 轮 · 输出 ' + wan(d.outputTokens)),
              ),
            )),
          )
          : null,
        h('div', { style: { marginTop: 14, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,.08)' } },
          h('div', { style: S.tiny }, '想看到花多少钱，填你用的模型单价（每百万 token，填 0 = 只报 token）：'),
          h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 } },
            priceInput('输入', 'inputPerM'),
            priceInput('输出', 'outputPerM'),
            priceInput('命中缓存', 'cacheReadPerM'),
          ),
          h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 } },
            h('span', { style: S.tiny }, '货币符号'),
            h('input', {
              value: currency,
              style: { ...S.input, width: 60 },
              onChange: (e) => setCurrency(e.target.value),
            }),
            h('button', { style: S.btn(saving), onClick: savePrice }, saving ? '保存中…' : '保存单价'),
          ),
          priceMsg ? h('div', { style: S.tiny }, priceMsg) : null,
        ),
        h('div', { style: { marginTop: 10 } }, h('div', { style: S.tiny },
          '这些数也写进了她的提示词（【今天的量】），她自己能看见；命令行 node scripts/usage.mjs 也能查。')),
        h('div', { style: { marginTop: 14, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,.08)' } },
          h('div', { style: S.tiny }, '省钱：会话里每步的上下文超过这个数，就换一个新会话（换会话不丢记忆，记忆在 events / 小本本里）。0 = 一直不换。'),
          h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' } },
            h('input', {
              type: 'number',
              value: rotate,
              style: { ...S.input, width: 96 },
              onChange: (e) => setRotate(e.target.value),
            }),
            h('span', { style: S.tiny }, 'token'),
            h('button', { style: S.btn(false), onClick: saveRotate }, '保存'),
          ),
          rotateMsg ? h('div', { style: S.tiny }, rotateMsg) : null,
          // 换会话那一刻，让旧会话写一张纸条给新的自己（见 src/memory/handover.mjs）
          h('div', { style: { marginTop: 10 } },
            h('div', { style: S.tiny }, '换会话时，让她把刚才那段"过程"写一张纸条留给自己（调过什么工具、为什么这么定、卡在哪）。纸条进记忆，新会话下一轮就读得到。'),
            h('div', { style: { display: 'flex', gap: 14, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' } },
              h('label', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                h(Toggle, {
                  value: !!(handover && handover.enabled),
                  onChange: (v) => saveHandover({ enabled: v }),
                }),
                h('span', { style: S.tiny }, '换会话时写交接')),
              h('label', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                h(Toggle, {
                  value: !!(handover && handover.inner),
                  onChange: (v) => saveHandover({ inner: v }),
                }),
                h('span', { style: S.tiny }, '连"没说出口的判断"一起写（会存进记忆）')),
            ),
            handoverMsg ? h('div', { style: S.tiny }, handoverMsg) : null,
          ),
        ),
      );
    }

    // ── 模型：她现在用的是哪个，能不能换 ─────────────────────────────────
    function ModelTab() {
      // 三个槽位：对话 / 决策 / 看图。各自留空 = 跟 profile 默认（后两个也留空 = 跟对话一样）。
      // 见 src/brain/model.mjs 与 src/brain/headless.mjs 的 run({ model })
      const EMPTY = { provider: '', model: '' };
      const SLOTS = [
        ['chat', '对话', '她跟你说话用这个。留空 = 跟 DSH 那个 profile 的默认。'],
        ['decide', '决策', '整理记忆、体检、写交接纸条用这个——只读文字吐 JSON，用便宜的就够。留空 = 跟对话一样。'],
        ['vision', '看图', '表情包筛选、给表情打标签用这个——要先打开图看，得是能看图的模型。留空 = 跟对话一样。'],
      ];
      const [active, setActive] = useState('chat');
      const [slots, setSlots] = useState({ chat: { ...EMPTY }, decide: { ...EMPTY }, vision: { ...EMPTY } });
      const model = slots[active] || EMPTY;
      const setModel = (next) => setSlots((s) => ({ ...s, [active]: next }));
      const [modelInfo, setModelInfo] = useState(null);
      const [modelMsg, setModelMsg] = useState('');
      const [modelTest, setModelTest] = useState(null);
      const [testing, setTesting] = useState(false);
      const loadModel = () => api('/api/model')
        .then((r) => {
          setModelInfo(r);
          const s = (r && r.slots) || {};
          const one = (v) => ({ provider: (v && v.provider) || '', model: (v && v.model) || '' });
          setSlots({ chat: one(s.chat || r?.chosen), decide: one(s.decide), vision: one(s.vision) });
        })
        .catch(() => {});
      const saveModel = async (next) => {
        const want = next || model;
        setModelMsg('');
        setModelTest(null);
        try {
          const pair = (want.provider || '').trim() && (want.model || '').trim()
            ? { provider: want.provider.trim(), model: want.model.trim() }
            : null;
          const key = active === 'decide' ? 'decideModel' : active === 'vision' ? 'visionModel' : 'model';
          await api('/api/config', { method: 'POST', body: JSON.stringify({ brain: { headless: { [key]: pair } } }) });
          const label = (SLOTS.find((s) => s[0] === active) || [])[1] || active;
          setModelMsg(pair
            ? `存好了，「${label}」这一路下一轮就用它`
            : `存好了，「${label}」回到${active === 'chat' ? ' profile 默认' : '跟对话一样'}`);
          await loadModel();
        } catch (e) {
          setModelMsg('没存上：' + e.message);
        }
      };
      const testModel = async () => {
        setTesting(true);
        setModelTest(null);
        try {
          const r = await api('/api/model/test', {
            method: 'POST',
            body: JSON.stringify({
              provider: (model.provider || '').trim(),
              model: (model.model || '').trim(),
              // 看图槽位要拿真图试——只问一句"在的"分不出它收不收图
              slot: active,
            }),
          });
          setModelTest(r);
        } catch (e) {
          setModelTest({ ok: false, error: e.message });
        } finally {
          setTesting(false);
        }
      };
      useEffect(() => { loadModel(); }, []);
      return h('div', null,
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 4 } }, '她用什么模型'),
          // 三个槽位：点哪个调哪个，下面的输入框和「你 DSH 里已经配好的」都作用于当前这个
          h('div', { style: { display: 'flex', gap: 6, marginBottom: 6 } },
            SLOTS.map(([k, label]) => {
              const on = active === k;
              const set = slots[k] || EMPTY;
              return h('button', {
                key: k,
                type: 'button',
                onClick: () => { setActive(k); setModelMsg(''); setModelTest(null); },
                title: set.provider && set.model
                  ? `${set.provider} / ${set.model}`
                  : (k === 'chat' ? '跟 profile 默认' : '跟对话一样'),
                style: {
                  padding: '5px 14px', borderRadius: 999, fontSize: 12, fontFamily: 'inherit',
                  cursor: 'pointer', transition: 'all .15s',
                  border: '1px solid ' + (on ? 'var(--dsh-color-accent, #4c8dff)' : 'rgba(76,141,255,.45)'),
                  background: on ? 'var(--dsh-color-accent, #4c8dff)' : 'transparent',
                  color: on ? '#fff' : 'inherit',
                  fontWeight: on ? 600 : 500,
                },
              }, label + (set.provider && set.model ? ' ·' : ''));
            }),
            ),
          h('div', { style: { ...S.tiny, marginBottom: 4 } },
            (SLOTS.find((s) => s[0] === active) || [])[2] || ''),
          h('div', { style: S.tiny },
            '留空两格 = 跟 DSH 那个 headless profile 的默认。填了就在每轮起进程时叠一层 patch，不动你 profile 目录里的文件。'),
          modelInfo && modelInfo.profile
            ? h('div', { style: S.tiny },
              '这个 profile 的默认：' + modelInfo.profile.provider + ' / ' + modelInfo.profile.model)
            : null,
          modelInfo && modelInfo.profileError
            ? h('div', { style: S.tiny }, '读不到 profile 默认：' + modelInfo.profileError)
            : null,
          h('div', { style: S.tiny },
            ['现在生效 —— 对话：', '决策：', '看图：'].map((label, i) => {
              const v = [modelInfo && modelInfo.slots && modelInfo.slots.chat,
                modelInfo && modelInfo.slots && modelInfo.slots.decide,
                modelInfo && modelInfo.slots && modelInfo.slots.vision][i];
              const txt = v && v.provider ? `${v.provider} / ${v.model}` : (i === 0 ? '跟 profile 默认一致' : '跟对话一样');
              return label + txt;
            }).join('；')),
          h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' } },
            h('input', {
              value: model.provider,
              placeholder: 'provider，如 deepseek-official',
              list: 'qad-provider-hints',
              style: { ...S.input, width: 200 },
              onChange: (e) => setModel({ ...model, provider: e.target.value }),
            }),
            h('datalist', { id: 'qad-provider-hints' },
              ((modelInfo && modelInfo.providers) || []).map((p) => h('option', { key: p, value: p })),
            ),
            h('input', {
              value: model.model,
              placeholder: 'model，如 deepseek-flash',
              style: { ...S.input, width: 220 },
              onChange: (e) => setModel({ ...model, model: e.target.value }),
            }),
            h('button', { style: S.btn(false), onClick: () => saveModel() }, '保存'),
            h('button', { style: S.btn(testing), onClick: testModel },
              testing ? '试跑中…' : (active === 'vision' ? '拿一张图试一下' : '试一下')),
            h('button', { style: S.btn(false), onClick: () => { const empty = { provider: '', model: '' }; setModel(empty); saveModel(empty); } }, '恢复默认'),
          ),
          // 他本机 DSH 里已经配好的（读 profile 文件来的）——做成一眼就知道能点的样子
          modelInfo && modelInfo.known && modelInfo.known.length
            ? h('div', { style: { ...S.card, marginTop: 10, background: 'rgba(76,141,255,.06)' } },
              h('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 2 } },
                '你 DSH 里已经配好的 ← 点一下就选它'),
              h('div', { style: { ...S.tiny, marginBottom: 8 } },
                '下面每一个模型都是一颗按钮。点一下填进上面两格，再点「保存」才算定；点错了重选就行。'),
              modelInfo.known.map((k) => h('div', {
                key: k.id,
                style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '6px 0' },
              },
                h('span', {
                  style: { fontSize: 12, fontWeight: 600, minWidth: 120 },
                  title: k.from + '  ' + (k.baseURL || ''),
                },
                  k.id,
                  k.hasKey ? null : h('span', { style: { ...S.tiny, marginLeft: 4 } }, '（没找到密钥）'),
                ),
                (k.models && k.models.length ? k.models : ['（这家没写模型，手动填）']).map((m) => {
                  const label = m.startsWith('（这家没写模型') ? m : m;
                  const on = model.provider === k.id && model.model === label;
                  return h('button', {
                    key: m,
                    type: 'button',
                    title: [(k.baseURL || ''), k.from, on ? '（现在就选着这个）' : '点一下选它'].filter(Boolean).join(' · '),
                    style: {
                      padding: '5px 12px',
                      borderRadius: 999,
                      fontSize: 12,
                      fontFamily: 'inherit',
                      lineHeight: 1.3,
                      cursor: 'pointer',
                      transition: 'all .15s',
                      border: '1px solid ' + (on
                        ? 'var(--dsh-color-accent, #4c8dff)'
                        : 'rgba(76,141,255,.65)'),
                      background: on ? 'var(--dsh-color-accent, #4c8dff)' : 'rgba(76,141,255,.12)',
                      color: on ? '#fff' : 'inherit',
                      fontWeight: on ? 600 : 500,
                      boxShadow: on ? '0 0 0 2px rgba(76,141,255,.25)' : 'none',
                    },
                    onMouseEnter: (e) => { if (!on) e.currentTarget.style.background = 'rgba(76,141,255,.28)'; },
                    onMouseLeave: (e) => { if (!on) e.currentTarget.style.background = 'rgba(76,141,255,.12)'; },
                    onClick: () => setModel({
                      provider: k.id,
                      model: m.startsWith('（这家没写模型') ? '' : m,
                    }),
                  }, on ? '✓ ' + label : label);
                }),
              )),
              h('div', { style: { ...S.tiny, marginTop: 6 } },
                model.provider && model.model
                  ? '现在选着：' + model.provider + ' / ' + model.model + '（点了「保存」才真的切过去）'
                  : '还没选。留空 = 跟 profile 默认。'),
            )
            : null,
          modelMsg ? h('div', { style: S.tiny }, modelMsg) : null,
          modelTest
            ? h('div', { style: S.tiny },
              modelTest.ok
                ? '试跑成功（' + modelTest.ms + 'ms）：' + (modelTest.text || '（空回答）')
                : '试跑失败（' + (modelTest.ms || 0) + 'ms）：' + (modelTest.error || '未知错误'))
            : null,
          h('div', { style: S.tiny },
            '注意：能用的 provider 取决于这个 profile 装了哪些适配器。写错了她下一句会回 NO_ADAPTER / MISSING_CREDENTIAL —— 先点「试一下」。'),
        ),
        h('div', { style: { ...S.card, marginTop: 14 } },
          h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 4 } }, '想用别的模型？在 DSH 里加一次就行'),
          h('div', { style: S.tiny },
            '这个面板不用再单独填一遍地址和密钥：去 DSH 设置里「添加提供商」加一家（中转站、自建网关都行），',
            '存好之后回到这一页，它就会出现在上面那份「你 DSH 里已经配好的」列表里，点一下就能选。'),
          h('div', { style: { ...S.tiny, marginTop: 4 } },
            '列表里没有？点「刷新」重读一次（面板右上角那份配置会在 1 分钟内缓存，刷新会强制重读）。'),
        ),
      );
    }

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

    const VOICE_SCOPES = [['private', '私聊'], ['group', '群聊'], ['global', '全局兜底']];

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
      // 口吻样例：把「她平时怎么说话」钉住（挑旧话里短的，比在末尾写规矩有用）
      // 私聊和群聊的腔调不一样，所以分开存、分开挑，别让两边打架
      const [voiceStore, setVoiceStore] = useState({ global: [], private: [], group: [], rooms: {} });
      const [voiceScope, setVoiceScope] = useState('private');
      const [voiceBusy, setVoiceBusy] = useState(false);
      const loadVoice = useCallback(async () => {
        try {
          const r = await api('/api/voice');
          setVoiceStore(r.store || { global: [], private: [], group: [], rooms: {} });
        } catch { setVoiceStore({ global: [], private: [], group: [], rooms: {} }); }
      }, []);
      useEffect(() => { loadVoice(); }, [loadVoice]);
      const pickVoice = async () => {
        setVoiceBusy(true);
        try {
          const r = await api('/api/voice', { method: 'POST', body: JSON.stringify({ action: 'pick', n: 5, scope: voiceScope }) });
          if (r.ok) { await loadVoice(); setMsg('给「' + voiceScope + '」挑了 ' + (r.samples || []).length + ' 句，下一轮就按这个腔调说话'); } else { setMsg(''); setErr(r.error || '没挑到'); }
        } catch (e) { setErr(e.message); }
        setVoiceBusy(false);
      };
      const clearVoice = async () => {
        setVoiceBusy(true);
        try {
          await api('/api/voice', { method: 'POST', body: JSON.stringify({ action: 'clear', scope: voiceScope }) });
          await loadVoice(); setMsg('「' + voiceScope + '」的样例清掉了，这一档她只靠人设卡说话');
        } catch (e) { setErr(e.message); }
        setVoiceBusy(false);
      };

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
        // 口吻样例：人设漂走多半是"照着最近的自己继续说"，这几句是把她拽回来的锚
        h('div', { style: { ...S.item, marginBottom: 10, flexDirection: 'column', alignItems: 'stretch', gap: 6 } },
          h('div', { style: { fontSize: 12 } },
            '口吻样例（每轮摆在她眼前，照这个样子说话）。私聊和群聊分开挑，别让两边打架：',
          ),
          h('div', { style: { display: 'flex', gap: 6 } },
            VOICE_SCOPES.map(([id, label]) =>
              h('div', { key: id, style: S.tab(voiceScope === id), onClick: () => setVoiceScope(id) }, label),
            ),
          ),
          ((voiceStore[voiceScope] || []).length
            ? (voiceStore[voiceScope] || []).map((v, i) => h('div', { key: i, style: { ...S.tiny, paddingLeft: 8 } }, '· ' + v))
            : h('div', { style: { ...S.tiny, paddingLeft: 8 } },
              '这一档还没有样例 —— 点下面的按钮，从这一档里挑几句。'
              + (voiceStore.global && voiceStore.global.length ? '（现在暂时用全局那 ' + voiceStore.global.length + ' 句兜底）' : ''),
            )
          ),
          Object.keys(voiceStore.rooms || {}).length
            ? h('div', { style: { ...S.tiny, paddingLeft: 8 } }, '另有 ' + Object.keys(voiceStore.rooms).length + ' 个房间单独设了样例（房间优先，其次是这一档，最后是全局）')
            : null,
          h('div', { style: { display: 'flex', gap: 8, marginTop: 4 } },
            h('button', { style: S.btn(true), disabled: voiceBusy, onClick: pickVoice }, voiceBusy ? '挑…' : '从这一档挑几句'),
            h('button', { style: S.btn(false), disabled: voiceBusy || !(voiceStore[voiceScope] || []).length, onClick: clearVoice }, '清掉这一档'),
          ),
        ),
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
          h(Row, { label: '你在跟她聊时' },
            h(Toggle, {
              value: (f.pauseWhileOwnerChats !== false),
              onChange: (v) => setIn('freeTime.pauseWhileOwnerChats', v),
            }), h('span', { style: S.hint }, '停表——聊多久就把这段时间还给她多久；关掉只是这一拍让路，时间照走')),
          h(Row, { label: '你刚说过话就让路' },
            h(Num, { value: Math.round((Number(f.skipIfActiveMs ?? 300000)) / 60000), step: 1, onChange: (v) => setIn('freeTime.skipIfActiveMs', Math.max(0, Number(v)) * 60000) }),
            h('span', { style: S.hint }, '分钟内不打扰（也是停表后等你安静多久才继续），0 = 不停表')),
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
                  ? `还剩 ${Math.round(s.remainingMs / 60000)} 分钟 · 已 ${s.beats} 拍 · 说了 ${s.messages}/${s.maxMessages} 句${s.paused ? ` · 你在跟她聊，停表中（已停 ${Math.round((s.pausedMs || 0) / 1000)} 秒）` : ''}`
                  : (s.reason ? `上一段：${s.reason}` : '没在自由活动'))
              : null,
          ),
          // 咽回去几次、每拍想多久——这两个数偏大就说明拍太长，该调短
          s && (s.beats || s.swallowed)
            ? h('div', { style: { ...S.tiny, marginTop: 4 } },
                `咽回去 ${s.swallowed || 0} 次`,
                s.swallowWhy ? `（最近一次：${s.swallowWhy}）` : '',
                s.avgThinkMs ? ` · 平均每拍想 ${Math.round(s.avgThinkMs / 1000)} 秒` : '',
                s.draft ? ` · 手上还压着一句没发：「${String(s.draft.text).slice(0, 24)}」` : '')
            : null,
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
        setNote('正在唤醒…（第一次要等它登录，最长一分钟）');
        try {
          const r = await api('/api/snowluma/up', { method: 'POST' });
          if (r && r.ok) {
            setNote(r.note || (r.started ? '起来了' : '本来就在跑'));
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
        ['usage', '用量'],
        ['model', '模型'],
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
        tab === 'usage' ? h(UsageTab) : null,
        tab === 'model' ? h(ModelTab) : null,
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
