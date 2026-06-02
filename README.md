# 字幕检索台

本地字幕搜索工具。输入片名、剧集名、文件名或任意字段后，工具会查询多个免费字幕源。

## 字幕源

- 迅雷字幕
- SubtitleCat
- YIFY Subtitles
- Subf2m
- MovieSubtitles
- TVSubtitles

## 启动

```powershell
cd "E:\subtitle-finder"
node server.mjs
```

打开：

```text
http://127.0.0.1:8765
```

## Windows 桌面版

开发运行：

```powershell
cd "E:\subtitle-finder"
npm run app
```

打包便携版 exe：

```powershell
cd "E:\subtitle-finder"
npm run build:win
```

产物会生成到：

```text
E:\subtitle-finder\dist
```

## GitHub 发布

推送 tag 后会自动打包 Windows 便携版，并发布到 GitHub Releases：

```powershell
git tag v1.0.0
git push origin v1.0.0
```

下载页：

```text
https://github.com/<user>/<repo>/releases/latest
```

## 功能

- 按片名、剧集名或文件名搜索字幕
- 切换字幕源
- 切换目标语言
- 点击结果预览 SRT 内容
- 下载字幕文件
- 记录最近搜索
