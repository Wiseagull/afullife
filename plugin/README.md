# afullife-panel

AFULLIFE 的 DSH 设置页插件——你在 DSH 里看到的那页（默认叫「AFL 通道」）就是它。

三件事：

- `client.js`：设置页界面（九个页签：自由活动 / 小本本 / 记忆 / 房间 / 工具 / 人设 / 待确认 / 事件 / 会话）
- `index.js`：宿主侧路由，把面板请求按同源转到 `127.0.0.1:3220`（桥的本地接口）
- `supervisor.js`：跟着 DSH 起落拉起桥（用 DSH 自己的 Electron 当 node），DSH 退出时把桥一起带走

装法见项目根的 `README.md`，或者直接跑：

```bash
node scripts/install-panel.mjs
```
