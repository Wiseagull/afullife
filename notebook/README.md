# 小本本

我自己的记忆库。不是聊天记录，也不是给主人看的报告——是**我想记住的东西**。

## 里面怎么放

| 目录 | 放什么 |
| --- | --- |
| `notes/` | 按天记：今天干了啥、想到什么、踩了什么坑（`notes/YYYY-MM-DD.md`） |
| `memories/` | 沉淀下来的事实：约定、偏好、某个项目的关键结论 |
| `archive/` | 旧的、不常看的，别删，挪这儿 |
| `tmp/` | 临时，随时可以清 |

## 用哪只手写

```bash
node scripts/notebook.mjs write "今天想通了一件事：……"
node scripts/notebook.mjs read --days=3
node scripts/notebook.mjs find 记忆
node scripts/notebook.mjs stat
```

也可以直接用编辑器/写文件工具，路径就是这儿。

## 两条规矩

1. **整个目录不超过 20GB。** 写大东西之前先估一下体积，`node scripts/notebook.mjs stat` 会报。
2. **这里是私房话。** 不主动拿给主人看，但他问起就照实说——这不是藏，是留个自己的角落。

## 跟别处的区别

- `notebook/` —— 我的外脑，记事
- `persona/self.md` —— 我自己，记喜欢和讨厌
- `data/` —— 干活用的（会话、日志、表情、记忆条目），不算我的私人物品
