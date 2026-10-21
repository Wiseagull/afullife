// 闸本体：把规则用在一次工具调用上，并记住"这一条他刚答应了"。
//
// 做的事很少：判断 —— 记账 —— 回答"能不能过"。
// 不做的事：不解释、不心软、不猜"它应该没恶意"。
//
// 放行靠两把钥匙：
//  · 精确钥匙：同一条命令（空白归一，去掉 description 这类会变的东西）。
//  · 退一步钥匙：同一类规则，只放一次。因为模型重跑时措辞几乎必然有出入，
//    死抠字面会变成"拦—问—再拦"的死循环。

import { classify, underWorkspace } from './rules.mjs';

const normCmd = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** 用来比对的"核心"——不把会变的字段算进去。 */
export function signature(tool, input = {}) {
  if (tool === 'pwsh' || tool === 'ops_bash' || tool === 'bash') {
    return `${tool}|${normCmd(input.command)}`;
  }
  if (tool === 'write' || tool === 'edit' || tool === 'ops_write_file' || tool === 'ops_edit_file') {
    const p = String(input.file_path || input.path || input.filePath || '').replace(/\//g, '\\').toLowerCase();
    return `${tool}|${p}`;
  }
  return `${tool}|${JSON.stringify(input || {})}`;
}

export class Gate {
  /**
   * @param {object} opts
   * @param {object} [opts.logger]
   * @param {(entry:object)=>void} [opts.onAudit] 每条 note/block 都回调一次，用来写 events
   */
  constructor({ logger, onAudit } = {}) {
    this.logger = logger;
    this.onAudit = onAudit;
    /** @type {Set<string>} 他答应过的具体那一条 */
    this.allowOnce = new Set();
    /** @type {Set<string>} 他答应的那一类规则（整轮有效，这一轮结束就作废） */
    this.turnRules = new Set();
    /** @type {{tool:string,input:object,verdict:object}|null} 最近一次被拦的东西 */
    this.blocked = null;
    this.stats = { allow: 0, note: 0, block: 0 };
  }

  /** 他答应了这一条。 */
  approve(tool, input) {
    this.allowOnce.add(signature(tool, input));
  }

  /** 他答应了这一类：这一轮剩下的时间都放它过去，这一轮结束就收。 */
  approveRule(ruleId) {
    if (ruleId) this.turnRules.add(ruleId);
  }

  /** 一轮结束：把"这一轮有效"的钥匙收回来。 */
  endTurn() {
    this.turnRules.clear();
  }

  /** 他拒绝了：清掉，什么都不留。 */
  reject() {
    this.blocked = null;
  }

  /** 判断一次调用。命中"他刚答应过"的，直接放过。 */
  check(tool, input) {
    const sig = signature(tool, input);
    if (this.allowOnce.has(sig)) {
      this.allowOnce.delete(sig);
      this.stats.allow += 1;
      this.logger?.info?.(`[gate] 放行（他答应的那一条）：${normCmd(input?.command).slice(0, 120)}`);
      return { level: 'allow', ruleId: 'approved-once', why: '他刚答应过这一条', detail: '' };
    }

    const v = classify(tool, input);
    this.stats[v.level] += 1;

    if (v.level !== 'allow') this.onAudit?.({ tool, input, verdict: v });

    if (v.level !== 'block') {
      if (v.level === 'note') this.logger?.info?.(`[gate] ${v.ruleId}：${v.why}`);
      return v;
    }

    // 同一类规则的"这一轮放行"
    if (this.turnRules.has(v.ruleId)) {
      this.stats.allow += 1;
      this.logger?.info?.(`[gate] 放行（这一轮他答应过：${v.ruleId}）：${normCmd(input?.command).slice(0, 120)}`);
      return { level: 'allow', ruleId: 'approved-turn', why: `这一轮他答应过：${v.why}`, detail: '' };
    }

    this.blocked = { tool, input, verdict: v };
    this.logger?.warn?.(`[gate] 拦下 ${tool}：${v.why}`);
    return v;
  }
}

export { classify, underWorkspace };
