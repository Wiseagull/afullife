// OneBot 客户端：一条长连 WS 收事件，HTTP 发动作。
// 只负责“连得上、掉线能回来、动作能发出去”，不做业务判断。
import { EventEmitter } from 'node:events';

const MIN_BACKOFF = 1000;
const MAX_BACKOFF = 30000;

export class OneBotClient extends EventEmitter {
  #ws = null;
  #closed = false;
  #fails = 0;
  #timer = null;
  #selfId = '';
  #selfName = '';
  #connecting = false;

  constructor({ wsUrl, httpUrl, accessToken = '', httpToken = '', timeoutMs = 10000 }) {
    super();
    this.wsUrl = String(wsUrl || '');
    this.httpUrl = String(httpUrl || '').replace(/\/+$/, '');
    this.accessToken = String(accessToken || '');
    this.httpToken = String(httpToken || accessToken || '');
    this.timeoutMs = timeoutMs;
  }

  get selfId() { return this.#selfId; }
  get selfName() { return this.#selfName; }
  get connected() { return this.#ws?.readyState === 1; }

  connect() {
    this.#closed = false;
    this.#open();
    return this;
  }

  close() {
    this.#closed = true;
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; }
    try { this.#ws?.close(); } catch { /* ignore */ }
    this.#ws = null;
  }

  #schedule(reason) {
    if (this.#closed) return;
    this.#fails += 1;
    const delay = Math.min(MAX_BACKOFF, MIN_BACKOFF * 2 ** (this.#fails - 1));
    this.emit('status', { connected: false, reason: String(reason || ''), retryInMs: delay });
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => { this.#timer = null; this.#open(); }, delay);
  }

  #open() {
    if (this.#closed || this.#connecting) return;
    this.#connecting = true;

    const sep = this.wsUrl.includes('?') ? '&' : '?';
    const url = this.accessToken
      ? `${this.wsUrl}${sep}access_token=${encodeURIComponent(this.accessToken)}`
      : this.wsUrl;

    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.#connecting = false;
      this.#schedule(err?.message ?? err);
      return;
    }
    this.#ws = ws;
    const current = (s) => this.#ws === s;

    ws.addEventListener('open', async () => {
      if (!current(ws)) return;
      this.#connecting = false;
      this.#fails = 0;
      this.emit('status', { connected: true, reason: '' });
      try {
        const info = await this.call('get_login_info');
        this.#selfId = String(info?.user_id ?? '');
        this.#selfName = String(info?.nickname ?? '');
        this.emit('ready', { selfId: this.#selfId, selfName: this.#selfName });
      } catch (err) {
        // 连上了但拿不到身份：不代表不可用，等事件里带 self_id 再补
        this.emit('status', { connected: true, reason: `get_login_info: ${err?.message ?? err}` });
      }
    });

    ws.addEventListener('message', (ev) => {
      if (!current(ws)) return;
      const raw = typeof ev.data === 'string' ? ev.data : '';
      if (!raw) return;
      let parsed;
      try { parsed = JSON.parse(raw); } catch { return; }
      if (!this.#selfId && parsed?.self_id) this.#selfId = String(parsed.self_id);
      this.emit('event', parsed);
    });

    ws.addEventListener('error', (err) => {
      if (!current(ws)) return;
      this.emit('status', { connected: false, reason: `ws error: ${err?.message ?? 'unknown'}` });
    });

    ws.addEventListener('close', (ev) => {
      if (!current(ws)) return;
      this.#connecting = false;
      this.#ws = null;
      if (this.#closed) return;
      this.#schedule(`closed(${ev?.code ?? ''})`);
    });
  }

  /** 调一个 OneBot 动作，返回 data 段。 */
  async call(action, params = {}) {
    if (!this.httpUrl) throw new Error('httpUrl 未配置');
    const res = await fetch(`${this.httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.httpToken ? { Authorization: `Bearer ${this.httpToken}` } : {}),
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* keep null */ }
    if (!res.ok) throw new Error(`${action} HTTP ${res.status}: ${text.slice(0, 200)}`);
    if (!json) throw new Error(`${action} 返回非 JSON: ${text.slice(0, 200)}`);
    if (json.status === 'failed' || (json.retcode != null && json.retcode !== 0)) {
      throw new Error(`${action} 失败 retcode=${json.retcode}: ${json.message || json.wording || text.slice(0, 200)}`);
    }
    return json.data;
  }
}
