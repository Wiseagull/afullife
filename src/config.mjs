// 配置：默认值 ← config.local.json ← 命令行覆盖。
// 令牌不用手抄：启动时自己去找 SnowLuma，从它自己的 config/onebot_*.json 里读出来。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findDir as findSnowLumaDir, readOneBotConfig } from './snowluma/onebot-config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');

const DEFAULTS = {
  onebot: {
    wsUrl: 'ws://127.0.0.1:3001',
    httpUrl: 'http://127.0.0.1:3000',
    accessToken: '',
    httpToken: '',
    // 下面两个一般留空：留空就自动从 SnowLuma 的配置里读
    uin: '',                  // 有好几个号登录过时，指定用哪一个
    credentialsFrom: '',      // 高级用法：从别的 json 里读，格式见 README
  },
  owner: {
    // 主人号：只有这些号能让她动手（改文件、跑命令都要它点头）；
    // 别人的私聊照样会回，只是没有动手的权限。
    userIds: [],
    privatePolicy: 'all',     // all = 谁都回；owner-only = 只回主人
  },
  group: {
    enabled: true,
    speakOnAt: true,          // @ 我就必回
    speakOnName: true,
    keywords: [],            // 想让她的名字/口令触发回应，自己往这里填 // 出现就必须响应，不分大小写
    names: [],                // 机器人的别名，命中就算叫我
    // 社交：观望 → 活跃 → 退场（分层思路参考 qq-bridge 的状态机，代码是自己写的）
    social: {
      enabled: true,
      triggerProbability: 0.1,      // 观望期，普通一句被点着的概率
      activeDurationMs: 1200000,    // 活跃期最长 20 分钟，到点自己收尾退场
      idleWindowMs: 360000,         // 6 分钟没人说话算冷场
      idleRetryProbability: 0.25,   // 冷场时试探一句的概率
      idleRetryWaitMs: 120000,      // 试探后等 2 分钟，还没人理就回观望
      skipProbability: 0.15,        // 普通闲聊选择性沉默的概率（真人会漏看）
      proactive: {
        enabled: true,              // 群安静很久时，主动找个话题开口
        idleThresholdMs: 1800000,   // 安静满 30 分钟才算"冷场"
        checkMinMs: 2700000,        // 判定间隔 45–90 分钟
        checkMaxMs: 5400000,
        probability: 0.2,           // 每次判定真的开口的概率
      },
    },
  },
  // 用量账本：每轮 token 记在 data/usage/，面板和她自己都能看。
  // 单价留 0 = 不显示钱（只报 token）；想看到花费就按你的模型价填。
  usage: {
    dir: 'data/usage',
    currency: '¥',
    price: { inputPerM: 0, outputPerM: 0, cacheReadPerM: 0 },
  },
  notebook: {
    dir: 'notebook',      // 她那本小本本放哪（相对项目根）
    limitMb: 20480,        // 整个目录上限，默认 20GB
  },
  upkeepMs: 6 * 60 * 60 * 1000,  // 记忆体检（修记坏的，不看新流水）
  // 收下来的图（data/images）：按天数 + 总容量清，删最旧的
  images: {
    retainDays: 7,             // 留几天（0 = 不按天数删）
    maxMb: 2048,               // 目录总容量上限（MB）
  },
  videos: {
    retainDays: 7,             // 视频比图占地，默认同样留 7 天
    maxMb: 4096,               // 整个 videos/ 目录的上限（MB）
    maxFileMb: 200,            // 单个视频超过这个就不落盘，只留地址
  },
  // 自由活动：给她一段自己的时间（看电脑、上网、想干嘛干嘛）
  freeTime: {
    // 没有 enabled 这个总开关：真正的开关是 auto.enabled（自己找时间醒）与面板上手动开一段。
    // 老版本留过一个 freeTime.enabled，代码里从来没读过——2026-10-22 外部评审指出，删掉。
    durationMs: 1800000,        // 一段多长
    beatMs: 75000,              // 每隔多久叫她一拍
    maxMessages: 3,             // 这段时间里最多主动说几句
    permission: 'look',         // look 只看不动 / act 可以动手 / full 全套
    minGapMs: 3600000,          // 两段之间至少隔多久
    skipIfActiveMs: 300000,     // 他这么久之内说过话 → 这一拍让路（0 = 不让路）
    room: '',                   // 在哪段对话里活动（空 = 主人私聊）
  },
  debounceMs: 2000,           // 连发聚批窗口（真人连环发消息，等它们凑成一批）
  // 她要干一阵活的时候，先垫一句话，别让人干等着。
  // 文案是可配的：删光了 / enabled:false 就不垫，让它安静地想。
  ack: {
    enabled: true,
    delayMs: 20000,           // 超过这么久还没回，就先说一句
    private: ['嗯……我想想'],
    group: ['（我想想…）'],
  },
  // 表情包怎么用：off 不发 / less 少发 / normal 想发就发 / always 几乎每条都带
  sticker: {
    style: 'normal',
  },
  // QQ 空间（说说）。默认关着：外发的东西不该在她自己手上没有闸地跑。
  // 打开之后她能读自己的说说、能发、能删自己刚发的那条。
  qzone: {
    enabled: false,
    maxChars: 1000,
    // 配图这条路还没通：Qzone 的图床必须传进一个已存在的相册，而这个号一个相册都没有
    // （albumsInUser: 0）。要么建一个相册（会在她空间里多一个别人看得见的相册），
    // 要么只发文字。2026-10-23 定的：只发文字。
    allowImages: false,
  },
  // 表情库上限：哪一个先到就按哪个清，用得最少的先走
  stickers: {
    maxCount: 300,
    maxMb: 200,
  },
  send: {
    maxLen: 1200,             // 单条上限
    gapMs: 350,               // 同一段长文被切开时，块与块之间的间隔
    dryRun: false,            // true = 只打印不发送
    // 空格分条：模型用空格表示"这里断成下一条"，像真人那样连着发几条
    split: {
      enabled: true,
      softMax: 120,           // 单条超过这么长就按句末断开
      perCharMs: 55,          // 打字节奏：上一条越长，等得越久
      gapMinMs: 600,
      gapMaxMs: 2600,
      maxBubbles: 8,          // 一轮最多发几条，多了并到末尾
      longGapProbability: 0.08,
      longGapMinMs: 2500,
      longGapMaxMs: 5000,
    },
  },
  // 戳一戳：三个权重按比例抽，不用凑成 1；cooldownMs 防止俩人互相戳个没完
  poke: {
    enabled: true,
    text: 0.5,        // 说一句话（交给她自己想说什么）
    poke: 0.3,        // 戳回去
    silent: 0.2,      // 不理
    cooldownMs: 30000,
  },
  safety: {
    auditReply: true,         // 发出去之前扫一遍：路径 / 凭据 / token
    // 她可以随便写的地方。留空 = 项目目录 + data + 小本本 + 她干活的工作区（启动时自动凑齐）
    workspaceRoots: [],
  },
  brain: {
    kind: 'none',             // none（只收不说话）| headless（起一次 DSH 干活）
    // headless 的具体参数（profile / workspace / timeoutMs / chatProfile / rotateAtTokens）在这里给默认，
    // 真实值一般写在 config.local.json；chatProfile 留空 = 不换 profile。
    headless: {
      // 会话里每步的上下文超过这么多 token 就换一个新会话。
      // 一轮有几步，每步都要把整段历史重看一遍——会话越长越贵，所以要定期换。
      // 0 或负数 = 不换。
      rotateAtTokens: 60000,
      // 自己加的提供商（面板「模型」页）：key 只存在本机 config.local.json，不写 DSH 凭据
      // 形状：{ <id>: { displayName, api, baseURL, apiKey|apiKeyRef, models: [{id,name}] } }
      providers: {},
      // 用哪个模型：{ provider, model }。留空（或 null）= 跟 DSH 那个 profile 的默认。
      // 填了就在起进程时用 --patch 叠一层，不改你 profile 目录里的文件。面板「模型」页能改。
      model: null,
      // 决策专用：整理记忆、体检、写交接纸条这几个后台活用它。
      // 它们只需要"读一段文字、吐一段 JSON"，用最贵的模型是浪费；留空 = 跟 model 一样。
      decideModel: null,
      // 看图专用：表情包筛选、给表情打标签用它（这些活要先 read_image 再判断）。
      // 留空 = 跟 model 一样。视觉模型便宜的话可以把这几个活全挪过去。
      visionModel: null,
      // 换会话时，让旧会话把这段"过程"写成一张交接纸条，落进记忆。
      // 不加这条也能用（靠 events 和记忆条目），加了新会话就知道刚才在忙什么。
      handover: {
        enabled: true,
        inner: true,       // 连"没说出口的判断"一起写（会存进 notes，面板里看得见）
        maxChars: 1200,
      },
    },
  },
  memory: {
    // 房间 → { read: 能不能看别处, share: 能不能让别处看 }
    // 不写就用默认：私聊两个都开，群能看不外传
    rooms: {},
  },
  web: {
    enabled: true,            // DSH 面板用的本地接口
    port: 3220,
    allowFullAccess: false,   // 面板「试一试」里是否允许给全套权限（主人自己开）
  },
  // SnowLuma（QQ 那边的客户端）：没跑就自己拉起来，默认不要窗口
  snowluma: {
    dir: '',                 // 留空 = 项目自带的 vendor/snowluma；别处装的用 scripts/find-snowluma.mjs 指一下
    launch: true,            // 桥起来时如果它没跑，就静默拉起
  },
  dataDir: 'data',
};

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(v) && isPlainObject(base?.[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** 从 SnowLuma 自己的配置里补 OneBot 令牌（找不到就返回原样，启动时会报清楚）。 */
function withCredentials(onebot, { snowluma, logger } = {}) {
  const out = { ...onebot };
  if (out.accessToken && out.httpToken) return out;

  // 高级用法：显式指定了一份 json（老的 qq-bridge / QQ Agent 格式也能读）
  if (out.credentialsFrom) {
    const sl = readJson(out.credentialsFrom)?.snowluma;
    if (sl) {
      out.accessToken = out.accessToken || String(sl.accessToken || '');
      out.httpToken = out.httpToken || String(sl.httpAccessToken || sl.accessToken || '');
      if (sl.wsUrl) out.wsUrl = String(sl.wsUrl);
      if (sl.httpUrl) out.httpUrl = String(sl.httpUrl);
      logger?.info?.('config', `令牌取自 ${out.credentialsFrom}`);
      return out;
    }
    logger?.warn?.('config', `${out.credentialsFrom} 里没有 snowluma 段，改去自动找 SnowLuma`);
  }

  // 正常路径：自己找 SnowLuma，自己读它的 OneBot 配置
  const dir = findSnowLumaDir({ configured: snowluma?.dir, root: ROOT });
  if (!dir) {
    logger?.warn?.('config', '没找到 SnowLuma：跑一句 `node scripts/find-snowluma.mjs "<SnowLuma 的目录>"` 告诉我在哪，'
      + '或者把它的整个目录放到 vendor/snowluma/，也可以在 config.local.json 里直接填 onebot 的地址和令牌');
    return out;
  }
  const found = readOneBotConfig({ dir, uin: out.uin });
  if (!found.ok) {
    logger?.warn?.('config', `找到了 SnowLuma（${dir}），但拿不到 OneBot 配置：${found.reason}`);
    return out;
  }
  out.accessToken = out.accessToken || found.accessToken;
  out.httpToken = out.httpToken || found.httpToken;
  if (found.wsUrl) out.wsUrl = found.wsUrl;
  if (found.httpUrl) out.httpUrl = found.httpUrl;
  logger?.info?.('config', `连 SnowLuma：${found.wsUrl} / ${found.httpUrl}（配置取自 ${found.file}）`);
  return out;
}

/**
 * 载入配置。
 * @param {{cli?: object, logger?: {warn: Function}}} opts
 */
export function loadConfig(opts = {}) {
  const { cli = {}, logger } = opts;

  let cfg = deepMerge(DEFAULTS, {});
  const localPath = path.join(ROOT, 'config.local.json');
  if (fs.existsSync(localPath)) {
    const local = readJson(localPath) || {};
    cfg = deepMerge(cfg, local);
  }
  cfg = deepMerge(cfg, cli);

  cfg.onebot = withCredentials(cfg.onebot, { snowluma: cfg.snowluma, logger });
  cfg.dataDir = path.isAbsolute(cfg.dataDir) ? cfg.dataDir : path.join(ROOT, cfg.dataDir);
  // 主人号只剩一个概念了：老配置里的 rootIds 并进 userIds，不再单独维护
  const legacyRoot = Array.isArray(cfg.owner.rootIds) ? cfg.owner.rootIds.map(String) : [];
  cfg.owner.userIds = [...new Set([...(cfg.owner.userIds || []).map(String), ...legacyRoot])].filter(Boolean);
  delete cfg.owner.rootIds;

  return cfg;
}

export function ensureDirs(cfg) {
  for (const sub of ['', 'rooms', 'memory', 'events', 'logs']) {
    fs.mkdirSync(path.join(cfg.dataDir, sub), { recursive: true });
  }
  // 小本本：第一次启动就把架子搭好，别人的 bot 装完也有自己的一本
  const nb = notebookDir(cfg);
  for (const sub of ['', 'notes', 'memories', 'archive', 'tmp']) {
    fs.mkdirSync(path.join(nb, sub), { recursive: true });
  }
  const readme = path.join(nb, 'README.md');
  if (!fs.existsSync(readme)) fs.writeFileSync(readme, NOTEBOOK_README, 'utf8');

  // 人设：仓库里已经带了 core.md / group.md（正式文件），self.md 是空的。
  // 这里只是兜底：万一有人把某个文件删了，有 .example.md 就补一份回来。
  const created = [];
  const pdir = personaDir(cfg);
  fs.mkdirSync(pdir, { recursive: true });
  for (const name of ['core', 'group', 'self']) {
    const real = path.join(pdir, `${name}.md`);
    const tpl = path.join(pdir, `${name}.example.md`);
    if (fs.existsSync(real) || !fs.existsSync(tpl)) continue;
    try {
      fs.copyFileSync(tpl, real);
      created.push(`${name}.md`);
    } catch { /* 复制不了就算了，别拦着启动 */ }
  }
  return { persona: created };
}

/** persona 目录下那几份（core / group / self） */
export function personaDir(cfg = {}) {
  const rel = cfg?.persona?.dir || 'persona';
  return path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
}
export function personaFile(cfg = {}, name = 'self') {
  const file = name.endsWith('.md') ? name : `${name}.md`;
  return path.join(personaDir(cfg), file);
}

/** 兴趣账本落在哪儿 */
export function interestFile(cfg = {}) {
  const rel = cfg?.interests?.file || 'data/interests.json';
  return path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
}

/** 小本本落在哪儿（默认项目里的 notebook/，可用 config.notebook.dir 改） */
/** 整理员（记忆整理/体检）的工作目录：一个空目录。
 *  headless 是"cwd 决定加载哪份 AGENTS.md"，让它待在空目录里才不会读到人设入戏。 */
export function workerDir() {
  return path.join(ROOT, 'data', 'worker');
}

export function notebookDir(cfg = {}) {
  const rel = cfg?.notebook?.dir || 'notebook';
  return path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
}

const NOTEBOOK_README = `# 小本本

这只 bot 自己的记忆库。不是聊天记录，是它想记住的东西。

\`\`\`bash
node scripts/notebook.mjs write "今天想通了一件事：……"
node scripts/notebook.mjs read --days=3
node scripts/notebook.mjs find 记忆
node scripts/notebook.mjs stat
\`\`\`

| 目录 | 放什么 |
| --- | --- |
| \`notes/\` | 按天记（\`notes/YYYY-MM-DD.md\`） |
| \`memories/\` | 沉淀下来的事实：约定、偏好、结论 |
| \`archive/\` | 不常看的，别删，挪这儿 |
| \`tmp/\` | 临时，随时清 |

整个目录有大小上限（默认 20GB），超了就不让写。内容不进 git，只留空架子。
`;
