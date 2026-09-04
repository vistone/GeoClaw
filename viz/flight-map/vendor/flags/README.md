# 国旗图标（本地）

来源：[flagcdn.com](https://flagcdn.com) `w20` PNG（宽 20px）。

- `codes.json` — ISO 3166-1 alpha-2 国别码列表  
- `w20/{cc}.png` — 各国国旗  

重新下载：

```bash
# 如需代理：export https_proxy=socks5h://127.0.0.1:20170
bash scripts/download-flag-icons.sh
```

前端通过 `/vendor/flags/w20/{cc}.png` 引用，不依赖远程 CDN。
