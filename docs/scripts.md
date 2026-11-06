# 命令行小工具

`scripts/` 里全是 `node scripts/xxx.mjs` 直接跑的小工具，没有安装步骤，也没有第三方依赖。
共 33 个，按"什么时候会用到"分三类。要看某一个的具体参数，就跑 `node scripts/xxx.mjs --help`
或者不带参数跑一次——它们都会先印用法。

---

## 一、装和更新（装的时候用，之后基本不动）

| 命令 | 干什么 |
| --- | --- |
| `node scripts/find-snowluma.mjs "<SnowLuma 目录>"` | 让项目记住 SnowLuma 在哪，顺手读出它的 OneBot 令牌写进 `config.local.json`。装的第一步 |
| `node scripts/install-panel.mjs` | 把面板插件装进 DSH 的 desktop profile。装完要**把 DSH 完全关掉再打开** |
| `node scripts/install-panel.mjs --uninstall` | 反过来卸掉（会先把 profile 的 `package.json` 备份一份） |
| `node scripts/install-panel.mjs --dry-run` | 只说要做什么，一个字节都不落盘 |
| `node scripts/update.mjs` | git 仓库：拉最新 → 报告动了哪些文件 → 跑自检 → 说清"重启 DSH"还是"重启桥"。不是 git 仓库就打印手动更新三步 |
| `node scripts/update.mjs --check` | 只看有没有新版，不改任何东西 |
| `node scripts/make-chat-profile.mjs` | 造一个"闲聊轻装"的 DSH profile（把工具说明砍到最小），省钱用。已经存在就什么都不做 |

## 二、日常维护（她会自己用，你也可以手动敲）

| 命令 | 干什么 |
| --- | --- |
| `node scripts/mem.mjs open <事件号>` | 取那一条的**原文**。记忆条目后面写着"（据 ev_xxxxxxxx）"，就是拿这个号来翻 |
| `node scripts/mem.mjs search <词> [--days=7]` | 在事件流里搜原文，只列原文，不转述 |
| `node scripts/mem.mjs now` | 今天每个房间最后一条 |
| `node scripts/notes.mjs list [--kind=约定]` | 看她记下的条目（`--all` 连过时的一起看） |
| `node scripts/notes.mjs add <类型> <文本>` | 手动塞一条。"约定/偏好"这两类她只能标过时、不能自己改 |
| `node scripts/notes.mjs stale <id> [原因]` | 把一条标成过时（不删，留痕） |
| `node scripts/self.mjs show` | 看她自己写的那份（`persona/self.md`） |
| `node scripts/self.mjs add <节> <一句话>` / `log <一句话>` | 往她自己那份里加东西；`log` 会自动带日期 |
| `node scripts/notebook.mjs write <页> <文本>` | 写小本本 |
| `node scripts/notebook.mjs read [--days=3]` / `find <词>` | 翻小本本 |
| `node scripts/sticker-lib.mjs stats` | 表情库有多少张、多大 |
| `node scripts/sticker-lib.mjs prune [--dry]` | 按"用得少 → 收得早"删一批（默认上限 300 张 / 200MB） |
| `node scripts/sticker-lib.mjs where` | 看现在是谁在写表情库（正常情况下应该答"桥"） |
| `node scripts/stickers.mjs` | 扫一遍 QQ 本地表情缓存建索引。要 `QAD_QQ_UIN=你的QQ号`，或者先在 `config.local.json` 里填好 `owner.userIds` |
| `node scripts/interests.mjs list` / `pick` | 看她的兴趣账本、及其今天轮到哪几件 |
| `node scripts/usage.mjs` | 今天花了多少 token、按房间分开 |
| `node scripts/whats-new.mjs` | 在 DSH 那边看 QQ 侧最近发生了什么 |
| `node scripts/new-session.mjs [房间]` | 换掉某个房间的会话（不给房间就全换）。换之前会自动写一张交接纸条 |
| `node scripts/voice.mjs pick [--scope=private]` / `show` | 挑几句"她平时怎么说话"当样例，写进 `data/voice-samples.json`。挑的是短、像人话、没工具痕迹的旧句——摆回她眼前，就是把腔调钉住 |
| `node scripts/persona-check.mjs [--days=3]` | 人设漂没漂，拿数说话：平均长度、结构化程度、自称率，三个数都从她自己说过的话里算。越线退出码 1 |
| `node scripts/qzone.mjs list` / `post "一句话"` | 看她自己空间最近说了什么、发一条纯文字说说。默认关着，`config.local.json` 里 `qzone.enabled` 改成 true 才能发 |
| `node scripts/web.mjs <url> [--max=20000] [--from=词] [--grep=词]` | 抓网页/接口，吐成能读的文字。`web_fetch` 在本机一律报"非公网 IP"（Clash 的 fake-ip 落在保留段），这条走 Node 的 fetch，不受影响 |
| `node scripts/send-image.mjs <图片路径> [--to=号] [--group=群号]` | 绕过桥直连 OneBot 发一张图，救急用（桥还是旧进程、自由活动那条路发不出图时就靠它）。不过审计、不记表情库 |
| `node scripts/art-index.mjs [输出路径]` | 给 `data/art` 里那些图生成一份 `索引.md`（按目录列文件名、尺寸、大小）。只读文件，不改图 |
| `node scripts/image-dedupe.mjs [--apply]` | 收图去重：按内容哈希分组，一组只留最早那张，其余挪进 `data/images/archive-dupes`（只挪不删）。默认只报告，`--apply` 才动手。幂等，可反复跑 |
| `node scripts/keep.mjs list\|add\|rm <目录> [文件名...]` | 登记「清理时别动」的文件（目录里的 `keep.json`）。`add` 先确认文件真在目录里，名字拼错就不写；`list` 顺带报没登记、照常按账龄清的有几个。只登记，不删不改文件 |

## 三、自检与开发（改代码之后跑）

这些是"改完自己先验一遍"用的，装好之后跑一次能确认没坏。

| 命令 | 检查什么 |
| --- | --- |
| `node scripts/doctor.mjs` | 一次看完"装好了没、还活着没、数据有没有坏"：Node 版本、人格三份、桥与 SnowLuma 在不在、表情库账实、事件流大小、小本本用量，分正常/提示/警告/错误四档，有错误时退出码 1。`--json` 给机器读，`--no-net` 不连本机端口 |
| `node scripts/selftest.mjs` | 488 项：房间与路由、分条、记忆装配、看图白名单、发图标记、自由活动抠图、交接纸条、兴趣账本、收图去重、探针与看门人、媒体清理的 dry/keep/闸、门牌、切格切不开时报的数、历史段的 token 保险丝。全绿之后会自己再问一句"这份生效了没"——桥比 `src/` 旧就就地印一行「这份还没生效」，不算失败项、不改退出码 |
| `node scripts/probe-gate.mjs` | 闸的用例表（什么放行、什么要先问） |
| `node scripts/probe-social.mjs` | 群聊社交状态机与"听着/开口"的判定 |
| `node scripts/probe-conflict.mjs` | "先问后改"：新说法和旧记忆打架时她会不会来问你 |
| `node scripts/probe-panel-note.mjs [--limit=N]` | 切格工具的退回说明有**两份渲染**（`tools/panel-split.py` 的 `reason_note` 给她看、`src/stickers/screen.mjs` 的 `uncutNote` 给模型看）。同一句话今天假过两次，两次都是只改了一边。这条拿 reject 里的图，把两份输出逐数对账（段数=缝数+1、倍数/占比容精度差），谁改单边谁红。改动文案后跑它，跑不了 python 会明说"没验"，不算过 |
| `node scripts/probe-stale.mjs [--json] [--since="2026-11-01 20:14:50"] [--log=<路径>]` | 现在跑着的桥，是不是盘上最新那份代码：拿日志里最后一次"桥已启动"的时间，去比 `src/` 下每个 `.mjs/.js` 的修改时间，比它新的就是**改完还没生效**的，退出码 1。改完代码、桥还没重启的时候跑它——别拿"自检全绿"当"已经生效"。看的是修改时间不是内容（`touch` 过的也会算进去）；判不了时（日志里没启动记录、或那条 pid 已经不在）退出码 2，不返回 0。桥自己那头是另一半：`src/util/stale-watch.mjs` 每 5 分钟扫一次「启动之后改过谁」，改过就在日志里记一行「这份还没生效」（`QAD_STALE_WATCH_MS` 改间隔，0 关掉）——不用谁记得问 |
| `node scripts/check-secrets.mjs` | 发布前扫密钥、本机路径、个人标识。**推送前跑一下** |
| `node scripts/probe-gate-live.mjs` | 真机联调闸（要 `config.local.json` 里填好 `brain.headless.cli`） |
| `node scripts/probe-approve-live.mjs` | 真机联调"拦下来→问你→放行"这一圈 |
| `node scripts/prompt-ab.mjs` | 承重词实验：同一张工作流、同一个种子，只改正向提示词里的某几个词，看耳朵长成什么样。要本机 ComfyUI 和 dsh-qwen-paint，不是日常工具 |

CI 里跑的是 `selftest`、`probe-gate`、`probe-social`、`probe-conflict`、`check-secrets`
这五个（`doctor` 要连本机端口，用 `--no-net` 也能跑，但更适合装完/出事时手动敲），在 Windows 与 Linux 上各一遍。
