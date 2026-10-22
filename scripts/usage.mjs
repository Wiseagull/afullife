// 看用量：今天花了多少、都花在哪个房间、最近几天什么趋势。
//
//   node scripts/usage.mjs            今天
//   node scripts/usage.mjs 7          最近 7 天
//   node scripts/usage.mjs rooms      今天按房间拆开（默认也会列）
//
// 这些数记在 data/usage/usage-YYYY-MM-DD.jsonl，一行一轮，只追加。
import { loadConfig } from '../src/config.mjs';
import { UsageStore, describeUsage } from '../src/usage/store.mjs';

const cfg = loadConfig({ cli: {} });
const price = cfg.usage?.price || null;
const currency = cfg.usage?.currency || '¥';
const store = new UsageStore({ dir: cfg.usage?.dir || 'data/usage' });

const arg = (process.argv[2] || '').trim();
const days = Number(arg) > 0 ? Number(arg) : 1;

if (days === 1) {
  const t = store.today(undefined, { price });
  console.log(`今天：${describeUsage(t, { price, currency })}`);
  if (t.rooms.length) {
    console.log('按房间：');
    for (const r of t.rooms) {
      const name = r.room.replace(/^private:/, '私聊 ').replace(/^group:/, '群 ');
      console.log(`  ${name.padEnd(18)} ${describeUsage(r, { price, currency })}`);
    }
  }
} else {
  const list = store.days(days, { price });
  console.log(`最近 ${days} 天：`);
  for (const d of list) {
    const bar = d.totalTokens ? '█'.repeat(Math.min(20, Math.max(1, Math.round(d.totalTokens / 20000)))) : '';
    console.log(`  ${d.date}  ${describeUsage(d, { price, currency }).padEnd(34)} ${bar}`);
  }
  const sum = list.reduce((a, d) => {
    const o = { ...a };
    for (const k of ['turns', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens']) o[k] = (a[k] || 0) + (d[k] || 0);
    return o;
  }, {});
  const cost = list.reduce((a, d) => a + (d.cost || 0), 0);
  console.log(`合计：${describeUsage(sum, { price: null })}${price ? ` / ${currency}${Math.round(cost * 10000) / 10000}` : ''}`);
}
