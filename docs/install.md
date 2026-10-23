# 安装

照着做就行。装完想弄明白"它到底是什么"，看 [设计](design.md)；只想跑起来的话，
README 里的[快速开始](../README.md#快速开始)是压缩版。

## 它是什么形状的

它不是独立程序，是**挂在 DSH 身上的**。装好之后：

```
你双击 DSH
   └─ DSH 加载「AFL 通道」插件
        └─ 插件把桥拉起来（桥 = 这个项目的主体，node src/main.mjs）
             ├─ 连 QQ（走 OneBot，默认 ws://127.0.0.1:3001）
             ├─ 开一个本地接口给面板（127.0.0.1:3220）
             └─ 每来一句话，起一个 DSH 去「想」，想完回来发
```

所以装好之后是"打开 DSH 就在跑"。要装的只有**两处**：

| 装什么 | 装到哪儿 | 为什么 |
| --- | --- | --- |
| 仓库里的 `plugin/` | DSH 的 `desktop` profile | 设置页就是它，桥也由它拉起来 |
| 她干活用的工具（可选） | DSH 的 `headless` profile | 她的"脑子"跑在 headless 里 |

这两个 profile 是两套独立目录和 `node_modules`，装一个另一个看不见。

---

## 开始之前，你手上要有三样

1. **DSH 桌面版**（DeepSeek Harness）—— 能打开界面就行，本项目寄生在它上面。
2. **一个 QQ 号，和一份装好的 SnowLuma**。
   SnowLuma 就是替你去登录 QQ 的那个程序——本项目**不附带**它，也不碰 QQ 本身，
   只跟它开出来的 OneBot 接口说话（默认 WebSocket `3001`、HTTP `3000`）。

   没装的话先去装：[github.com/SnowLuma/SnowLuma](https://github.com/SnowLuma/SnowLuma)。
   装好打开 `http://localhost:5099`（初始密码在它的启动日志里），在 WebUI 里接入 QQ，
   再把 OneBot 的 WebSocket / HTTP 两个服务开着。**这一步不做，后面全都白搭。**
3. **Node 22 以上**（建议装）—— 桥用 DSH 自带的运行时就能跑，但
   `node scripts/find-snowluma.mjs` 这类脚本、以及她自己写小本本时敲的 `node ...` 命令要用它。

---

## 第 1 步：把项目放到一个固定的地方

```bash
git clone https://github.com/Wiseagull/afullife.git afullife    # 或者直接解压 zip
cd afullife
node -v                            # 建议 v20 以上
```

目录里应该有：`src/` `scripts/` `plugin/` `docs/` `persona/` `notebook/` `procedures/`
`config.example.json` `package.json` `README.md` `AGENTS.md`。

别放 `C:\Program Files` 这种要管理员权限的地方——她有时要往里写东西。

---

## 第 2 步：告诉它 SnowLuma 在哪

它要的是 **SnowLuma 的安装目录**（就是那个放着 `index.mjs`、里面还有 `config/` 的文件夹），
因为令牌和端口都写在 SnowLuma 自己的 `config/onebot_<你的号>.json` 里。
项目**不会**去猜你硬盘上的布局，只认两个地方：你告诉它的目录，或者项目自己的 `vendor/snowluma/`。

### 本机装了 SnowLuma 的话，一条命令搞定

```bash
node scripts/find-snowluma.mjs "D:/apps/SnowLuma"
```

（路径换成你的 SnowLuma 目录。）

看到这样就对了：

```
✓ 找到 SnowLuma 了
  目录：D:\apps\SnowLuma
  号码：你的QQ号
  配置：onebot_你的QQ号.json
  OneBot：ws://127.0.0.1:3001  /  http://127.0.0.1:3000
  令牌：ws 43 字符，http 43 字符

已写进 config.local.json：snowluma.dir = D:\apps\SnowLuma
```

它做的事：确认那目录里有没有 `index.mjs` 和 `config/onebot_*.json`，有就把位置和号码写进
`config.local.json`。读不出来它会自己说原因（没登录过 QQ / 目录不对 / 配置坏了）。

不想填路径也行——把 SnowLuma 整个目录放到 `afullife/vendor/snowluma/`，再跑一次这个命令。

### 如果 SnowLuma 不在本机，或者端口不是默认的

那就跳过自动读，直接在 `config.local.json` 里写清楚：

```json
{
  "onebot": {
    "wsUrl": "ws://127.0.0.1:3001",
    "httpUrl": "http://127.0.0.1:3000",
    "accessToken": "WS 的令牌",
    "httpToken": "HTTP 的令牌"
  }
}
```

两把令牌都填了，它就不再去找 SnowLuma 的配置文件，直接用你给的。
（令牌在 SnowLuma 的 WebUI 里能看到。）

---

## 第 3 步：写配置

```bash
cp config.example.json config.local.json
```

编辑 `config.local.json`，只需要三处：

```json
{
  "owner": { "userIds": ["你的QQ号"] },
  "brain": {
    "kind": "headless",
    "headless": { "workspace": "D:/apps/afullife" }
  }
}
```

- **`owner.userIds`** —— **谁是主人**（可以填好几个）。它管的是**权限**，不是"谁能跟她说话"：
  - 主人的号 → 可以让她改文件、跑命令、动电脑（动手前她先问一句，主人说行才做）
  - 别人的私聊 → **照样回**，但没有动手权限，只能聊
  - 一句话：想聊天不需要是主人，想让她干活才需要
- **`brain.kind`** —— 她怎么"想"：
  - `headless`：每来一段话，起一个 DSH 跑一轮（推荐）
  - `none`：只收消息不说话。**第一次装建议先用 `none`**，确认能收到 QQ 消息，再换回 `headless`
- **`brain.headless.workspace`** —— 她干活的工作目录，画图和临时文件都落这儿，一般就填项目目录
- **`send.dryRun`** —— `true` 是"只打印不真发"，**默认没有这一项**（等于 `false`，装上就真发）。
  第一次不想让她真的开口，就自己加一行 `"send": { "dryRun": true }`，等日志里能看见
  "准备发什么"了再删掉。之所以不写进模板：留着它忘了删的人，会以为她坏了。

其余几十个参数（群聊接话概率、垫话、表情档位、自由活动、记忆房间开关）不用手写，
首次运行自动生成，之后都能在面板里点。

**人设仓库里已经带好了**：`persona/core.md` 和 `persona/group.md` 是一份能直接用的默认人设，
打开把带 `<尖括号>` 的地方换成你自己的（名字、称呼、你的 QQ 号）就行，不用复制、不用改名。
`persona/self.md` 是**空的**——那是留给她自己写的地方，别替她填。

---

## 第 4 步：把「AFL 通道」装进 DSH（desktop 端）

这一页就是你在 DSH 里看到的设置界面，桥也由它拉起来。一条命令装好：

```bash
node scripts/install-panel.mjs
```

它会做三件事（都不用联网、不用 pnpm）：

- 在 DSH 的 `desktop` profile 的 `package.json` 里加一条依赖
  `"afullife-panel": "link:<你放项目的目录>/plugin"`
- 把 `afullife-panel` 写进 `dsh.profile.bundles`
- 在 `node_modules` 里建一个指向本仓库 `plugin/` 的目录链接（Windows 用 junction，不需要管理员）

看到这样就对了：

```
✓ 装好了

下一步：**把 DSH 完全关掉再打开**，然后到「设置」里找「AFL 通道」这一页。
```

装完必须**把 DSH 完全关掉再打开**——只刷新页面不行，宿主插件要重启才会加载。
重新打开后，设置里能看到「AFL 通道」就成功了。

几个变体：

```bash
node scripts/install-panel.mjs --dry-run      # 只说要做什么，不落盘
node scripts/install-panel.mjs --profile web  # DSH 装在别的 profile 上
node scripts/install-panel.mjs --uninstall    # 卸掉（项目文件不动）
```

> 如果你的 DSH 里能直接指挥一个 agent，也可以让它执行
> `plugin_manager install_bundle target=<项目>/plugin`，效果一样。

---

## 第 5 步（可选）：给她装工具（headless 端）

面板 →「工具」页 → 把想给的勾上。这一步是自动的：复制插件包进 headless 的
`node_modules`、写进它的 `dsh.profile.bundles`、跑一次 `--dump-config` 验证，失败就回滚。
取消勾选会卸掉（包挪进 `~/.dsh/trash`，后悔能捞回来）。

| 工具 | 给了她之后 |
| --- | --- |
| `dsh-computer-use-win` | 能看屏幕、点鼠标、敲键盘 |
| `browser-skill` | 能开你那个已登录的浏览器去读页面、点按钮 |
| `dsh-image-gen` / `sd-bridge-guard` | 能画图、发图 |
| `dsh-ops` | 多一套文件/命令工具 |
| `@jojoman2024/dsh-bili-scroll` | 能刷 B 站、看字幕 |

不装也能用：核心功能只依赖 DSH 自带工具。
注意：装完不用重启 DSH，但**新开的一轮会话**才拿得到新工具；`bsk_*`（浏览器那套）
只对装好之后**新建**的会话生效。

### 省钱：让她闲聊时用「轻装」的那套（可选，但很值）

装上的每个插件，它的工具说明都会**跟着每一轮、每一步重发一遍**。实测（同一句
「说说你自己是谁」）：

| 用哪套 profile | 每步上下文 |
| --- | --- |
| 全量（装了一堆工具） | **30,967** token |
| 只留 base + headless | **9,558** token |

差出来的两万多，一步就要算一次；一轮里她调几次工具，就是好几倍。所以我们建议做两套：

```bash
node scripts/make-chat-profile.mjs headless-chat
```

它会把当前的 headless profile 复制一份、`bundles` 只留 `dsh-base` + `dsh-headless`、
把 credentials 打开，然后告诉你在 `config.local.json` 里加一行：

```json
"brain": { "headless": { "chatProfile": "headless-chat" } }
```

重启桥。之后闲聊的轮次自动走轻装，**要动手的轮次（改文件、画图、查东西）仍然用全量**——
判断沿用桥里那套「像不像派活」，判错不要紧：轻装那套也有读写文件、搜网页、跑命令的基础工具，
只是少了那些重家伙。

### 给 `dsh-image-gen` 补一个 `webServer`（可选）

桌面版自带 `webServer` 服务（页面要用它），**headless 里没有**。`dsh-image-gen` 依赖它，
所以只勾上面那个框的话，它会一直停在 `pending (waiting for services: credentials, webServer)`，
`generate_image` 这个工具就永远长不出来。

两个办法任选：

- **只让她用 SD 画**：不勾 `dsh-image-gen`，勾 `sd-bridge-guard` 就行——本机 SD 那套不依赖 `webServer`。
- **想让她用 `generate_image`**：把仓库里的 `tools/dsh-webserver-lite` 装上，给 headless 补这层服务。

  ```bash
  # 1) 链进 headless profile（Windows 用 mklink /J，或管理员 PowerShell 的 New-Item -ItemType Junction）
  ln -s "<项目目录>/tools/dsh-webserver-lite" "$HOME/.dsh/profiles/headless/node_modules/dsh-webserver-lite"
  ```

  然后编辑 `~/.dsh/profiles/headless/cordis.patch.yml`，在**末尾**加两段。注意新增插件必须先写
  `insert:`——直接写 `- id: xxx` 会被当成"改已有条目"，报 `entry "xxx" not found`：

  ```yaml
  # 打开默认关掉的凭据服务（dsh-image-gen 也要它）
  - id: credentials
    disabled: false
  # 新增：极简 webServer
  - insert:
      - id: webserver-lite
        name: dsh-webserver-lite
  ```

  重启桥，再问她「你手上有 generate_image 吗」，回「有」就成了。

  这层服务只监听 `127.0.0.1` 的随机端口、只提供插件自己注册的路由，不对外。

---

### 一句安全说明

桥的本地接口（默认 `127.0.0.1:3220`）要带 `x-qad-token`（令牌在 `data/web-token`，插件和脚本自己读），
挡得住浏览器跨站和随手一敲；但这不是加密，本机程序读得到那个文件。

更漏的是 DSH 那侧的同源代理 `/qad/*`：它挂在 DSH 自己的端口上、会自己补上令牌，却不经过 DSH 的
登录校验——所以本机上任何程序照样能敲进来。所有监听都只在 `127.0.0.1`、不对外网开放，
个人自用够了；多用户机器上自己掂量。

## 第 6 步：启动

装好面板之后**什么都不用敲**：打开 DSH 就等于启动了它。

机制：`plugin/supervisor.js` 拿 DSH 自己的 Electron 二进制当 node 用
（`ELECTRON_RUN_AS_NODE=1`），在项目目录里跑 `src/main.mjs`，并把桥绑在 DSH 进程上——
DSH 一关，桥自己跟着退，不留孤儿进程。

### 想手动跑（调试，或者没装面板）

```bash
cd D:/apps/afullife
node src/main.mjs
```

没装 Node 就用 DSH 那个 exe 顶替：

```bash
ELECTRON_RUN_AS_NODE=1 "C:\Program Files\DeepSeek Harness\DeepSeek Harness.exe" src/main.mjs
```

PowerShell 里：`$env:ELECTRON_RUN_AS_NODE=1; & "C:\...\DeepSeek Harness.exe" src/main.mjs`

### 怎么算起成了

日志里出现这几行：

```
[config] 连 SnowLuma：ws://127.0.0.1:3001 / http://127.0.0.1:3000（配置取自 …）
[conn] 已连接
[ready] 登录为 你的bot昵称(你的QQ号)
```

日志在哪：走插件起的在 `<项目>/data/logs/dsh-supervisor.log`；手动跑的直接打在终端。

---

## 第 7 步：试一下

1. 用主人的 QQ 私聊她发一句「在吗」——正常 **3～8 秒**回你（每题都要新起一个 DSH，慢是正常的）
2. 去群里 @ 她一下
3. 回面板看「事件」页，能看到刚才那几条消息被怎么处理的

---

## 跑起来之后，目录里会多出这些

```
data/          事件流、记忆、会话、表情库、收到的图、日志   ← 要备份的就是它
notebook/      她自己的小本本（notes / memories / archive / tmp）
persona/       core.md、group.md（仓库自带默认人设，改成你自己的）；self.md 留空给她写
```

升级或搬家时，带走 `data/`、`persona/`、`notebook/` 和你的 `config.local.json` 就够了，
其余都是能重新下载的代码。这三样是她的记忆、性格和日记。

---

## 如果你是 AI，正在帮一个人装这个项目

按这个顺序做，每一步都有能验的判据：

1. `node -v` → 不到 20 就提醒对方装 Node，但**不阻塞**（桥本身不依赖它）
2. 先问清：**SnowLuma 装了没有、装在哪、里面登录 QQ 了没有**。
   没装就先把下载地址给对方（[github.com/SnowLuma/SnowLuma](https://github.com/SnowLuma/SnowLuma)），
   等他装好、在 WebUI 里登录 QQ、开好 OneBot 再往下——这步没完成，后面全是空转
3. `node scripts/find-snowluma.mjs "<SnowLuma 目录>"` → 期待输出里有 `✓ 找到 SnowLuma 了` 和
   `OneBot：ws://…`。报错就按它给的 `reason` 处理，别猜
4. `cp config.example.json config.local.json`，填 `owner.userIds`（对方的 QQ 号）
   和 `brain.headless.workspace`（项目目录）。想先不出声就自己加 `"send": { "dryRun": true }`
5. 装面板：`node scripts/install-panel.mjs`（它会自己找到 desktop profile），
   然后请对方**把 DSH 完全关掉再打开**——这一步只能由人来做，你替他点了没用
6. 先用前台跑一次 `node src/main.mjs`，确认出现 `[ready] 登录为 …`
7. 让对方在 QQ 里发一句，日志里出现 `[in] private:…` 之后，再确认 `send.dryRun` 是关着的（没加过就是关着）
8. 需要的话，再到面板「工具」页勾选她的工具

**别擅自动的东西**：`data/`、`persona/` 里的正式文件、以及对方没说要改的插件。

---

## 装不成，先看这几条

先跑一句 `node scripts/doctor.mjs`：Node、人格三份、桥和 SnowLuma 在不在、表情库账实、事件流、小本本，
一条条分「正常 / 提示 / 警告 / 错误」报给你，有「错误」时退出码是 1。它只读，不改配置也不重启任何东西。

| 症状 | 多半是 |
| --- | --- |
| 设置里根本没有「AFL 通道」这一页 | 第 4 步没做，或者装完没把 DSH 完全重启（只刷新页面不算） |
| 面板说「连不上桥」 | 桥没起来，点面板上的「重启桥」；还不行看 `data\logs\dsh-supervisor.log` |
| 日志说「没找到 SnowLuma」 | 回第 2 步：没告诉它 SnowLuma 在哪，或者 SnowLuma 里还没登录过 QQ |
| 一直不 `[ready]`，卡在「等太久了，端口还没通」 | SnowLuma 里没登录 QQ，或 3000/3001 端口没开、被占用 |
| 私聊她不回 | 自己在配置里加了 `send.dryRun: true` 忘了删；或者端口没通（看上面那条） |
| 她只肯聊天、不肯动手 | 说话的人不在 `owner.userIds` 里——设计如此，只有主人有动手权限 |
| 回了但发不出去 | 日志里找 `[send]` 报错；`retcode 100/120` 是被 QQ 风控了 |
| 第一条等很久 | 正常，3～8 秒；她在起一个 DSH 想事情 |
| `bsk_*` 工具找不到 | 只对装好之后新建的会话生效 |
| 群里发图不显示 | 日志里找 `图不在：…`，路径没对上 |

---

---

## 以后怎么更新

```bash
node scripts/update.mjs          # 拉最新 + 自检
node scripts/update.mjs --check  # 只看有没有新版
```

git 装的会自动 `git pull --ff-only`；解压 zip 装的它会打出"手动更新三步"。
不管哪种，它都不会碰 `data/`、`persona/`、`notebook/`、`config.local.json`。
更新完：动了 `plugin/` 就把 DSH 完全关掉重开，只改了桥就点面板「重启桥」。
