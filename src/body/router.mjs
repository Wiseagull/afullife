// 路由：这条消息该不该叫醒脑子。
// 判断全是本地计算，零成本 —— 开不开口的细节交给脑子自己看着办（人设在那儿）。
//
// 判定思路参考了 QQ Agent 的「逐条判定，一次定生死」，社交状态机的分层参考了 qq-bridge：
//   观望(diving) → 活跃(active) → 冷场试探 → 退场回观望
//   私聊恒响应 > @我 > 关键词 > 活跃期 > 观望期被点着 > 听着
export function createRouter({ cfg, now = () => Date.now(), random = Math.random }) {
  const owners = new Set((cfg.owner.userIds || []).map(String));
  // 关键词每轮现读：面板里能改 group.keywords，启动时算一次就再也跟不上。
  // 顺手 trim 一下：面板里手输的词常常带前后空格，不剪掉的话「全是空格的词」
  // 会留在列表里，`text.includes('  ')` 能把任何带两个空格的话都判成命中。
  const keywordList = () => (cfg.group?.keywords || [])
    .map((k) => String(k || '').trim().toLowerCase())
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
      // 主人的私聊：只要配了号就一直应。
      if (owners.size && owners.has(String(msg.from))) return { speak: true, reason: 'owner-private' };
      if (cfg.owner.privatePolicy !== 'all') {
        return { speak: false, reason: owners.size ? 'not-owner' : 'no-owner-configured' };
      }
      // 2026-10-22（主人 m13194）：别人的私聊也按群聊那套走——
      // 不因为"是私聊"就每句都接，该观望就观望，该冷场就冷场。
      // 落到下面群聊那段，用同一个房间键算状态。
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
    const hit = keywordList().find((k) => text.includes(k));
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

  return {
    decide, markSpoke, idleCheck, proactiveCheck, stateOf, enterActive, owners,
    // getter：每次访问现算，外面改完 group.keywords 不用重造 router
    get keywords() { return keywordList(); },
  };
}
