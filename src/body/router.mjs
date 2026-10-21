// 路由：这条消息该不该叫醒脑子。
// 判断全是本地计算，零成本 —— 开不开口的细节交给脑子自己看着办（人设在那儿）。
//
// 判定思路参考了 QQ Agent 的「逐条判定，一次定生死」，社交状态机的分层参考了 qq-bridge：
//   观望(diving) → 活跃(active) → 冷场试探 → 退场回观望
//   私聊恒响应 > @我 > 关键词 > 活跃期 > 观望期被点着 > 听着
export function createRouter({ cfg, now = () => Date.now(), random = Math.random }) {
  const owners = new Set((cfg.owner.userIds || []).map(String));
  const keywords = (cfg.group?.keywords || [])
    .map((k) => String(k || '').toLowerCase())
    .filter(Boolean);

  const socialCfg = () => cfg.group?.social || {};
  const roomState = new Map();

  function ensure(key) {
    let s = roomState.get(key);
    if (!s) {
      s = { state: 'diving', activeUntil: 0, lastMsgAt: 0, idleTriedAt: 0, lastSpokeAt: 0 };
      roomState.set(key, s);
    }
    return s;
  }

  function enterActive(roomKey) {
    const s = ensure(roomKey);
    const c = socialCfg();
    s.state = 'active';
    s.activeUntil = now() + Math.max(0, Number(c.activeDurationMs ?? 1200000));
    s.idleTriedAt = 0;
  }

  /** 到点了就退场，别在群里赖着不走。 */
  function retire(roomKey) {
    const s = ensure(roomKey);
    if (s.state === 'active' && now() >= s.activeUntil) s.state = 'diving';
    return s.state;
  }

  function markSpoke(roomKey) {
    const s = ensure(roomKey);
    s.lastSpokeAt = now();
    enterActive(roomKey);
  }

  function touch(roomKey) {
    const s = ensure(roomKey);
    s.lastMsgAt = now();
    return s;
  }

  function decide(msg, { roomKey } = {}) {
    if (!msg) return { speak: false, reason: 'not-message' };

    if (msg.kind === 'private') {
      if (cfg.owner.privatePolicy === 'all') return { speak: true, reason: 'private-all' };
      if (!owners.size) return { speak: false, reason: 'no-owner-configured' };
      if (!owners.has(String(msg.from))) return { speak: false, reason: 'not-owner' };
      return { speak: true, reason: 'owner-private' };
    }

    if (cfg.group?.enabled === false) return { speak: false, reason: 'group-disabled' };

    const key = String(roomKey || msg.room || '');
    const c = socialCfg();
    touch(key);

    if (msg.atMe) {
      enterActive(key);
      return { speak: true, reason: 'called-me' };
    }

    const text = String(msg.text || '').toLowerCase();
    const hit = keywords.find((k) => text.includes(k));
    if (hit) {
      enterActive(key);
      return { speak: true, reason: `keyword:${hit}` };
    }

    if (c.enabled === false) return { speak: false, reason: 'social-off' };
    if (retire(key) === 'active') {
      // 选择性沉默：真人在群里也会漏看一半
      const skip = Math.max(0, Math.min(1, Number(c.skipProbability ?? 0)));
      if (skip > 0 && random() < skip) return { speak: false, reason: 'skip' };
      return { speak: true, reason: 'active' };
    }

    const trig = Math.max(0, Math.min(1, Number(c.triggerProbability ?? 0)));
    if (trig > 0 && random() < trig) {
      enterActive(key);
      return { speak: true, reason: 'social' };
    }

    return { speak: false, reason: 'diving' };
  }

  /**
   * 冷场检查（主循环定时调）：活跃期里没人说话久了，试探一句；
   * 试探完还没人理，就退场。
   * @returns {null|'idle-probe'|'retire'}
   */
  function idleCheck(roomKey) {
    const c = socialCfg();
    if (c.enabled === false) return null;
    const s = ensure(String(roomKey));
    if (s.state !== 'active') return null;

    const t = now();
    if (t >= s.activeUntil) {
      s.state = 'diving';
      return 'retire';
    }
    if (t - s.lastMsgAt < Number(c.idleWindowMs ?? 0)) return null;

    if (!s.idleTriedAt) {
      s.idleTriedAt = t;
      const p = Math.max(0, Math.min(1, Number(c.idleRetryProbability ?? 0)));
      return random() < p ? 'idle-probe' : null;
    }
    if (t - s.idleTriedAt >= Number(c.idleRetryWaitMs ?? 0)) {
      s.state = 'diving';
      return 'retire';
    }
    return null;
  }

  /** 群安静了很久：要不要主动找个话题开口。 */
  function proactiveCheck(roomKey) {
    const p = socialCfg().proactive || {};
    if (p.enabled === false) return false;
    const s = ensure(String(roomKey));
    const t = now();
    if (t - s.lastMsgAt < Number(p.idleThresholdMs ?? 0)) return false;
    return random() < Math.max(0, Math.min(1, Number(p.probability ?? 0)));
  }

  function stateOf(roomKey) {
    const s = ensure(String(roomKey));
    retire(roomKey);
    return s.state;
  }

  return { decide, markSpoke, idleCheck, proactiveCheck, stateOf, enterActive, owners, keywords };
}
