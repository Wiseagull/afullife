// 让某个房间（或全部）换一个新会话。
// 会话一旦创建就把沙箱档位钉死了，改了环境变量也只对**新会话**生效 ——
// 所以权限改了、人格改了之后，要换窗口，不是等它自己变。
//
// 用法：node scripts/new-session.mjs [房间号]   # 不给就全清
import path from 'node:path';
import { SessionMap } from '../src/memory/sessions.mjs';
import { ROOT } from '../src/config.mjs';

const file = path.join(ROOT, 'data', 'sessions.json');
const map = new SessionMap({ file });
const room = process.argv[2];

if (room) {
  const had = map.get(room);
  map.clear(room);
  console.log(had ? `已换新：${room}（旧 ${had}）` : `${room} 本来就没有会话`);
} else {
  const all = map.entries();
  for (const e of all) map.clear(e.room);
  console.log(`已清空 ${all.length} 个房间的会话，下次开口会开新的`);
}
