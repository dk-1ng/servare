# Servare

[English](../../README.md) · [Português (BR)](README.pt-BR.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Русский](README.ru.md) · **简体中文** · [日本語](README.ja.md)

> 本文为译文。如有出入，以[英文版](../../README.md)为准。

一款适用于 Firefox 和 Chromium 的浏览器扩展，可检测页面加载的视频和音频并将其保存到本地——支持直链文件、HLS 和 DASH，所有处理均在浏览器内完成。

> **状态：** 开发中（pre-alpha）。可在[项目看板](https://github.com/users/dk-1ng/projects/4)和 [milestones](https://github.com/dk-1ng/servare/milestones) 查看进度。

## 计划功能

- 通过监听页面的网络请求自动检测媒体
- 直链文件（MP4、WebM、MKV、MP3…）、HLS 和 DASH
- 选择清晰度、音轨和字幕
- 录制直播（HLS）
- 提取音频为 MP3
- 支持暂停与恢复的下载队列，浏览器重启后亦可继续
- 使用编译为 WebAssembly 的 FFmpeg 在本地重新封装——无需本地应用、无服务器、无遥测
- 镜像模式（Firefox）：复用播放器已下载的数据，不产生额外请求

## 不在范围内

- **YouTube**——出于设计决定，不提供支持。
- **受 DRM 保护的内容**（Widevine、PlayReady、FairPlay 等）——会被检测并拒绝。Servare 不包含、也不会接受任何绕过 DRM、登录、付费墙或其他技术保护措施的代码。

## 开发

环境要求：Node.js LTS、pnpm、FFmpeg（用于生成测试素材）。

```sh
pnpm install
pnpm dev            # Chromium，自动重载
pnpm dev:firefox    # Firefox
pnpm test           # 单元测试
pnpm build          # 为两种浏览器生成生产包
```

技术文档（英文）：[docs/design.md](../design.md)。贡献指南：[CONTRIBUTING.md](../../CONTRIBUTING.md)。

## 法律声明

Servare 是一款通用工具，用于保存浏览器已经接收到的媒体。**您需对自己的使用行为承担全部责任。** 请仅下载您有权下载的内容——您自己的内容、采用自由许可的内容、公有领域内容或已获权利人许可的内容——并遵守您所在国家的版权法律及各网站的服务条款。

本项目与任何网站、流媒体服务或其他扩展均无关联，也未获得其赞助或认可。第三方名称和商标归其各自所有者所有。

本软件按“原样”提供，不附带任何担保，依据 [MIT 许可证](../../LICENSE)发布。

## 许可证

[MIT](../../LICENSE)。第三方组件（如采用 LGPL-2.1 的 libav.js/FFmpeg 和 LAME）保留各自的许可证，详见 `THIRD_PARTY_NOTICES.md`。
