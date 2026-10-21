# 哪些是这个项目的东西，哪些是使用者自己的

打包给别人用、或者换一台电脑重装时，照这张表分清就行。
一句话原则：**代码和人设模板进仓库，跑出来的东西（`data/`、小本本正文、日志）不进仓库。**

人设（`persona/`）现在跟着仓库走——`core.md` 和 `group.md` 带的是一份能直接用的默认人设，
`self.md` 是空的。你把它改成自己的之后，那几个文件就变成了"你跟她之间的话"，
再往外发之前自己看一眼。

---

## 一、项目本身的（进仓库，跟人不走）

| 位置 | 是什么 | 换个人也照样用 |
| --- | --- | --- |
| `src/` | 桥的全部逻辑（收消息、路由、记忆、闸、脑子、表情库、自由活动） | ✅ |
| `scripts/` | 命令行小工具（记忆、小本本、表情库、兴趣、自检、探针） | ✅ |
| `plugin/` | DSH 的设置页插件（`index.js` 转发 + `client.js` 界面 + `supervisor.js` 看住桥） | ✅ |
| `docs/` | 设计文档、这份说明、路线图 | ✅ |
| `README.md`、`AGENTS.md` | 说明与「住在这个目录里的工作规矩」 | ✅ |
| `package.json` | 依赖清单（`type: module`，无第三方运行时依赖） | ✅ |
| `config.example.json` | 配置模板：所有键和默认值都在这儿 | ✅ |
| `persona/core.md` `group.md` | 默认人设（能直接用，用户会改成自己的） | ✅ |
| `persona/self.md` | 空的——留给她自己写，不替她填 | ✅ |
| `notebook/*/.gitkeep` | 小本本的空目录结构 | ✅ |
| `procedures/` | 踩坑卡片（按项目积累，不是私人内容） | ✅ |

## 二、使用者自己的（**不进仓库**，`.gitignore` 已挡）

| 位置 | 是什么 | 为什么不该进仓库 |
| --- | --- | --- |
| `config.local.json` | 你填的真实配置：主人 QQ 号、工作区路径、各类开关 | 里面有你的 QQ 号、本机路径 |
| `persona/core.md` `group.md` 里你改过的部分 | 改过之后就是你跟她之间的话了（仓库里带的是默认版） | 改完就别往外发 |
| `data/` | 全部运行数据：事件流、记忆、会话绑定、表情库、收到的图、日志、待确认、人设备份 | 是她的经历 |
| `notebook/notes` `memories` `archive` `tmp` | 她的小本本正文 | 同上，私房话 |
| `backups/` | 改之前留的旧文件 | 临时留档 |
| `tmp/` | 临时脚本、试跑产物 | 临时 |
| `SD-Picture/` `stickers/` | 她画的图、表情原图 | 大文件，且是产物 |

另外这两个是**别的插件写进工作区的**，不是本项目的东西，也已忽略：
`sd-direct.ps1`、`sd-inject.ps1`、`sd-auto-mask.py`（SD 画图插件自己生成的脚本）。

---

## 三、配置里的键，哪些必须你改、哪些别动

`config.local.json` 只需要写「跟你有关」的那几项，其余留空走 `config.example.json` 的默认值。

### 必须由使用者填（因人而异）

| 键 | 含义 | 不填会怎样 |
| --- | --- | --- |
| `owner.userIds` | 主人 QQ 号（字符串数组） | 私聊一句都不回（默认只认主人） |
| `owner.rootIds` | 特权号：只有它能批准动手、它自己说的指令直接放行 | 留空会退回用 `userIds` |
| `onebot.credentialsFrom` | 从哪读 OneBot 令牌（指向 QQ Agent / SnowLuma 的 `config.json`） | 连不上 QQ |
| `brain.kind` | `none`（只收不说话）/ `headless`（起一次 DSH 干活） | 默认 `none`，她不会说话 |
| `brain.headless.workspace` | 她干活的目录（也是人设 `AGENTS.md` 从哪加载） | 默认项目根 |
| `group.enabled` | 群里要不要说话 | 默认开 |
| `group.keywords` / `group.names` | 群里叫她的词、她的名字 | 只认 @ 和概率 |
| `group.speakOnAt` / `speakOnName` | 被 @、被叫名字算不算在叫她 | 默认都算 |
| `group.social` | 群里接话的分寸（主动概率、活跃时长、沉默概率、冷场试探） | 用默认值，偏活跃 |
| `ack` | 干活前垫的那句话（开关 / 等多久 / 私聊说什么 / 群里说什么） | 默认 20 秒后垫一句 |
| `sticker.style` | 她发多少表情：`off` / `less` / `normal` / `always` | 默认 `normal` |
| `freeTime.*` | 自由活动：时长、每拍间隔、最多几句、权限、自己找时间的间隔 | 默认关着 |
| `memory.rooms` | 每个房间的记忆能不能互相看（`read` / `share`） | 私聊互看，群只看不外传 |
| `send.split` | 分条规则（一句一行、每条最多几个字、打字间隔） | 用默认值 |
| `web.allowFullAccess` | 面板「试一试」允不允许给全套权限（能真动电脑） | 默认否 |
| `snowluma.dir` | SnowLuma 在哪（不填就按常见位置找） | 找不到就拉不起来 |
| `safety.auditReply` | 发出去前扫一遍密钥/本机路径 | 默认开 |

### 一般不用动（系统内部）

`dataDir`（数据放哪）、`debounceMs`（攒消息窗口）、`upkeepMs`（记忆体检间隔）、
`images.retainDays` / `images.maxMb`（收图保留多久、占多大）、
`stickers.maxCount` / `stickers.maxMb`（表情库上限）、`notebook.dir` / `notebook.limitMb`、
`send.maxLen` / `send.gapMs`（超长切分、基础间隔）、`brain.headless.timeoutMs` 与 `profile`、
`web.port`（默认 3220，面板靠它找桥）。

---

## 四、换台电脑要做的三件事

1. 拷这几样：整个项目（不含 `data/`、`tmp/`、`backups/`）+ 你的 `config.local.json` +
   `data/`（她的记忆和经历）+ `notebook/`（她的小本本）+ 你改过的 `persona/`。
2. 复制 `config.example.json` 为 `config.local.json`，填 `owner.userIds` 和 OneBot 令牌来源。
3. 用 `plugin_manager` 把 `plugin/` 装进 DSH，或者在 DSH 里把桥手动起起来（`node src/main.mjs`）。
