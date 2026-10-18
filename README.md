# 听屿插件

MusicFree 格式的插件仓库。

## 目录

```
tingyu/        自己写的插件
third-party/   第三方插件副本，做对照和回退用
```

## 第三方插件

- `third-party/xinghai-music-source-wy-v1.6.js` — 星海音乐源 wy，作者：万去了了
- `third-party/bilibili.js` — bilibili，作者：猫头猫（MusicFree 官方插件集）

这两份版权归原作者，保留原文件头部信息，不做修改；升级时整份替换。

## 说明

- `tingyu/` 里的插件不内置任何音乐内容，数据来自插件运行时请求的第三方接口。
- 插件在 App 的 JS 沙箱里运行，只依赖宿主注入的 `axios`，不使用 Node 专有模块。
