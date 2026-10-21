// 兴趣清单的小工具（她自己也会用这个）。
//
//   node scripts/interests.mjs sync                 # 把 persona/self.md 里新写的兴趣导进来
//   node scripts/interests.mjs list                 # 看看都有什么、上次什么时候做的
//   node scripts/interests.mjs pick [--n=3]         # 今天可以干这三件（挑出来给你看）
//   node scripts/interests.mjs add "看星星" --why="晚上安静"   # 添一件新的
//   node scripts/interests.mjs did "画画" "画完了有点空"        # 记一次做过
//   node scripts/interests.mjs drop "收拾东西"
//
// 挑的顺序不是随机：越久没碰、做得越少的排前面；self.md 里排在前面的权重高一点。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadConfig, interestFile, personaFile } from '../src/config.mjs';
import { InterestStore } from '../src/interests/store.mjs';

const cfg = loadConfig({ cli: {} });
const store = new InterestStore({ file: interestFile(cfg) });

const [cmd, ...rest] = process.argv.slice(2);
const arg = (name, dflt) => {
  const hit = rest.find((x) => x.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const positional = rest.filter((x) => !x.startsWith('--'));

const dayAgo = (ts) => {
  if (!ts) return '还没做过';
  const d = Math.round((Date.now() - ts) / 86400000);
  return d <= 0 ? '今天做过' : `${d} 天前`;
};

if (!cmd) {
  console.log('用法：sync | list | pick [--n=3] | add "名字" --why="…" | did "名字" "感觉" | drop "名字"');
  process.exit(0);
}

if (cmd === 'sync') {
  const file = personaFile(cfg, 'self');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch {
    console.error(`读不到 self.md：${file}`);
    process.exit(1);
  }
  const r = store.sync(text);
  console.log(r.added.length ? `新收进 ${r.added.length} 条：${r.added.join('、')}` : '没有新的');
  console.log(`清单里现在 ${r.total} 条`);
  process.exit(0);
}

if (cmd === 'list') {
  const items = store.all().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  if (!items.length) console.log('清单是空的。先 sync 一下，或者 add 一条。');
  for (const it of items) {
    const idle = store.idleDays(it);
    const cold = idle > 14 && it.count > 0 ? ' ·凉了' : '';
    const last = it.feelings?.length ? ` — ${it.feelings[it.feelings.length - 1]}` : '';
    console.log(`${it.id}  ${it.name}  （做过 ${it.count} 次，${dayAgo(it.lastAt)}${cold}）${last}`);
  }
  process.exit(0);
}

if (cmd === 'pick') {
  const n = Number(arg('n', 3));
  const picked = store.pick(n);
  if (!picked.length) console.log('清单是空的。先 sync 一下，或者 add 一条。');
  for (const it of picked) {
    console.log(`- ${it.name}（${it.count ? `${dayAgo(it.lastAt)}做过` : '还没做过'}）${it.why ? ` — ${it.why}` : ''}`);
  }
  process.exit(0);
}

if (cmd === 'add') {
  const name = positional[0];
  if (!name) { console.error('给个名字：add "看星星" --why="晚上安静"'); process.exit(1); }
  const it = store.add({ name, why: arg('why', '') });
  console.log(`记下了：${it.id} ${it.name}`);
  process.exit(0);
}

if (cmd === 'did') {
  const name = positional[0];
  if (!name) { console.error('做了哪件：did "画画" "画完了有点空"'); process.exit(1); }
  const r = store.did(name, positional[1] || '');
  console.log(r ? `记下：${r.name} 第 ${r.count} 次` : `清单里没有「${name}」`);
  process.exit(0);
}

if (cmd === 'drop') {
  const name = positional[0];
  const ok = store.drop(name || '');
  console.log(ok ? `去掉了「${name}」` : `清单里没有「${name}」`);
  process.exit(0);
}

console.log('用法：sync | list | pick [--n=3] | add "名字" --why="…" | did "名字" "感觉" | drop "名字"');
console.log('（工作目录：' + ROOT + '）');
