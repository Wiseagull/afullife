# 安全说明

这个项目会**跑命令、读文件、连 QQ**，所以把边界写清楚比藏起来好。

## 它对外暴露了什么

| 东西 | 监听在哪 | 谁能敲 |
| --- | --- | --- |
| 桥的面板接口（`/api/*`） | `127.0.0.1:3220` | 校验 `Origin`、`x-qad-ui: 1` 与 `x-qad-token`（令牌在 `data/web-token`），不带令牌 401。**这只是把「随手一敲」变成「先读那个文件」**，本机程序读得到 |
| 面板在 DSH 里的代理（`/qad/*`） | DSH 自己的端口（本机） | **本机任何程序都能敲**：这个路由是插件注册的，不经过 DSH 的登录校验，而且会自己补上令牌转发给桥 |
| OneBot | `127.0.0.1:3000` / `:3001` | 本机；令牌从 SnowLuma 的配置里读 |

**没有对公网开任何端口。** 所有监听都是 `127.0.0.1`。

## 它碰你电脑的哪些地方

- 能读写的地方（白名单）：项目目录、`data/`、`notebook/`、`brain.headless.workspace`，以及你在
  `safety.workspaceRoots` 里自己加的。白名单之外的动作会被闸拦下来问你。
- **会读 `~/.dsh/.credentials.yaml`**：因为她干活用的是 DSH 自己的命令行，得拿你的 API key 才能跑。
  key 只交给本机的 `dsh` 子进程，不外传。不想让它读就在 `config.local.json` 里把
  `brain.headless.apiKeyEnv` 指到别的环境变量。
- 会读 SnowLuma 的 `config/onebot_*.json`（端口和令牌），只读不写。

## 闸的定位：不是沙箱

`src/safety/rules.mjs` 是一层**模式匹配**的红线（递归删、往外发、装东西、改系统、碰密钥、
写工作区外、拼代码执行）。它能挡住大多数手滑和大多数"模型想当然"，但它**不是安全边界**：

- 写成 `bash -c "..."`、`iex`、`node -e`、`FromBase64String` 这类"运行时拼代码"的，一律按红处理
- 但**看不懂的写法一定存在**。真要跑不可信的东西，请自己上虚拟机或容器
- 只有 `owner.userIds` 里的号能让她动手；别人的私聊照样回，但没有动手权限

## 你该自己注意的

- **别把 `config.local.json`、`data/`、`persona/` 提交到公开仓库**——里面有你的 QQ 号、令牌、你和她说的话。
  `.gitignore` 已经挡了，但提交前自己看一眼 `git status`
- `persona/core.md` 里如果你写了真实姓名/住址/工作单位，它会被拼进每轮提示词，也会跟着仓库走
- 别人给你一个"改好的分支"让你 `git pull`，等于让他在你机器上跑命令——先看 diff

## 报告漏洞

**请别开公开 issue。** 走 GitHub 的私密通道：
[Security Advisories](https://github.com/Wiseagull/afullife/security/advisories/new)

顺手能提供的：DSH 版本、Node 版本、触发用的那句话或那条命令、`data/logs/` 里相关几行
（**先把令牌和 QQ 号涂掉**）。我会回，但不承诺时间——这是一个人在维护的东西。
