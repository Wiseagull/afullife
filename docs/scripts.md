# 命令行小工具

`scripts/` 里全是 `node scripts/xxx.mjs` 直接跑的小工具，没有安装步骤，也没有第三方依赖。
共 19 个，按"什么时候会用到"分三类。要看某一个的具体参数，就跑 `node scripts/xxx.mjs --help`
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

## 三、自检与开发（改代码之后跑）

这些是"改完自己先验一遍"用的，装好之后跑一次能确认没坏。

| 命令 | 检查什么 |
| --- | --- |
| `node scripts/selftest.mjs` | 129 项：房间与路由、分条、记忆装配、看图白名单、交接纸条 |
| `node scripts/probe-gate.mjs` | 闸的用例表（什么放行、什么要先问） |
| `node scripts/probe-social.mjs` | 群聊社交状态机与"听着/开口"的判定 |
| `node scripts/probe-conflict.mjs` | "先问后改"：新说法和旧记忆打架时她会不会来问你 |
| `node scripts/probe-rules.mjs` | 规程按需挂：闲聊时精简、派活时全套 |
| `node scripts/check-secrets.mjs` | 发布前扫密钥、本机路径、个人标识。**推送前跑一下** |
| `node scripts/probe-gate-live.mjs` | 真机联调闸（要 `config.local.json` 里填好 `brain.headless.cli`） |
| `node scripts/probe-approve-live.mjs` | 真机联调"拦下来→问你→放行"这一圈 |

CI 里跑的是前六个（自检那五个 + `check-secrets`），在 Windows 与 Linux 上各一遍。
