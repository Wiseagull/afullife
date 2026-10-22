# 待整理（每行一条：现象 + 一句话解法）

> 这是给"以后的我"看的便签。踩到坑的当时就记一行，别等收尾——回忆不可靠。
> 攒够几条、某条又复发过，就照 `_模板.md` 整理成正式卡片。

- 例子：`命令一条都跑不起来（exit 127）` → 先确认用的是 bash 还是 PowerShell，别混着写。
- `bsk_session start` 报 no browser is currently connected → 别换 URL 重试；得他先把带 browser-skill 扩展的浏览器打开、等插件显示 connected。没连上就换件事做，别自己开浏览器去凑。

- `read_image` 报 not found，而路径看起来像 `E:DSHworkCodeqagent-dshdataimages-xxx.jpg` → 反斜杠被吃了，不是文件不存在；用 glob/Get-ChildItem 在 `data/images` 里按文件名片段核对（注意缓存图片名常带前导负号，如 `-111990667-0.jpg`），再用真实全路径打开。

- `web_fetch` 报 hostname resolves to a non-public IP address（github.com / arxiv.org / developer.aliyun.com 全中） → 本机 DNS 把外网域名解析到内网，正文抓不到；只有 web_search 的摘要可用，别换 URL 反复试（连 bsk 也没连上，等于没有浏览器）。
