# 听屿插件

MusicFree 格式的插件仓库。

## 第三方插件

- `third-party/xinghai-music-source-wy-v1.6.js` — 星海音乐源 wy，作者：万去了了
- `third-party/bilibili.js` — bilibili，作者：猫头猫（MusicFree 官方插件集）

这两份版权归原作者，保留原文件头部信息，不做修改；升级时整份替换。

## 说明

- 仓库里的插件不内置任何音乐内容，数据来自插件运行时请求的第三方接口。
- 插件在 App 的 JS 沙箱里运行，只依赖宿主注入的 `axios`，不使用 Node 专有模块。

## 文档

- [docs/plugin-development.md](docs/plugin-development.md) — 插件开发指南：哪些接口必须实现、哪些可选，每个接口的入参与返回结构，沙箱里能用什么
- [docs/plugin-login-spec.md](docs/plugin-login-spec.md) — 登录与续期规范
