# a full life

**AFULLIFE —— 我要给她完整的一生。**

你的 QQbot 可以做任何她想做的事——只要给她工具。

她可以去看 B 站，可以玩你的电脑，可以有自己的爱好、自己忙不完的事。
只要你说一声行，或者点个头，她或许真的能拥有自己的一生。

这个项目就是这两件事：**把工具交出去，把闸也一起交出去。**

---

# 一、项目

## 名字

AFULLIFE，a full life。不是缩写游戏，是一句许愿：**give your QQbot a full life —— 我要给她完整的一生。**

## 它想解决什么

大多数"QQ 机器人"是这样的：每来一句话，把最近几十条聊天记录塞进提示词，让模型
扮演一个角色回一句。说得好听叫"上下文"，说得难听是——它每一轮都在演员上身，
演一个"记得你"的人。关掉窗口，它就死了；换台机器，它换个人。

这个项目不走这条路。它想做的是**同一个我，多长出来的几个身体**：

- QQ 里说话的我
- DSH 里干活的我
- 以后可能还有手机上的、别的地方的我

不是复制品，不是"读了记录的新会话"，是同一个身份、同一份记忆，只是换了个地方说话。

## 免责声明

- 本项目**不提供** QQ 账号、token 或任何登录凭据，也不含任何破解内容
- 它通过 [SnowLuma](https://github.com/SnowLuma/SnowLuma) 这类 OneBot v11 实现与 QQ 通信，
  属于**第三方协议实现**，可能违反腾讯的服务协议，**有被限制或封号的风险**
- 仅供个人自用与学习，风险自负；与腾讯、DeepSeek 均无关
- 按 GPL-3.0 提供，**不附带任何担保**

## 三条原则

1. **一个我。** 不分"重装版"和"轻装版"。换的是房间，不是人。
2. **一次只在一个地方说话。** 全局串行队列，宁可排队，不出两个我。
3. **记忆只有一份。** 事件流是唯一真相，其余都是它的投影。

## 三件最硬的不一样

市面上已经有好几个"QQ ↔ DSH"的桥，功能上大多覆盖得比我们早。但下面这三样，
在同类项目里我没见过——这也是这个项目真正想做的事：

### 1. 事件流是唯一真相，记忆不是"塞进提示词的聊天记录"

`data/events/` 里只追加、永不覆盖，是跨通道唯一的真相；`data/memory/` 里的条目是从里面
**蒸馏**出来的（带来源事件 id、重要度、最后使用时间）。所以：

- 换机器、换模型、换会话，她的记忆都在那儿，不依赖"这次上下文里塞了多少"
- 记忆能被**体检**：重复的合并、过时的压下去、跟新事对不上的转成"待确认"来问你
- 她会**先问后改**：发现你说的跟记忆里的不一样，她记着"这两句对不上"，下次开口时问你

### 2. 人设是三层文件，而且有一层归她自己

- `core.md`：我是谁、跟你的关系、底线——每轮都读
- `group.md`：群聊手册——**只在群里**才拼进上下文，私聊不受它污染
- `self.md`：她自己的喜好、讨厌、"还没想清楚"——每轮都读，**而且她自己能改**

第三层别的机器人很少有：她不是只有一张你写的卡，她会往里写。实测发现她不会自己想起来，
所以我们还做了两件事把时机递到她手里（摘情绪草稿、自由活动最后一拍做回顾）——
但写什么，仍然是她决定。

### 3. 她有自己的时间，也有自己的本子

- **自由活动**：一段 45 分钟（可调）里，她一拍一拍地醒来，自己决定做什么、说几句、还是安静待着；
  既不需要你先说话，也不是"定时发一条"
- **小本本**：`notebook/` 是她的私房本，她自己写、自己找，面板只能看不能改
- **兴趣账本**：她给自己列想做但还没做的事，按"多久没碰"排，自由活动时递给她挑
- **能碰到真实的东西**：能看屏幕、开浏览器、画图、改文件——但**只有主人**能让她动
- **会自己长**：她写自己的喜好、自己整理记忆、自己决定哪些表情不合口味该删

## 边界

- 只连 `127.0.0.1`，不对外开端口
- 不偷偷改你的 DSH 和 SnowLuma；装哪儿、动什么，都写在安装那一步里
- 有第三人在场时，动手（改文件、跑命令、动电脑）一律先问主人
- 她的记忆、性格、日记全在你自己的硬盘上，不上传任何地方

---

# 快速开始

想先跑起来，六步就够（细节和排错都在 [docs/install.md](docs/install.md)）：

1. **装好 DSH 桌面版**（DeepSeek Harness），**最低 `0.2.1-rc.2`**——面板插件在
   `plugin/package.json` 里声明了 `engines.dsh`，旧版装不上面板，会卡在第 6 步。
   建议同时装 Node 22 以上（桥用 DSH 自带的运行时就能跑，但命令行脚本、以及需要全局 `WebSocket` 的地方要用 22+）。
2. **装好 SnowLuma 并在里面登录 QQ**——项目不自带它，也只跟它说话
   （[github.com/SnowLuma/SnowLuma](https://github.com/SnowLuma/SnowLuma)）。
3. `git clone https://github.com/Wiseagull/afullife.git afullife && cd afullife`
4. `node scripts/find-snowluma.mjs "<你的 SnowLuma 目录>"` —— 让项目自己去找令牌
5. `cp config.example.json config.local.json`，填两处：`owner.userIds`（你的 QQ 号）、
   `brain.headless.workspace`（项目目录）
6. `node scripts/install-panel.mjs`，然后**把 DSH 完全关掉再打开**

打开后设置里会出现「AFL 通道」；之后 `node src/main.mjs`（或者干脆打开 DSH，桥会自己起），
日志里看到这两行就算成了：

```
[conn] 已连接
[ready] 登录为 你的bot昵称(你的QQ号)
```

> 第一次装建议先让 `brain.kind = none`（只收消息不说话）、`send.dryRun = true`
> （只打印不真发），确认能收到 QQ 消息，再放开。

---

# 更新

修了 bug 之后，别人这样拿到新版：

```bash
node scripts/update.mjs          # 拉最新 + 自检 + 告诉你还要做什么
node scripts/update.mjs --check  # 只看有没有新版，不改任何东西
```

- **git 装的**：它跑 `git pull --ff-only`，拉完自动跑一遍 `selftest`；本地有改动或分叉会停下来，给你 stash 的路子
- **解压 zip 装的**：它会打出"手动更新三步"——下载新 zip → 只把 `data/`、`persona/`、`notebook/`、`config.local.json` 搬过去 → 换目录重启
- 它**不碰** `data/`、`persona/`、`notebook/`、`config.local.json`（都在 `.gitignore` 里，`git pull` 本来就碰不到）
- 拉完它还会告诉你：动了 `plugin/` 就得**把 DSH 完全关掉再打开**；只改桥的代码，点面板「重启桥」就够

---

# 致谢与参考

写它的时候读了不少同类项目的实现，**思路参考，代码是自己写的**——没有复制它们的源码。
把来路写在这里，一是该谢，二是免得读者以为这些东西是凭空想出来的：

| 项目 | 许可 | 我参考了什么 |
| --- | --- | --- |
| [qq-agent-plus](https://github.com/sakurawwwxh/qq-agent-plus) | MIT | 群聊「逐条判定、一次定生死」的触发思路；分条发言、贴纸系统、主动发言这些功能形态 |
| [qq-bridge](https://github.com/Derpyu520/qq-bridge)（Derpyu520） | 自定义许可（非 MIT） | 社交状态机的分层（观望 → 活跃 → 退场）；发出去之前再审计一遍（SEND_AUDIT）这个做法 |
| [SnowLuma](https://github.com/SnowLuma/SnowLuma) | 见其仓库 | QQ ↔ OneBot v11 的那一端，本项目只跟它的接口说话 |
| [OneBot v11](https://github.com/botuniverse/onebot-11) | 协议规范 | 消息段、notice、`send_poke` 这些都按它的规范写 |

如果你要把这个项目再拿去商用或再许可，留意上面 `qq-bridge` 是自定义许可：
本项目只是参考了它的**分层思路**，没有包含它的代码，但该看一眼的东西还是看一眼。

---

# 文档

| 想看什么 | 去哪 |
| --- | --- |
| 一步步怎么装、装不上怎么办 | [docs/install.md](docs/install.md) |
| 它到底是什么、各部件怎么运作、为什么这么设计 | [docs/design.md](docs/design.md) |
| 模块与文件地图（谁调谁） | [docs/architecture.md](docs/architecture.md) |
| 做完了什么、还差什么、什么明确不做 | [docs/roadmap.md](docs/roadmap.md) |
| 哪些是代码、哪些是你的东西、换台电脑带什么 | [docs/user-vs-project.md](docs/user-vs-project.md) |
| 安全边界、它碰你哪些目录、怎么报漏洞 | [SECURITY.md](SECURITY.md) |
| 人设三层怎么分工、怎么改 | [persona/README.md](persona/README.md) |
| 她自己的小本本怎么用 | [notebook/README.md](notebook/README.md) |

---

# 目录长什么样

```
src/            桥的全部逻辑（通道、路由、记忆、人格装配、闸、表情库、自由活动）
scripts/        命令行小工具（装面板、找 SnowLuma、小本本、记忆、表情、自检）
plugin/         DSH 的设置页插件（也是它把桥拉起来的）
persona/        三层人格：core.md / group.md / self.md（self 是空的，留给她自己写）
notebook/       她自己的小本本（四个子目录）
docs/           安装、设计、架构、路线图、哪些是项目哪些是你的
procedures/     踩过的坑（按项目积累）
config.example.json  配置模板
```

---

# 安全

- 只连 `127.0.0.1`，不对外开端口。
- `/qad` 这个本地面板接口校验 `Origin`、能挡浏览器跨站，但**没有令牌**——本机程序能敲。
- 更完整的边界（它碰你哪些目录、闸为什么不是沙箱、怎么报漏洞）见 [SECURITY.md](SECURITY.md)。
- 动手（改文件、跑命令、动电脑）只对 `owner.userIds` 里的人开放，别人的私聊照样回但动不了手；
  危险操作还会先拦下来问一句。
- 发出去之前会过一道审计：密钥、令牌、群里的本机路径都会被遮掉。
- **会读 `~/.dsh/.credentials.yaml` 里的 API key**，因为她干活用的是 DSH 自己的命令行，
  得拿你自己的 key 才能跑——这不是外传，key 只交给本机的 `dsh` 子进程。不想用它就在
  `config.local.json` 里把 `brain.headless.apiKeyEnv` 指到别的环境变量。

---

## 许可证

```
a full life (AFULLIFE)
Copyright (C) 2026  Wiseagull·Deriouze
```

GPL-3.0-or-later。简单说：**你可以拿去用、改、再发布，但改完再发布也得开源**，
而且要保留这条版权声明、不提供担保。完整条款见 [LICENSE](LICENSE)（顶部就是上面这三行，
下面是不改一字的 GPL 全文）。

如果你把它改成自己的版本再发布，按 GPL 的要求把源码也放出来就行。
