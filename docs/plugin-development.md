# 听屿插件开发指南

写给要写插件的实现者。读完这份文档，你应该能回答三个问题：哪些接口必须实现、哪些可选、每个接口的入参和返回值到底长什么样。

插件格式沿用 MusicFree 的约定：一个 CommonJS 模块，导出插件对象。听屿只覆盖其中一部分接口，本文档写的是**听屿宿主真实调用**的那部分，不是 MusicFree 的全集。

- 登录与续期单独一份：[plugin-login-spec.md](plugin-login-spec.md)
- 仓库里的参考实现：`tingyu/tingyu-netease.js`（功能最全）、`third-party/bilibili.js`（只做搜索和播放）

---

## 1. 最小可用插件

```js
const axios = require('axios');

async function search(keyword, page, type) {
  const res = await axios.get('https://api.example.com/search', {
    params: { q: keyword, page, type }
  });
  const list = res.data.list || [];
  return {
    isEnd: list.length === 0,
    data: list.map(item => ({
      id: String(item.id),
      title: item.name,
      artist: item.singer,
      album: item.album || '',
      artwork: item.cover,
      duration: item.duration,        // 秒
      type: 'music'
    }))
  };
}

async function getMediaSource(song, quality) {
  const res = await axios.get('https://api.example.com/play', {
    params: { id: song.id, quality }
  });
  return { url: res.data.url };
}

module.exports = {
  platform: '我的音源',
  version: '1.0.0',
  primaryKey: ['id'],
  supportedSearchType: ['music'],
  search,
  getMediaSource
};
```

这两个方法就能装进听屿、搜索、播放。其余能力按需加，不实现的能力在界面上不会出现。

---

## 2. 运行环境

### 2.1 模块形态

插件源码被包进 CommonJS 包装器求值：

```js
(function(module, exports, require) { /* 你的源码 */ })(module, exports, require);
```

所以两种导出都行：`module.exports = {...}` 或 `exports.x = ...`。`module.exports` 必须是对象，否则加载失败。

### 2.2 能 require 的模块

只有下面 8 个，其它名字一律抛 `Unsupported module: xxx`：

| require | 说明 |
|---|---|
| `axios` | 宿主注入的网络桥，见 2.4 |
| `dayjs` | 日期处理 |
| `he` | HTML 实体转义 |
| `crypto-js` | 加密、哈希、编码 |
| `cheerio` | HTML 解析 |
| `webdav` | WebDAV 客户端 |
| `qs` | 查询串序列化 |
| `big-integer` | 大整数 |

Node 内置模块（`fs`、`path`、`buffer`、`crypto` 原生版）都不可用。需要哈希用 `crypto-js`，需要 Base64 用 `btoa`/`atob`。

### 2.3 可用的全局对象

实测结果（宿主注入 + 引擎自带）：

| 存在 | 不存在 |
|---|---|
| `Promise`、`Symbol`、`JSON`、`Math`、`Date`、`RegExp` | `setTimeout`、`setInterval`、`clearTimeout`、`queueMicrotask` |
| `atob`、`btoa`、`URL`、`URLSearchParams` | `TextDecoder`、`TextEncoder`、`crypto`、`structuredClone` |
| `fetch`、`Headers`、`Response` | `Request`、`XMLHttpRequest`、`FormData`、`Blob` |
| `process`（垫片）、`env`、`console`（静默） | `window`、`document`、`localStorage`、`Buffer`、`global` |

**没有定时器**。任何 `new Promise(r => setTimeout(r, 1000))` 都会永久挂起，整次调用在 60 秒后被强制终止（见 2.6）。需要退避就靠请求本身的失败重试，不要自己 sleep。

`console.log` 等全是空函数，打日志看不到东西。调试靠返回值。

### 2.4 axios 桥的行为

支持这些调用形式：

```js
axios({ url, method, params, headers, data, responseType })
axios.get(url, config)
axios.post(url, data, config)
axios.request(config)   // 等同 axios(config)
```

**不支持** `.put` / `.delete` / `.patch` / `.head`、`axios.create()`、`interceptors`、`defaults`。需要 PUT/DELETE 时用 `axios({ method: 'PUT', ... })`。

`config` 认的字段：

| 字段 | 说明 |
|---|---|
| `url` | 必填 |
| `method` | 默认 `GET` |
| `params` | 查询参数对象；数组会以逗号拼接 |
| `headers` | 请求头，值必须是字符串 |
| `data` | 请求体；字符串原样发，对象按 JSON 序列化（GET 时忽略） |
| `responseType` | 只有 `'arraybuffer'` 有特殊处理，`res.data` 变成字节数组 |

成功时 `res` 长这样：

```js
{ data, status, headers, config }
```

- `data`：响应体。JSON 能解析就解析成对象，否则是字符串。
- `headers`：全部小写键名不保证，按服务端给的来。

非 2xx 时 Promise 直接 reject，错误对象上带 `error.response`，结构和成功时一样：

```js
try {
  const res = await axios.get(url);
} catch (e) {
  // e.response.status 非 2xx
  // e.message 是 "HTTP 401" 这类文本
}
```

**没有 Cookie 罐**。每次请求都是全新的，服务器种的 Cookie 不会自动带上。登录态必须自己拼 `Cookie` 请求头：

```js
headers: { Cookie: env.userVariables.cookie }
```

网络层有默认重试：超时、DNS 失败、连接被掐、TLS 握手失败、5xx、408、429 会自动再试，最多 3 次（首次 + 2 次重试），间隔约 0.4 秒和 0.9 秒。插件不需要自己实现重试。

注意重试对插件无感：插件看到的是最终结果，中间的重试不会让它多收到回调。

### 2.5 用户变量

用户填的值从 `env.userVariables` 读，只读：

```js
const token = (env.userVariables.token || '').trim();
// 或
const all = env.getUserVariables();
```

插件不能修改、也不需要持久化任何东西。写回由宿主负责。

### 2.6 并发与超时

- 一个插件实例只有一个 JS 上下文，**所有调用串行执行**。同一插件的两次 `search` 不会并行。
- 单次调用上限 **60 秒**（包含其中的所有 HTTP）。超时后运行时进入不可用状态，必须重新加载插件才能继续，界面上会提示。
- 因此不要写死循环等待、不要用定时器轮询、不要在一次调用里串太多请求。

### 2.7 被终止的调用

用户切歌、搜索翻页、退出页面时，宿主会取消正在进行的调用。此时插件里的 `axios` Promise 会 reject，文本是 `Plugin request cancelled.`。这是正常的，不要 try/catch 掉之后继续发请求——取消之后发出的请求不会被执行。

---

## 3. 插件对象：必须有什么

宿主加载插件时会校验：

1. `platform` 必须是非空字符串
2. 至少实现下表 14 个公开能力中的一个

不满足任一条，插件装不上。

### 3.1 元数据字段

| 字段 | 必需 | 宿主用途 |
|---|---|---|
| `platform` | **是** | 平台名，插件列表与来源筛选显示 |
| `version` | 建议 | 版本号，展示与升级比较 |
| `name` | 否 | 目录名兜底 |
| `author` | 否 | 插件详情展示 |
| `srcUrl` | 否 | 宿主当前不读，写了不报错 |
| `description` | 否 | 宿主当前不读，写了不报错 |
| `supportedSearchType` | 建议 | 声明哪些搜索类型能出结果，见 5.1 |
| `supportedQuality` / `supportedQualities` | 否 | 音质档位，缺省为 `low/standard/high/super` |
| `artistWorkTypes` / `supportedArtistWorkTypes` | 否 | 歌手页支持哪些作品类别（`music` / `album`） |
| `userVariables` | 否 | 用户变量表单定义，见第 8 节 |
| `login` | 否 | 扫码登录配置，见登录规范 |
| `cacheControl` | 否 | 直链缓存策略：`cache` / `no-cache`（默认）/ `no-store` |
| `primaryKey` | 否 | 兼容字段，宿主当前不读 |
| `appVersion`、`website`、`defaultSearchType`、`hints` | 否 | MusicFree 兼容字段，宿主当前不读，写了不报错 |

---

## 4. 能力总览：必需 vs 可选

宿主按方法是否存在判断能力。没实现的方法对应的入口不会出现，不会报错。

| 接口 | 级别 | 不实现的后果 |
|---|---|---|
| `search` | **必需** | 搜不到任何东西，插件基本没用 |
| `getMediaSource` | **必需** | 能搜到但播不了 |
| `getLyric` | 强烈建议 | 歌词页空白 |
| `getMusicInfo` | 强烈建议 | 播放时补不到完整信息（封面、时长、专辑） |
| `getMusicSheetInfo` | 可选 | 歌单点不进去 |
| `getAlbumInfo` | 可选 | 专辑点不进去 |
| `getArtistWorks` | 可选 | 歌手页点不进去 |
| `getTopLists` | 可选 | 发现页没有排行榜 |
| `getTopListDetail` | 可选 | 榜单只有列表没有曲目 |
| `getRecommendSheetTags` | 可选 | 推荐歌单没有分类 |
| `getRecommendSheetsByTag` | 可选 | 发现页没有推荐歌单 |
| `getRecommendWorks` | 可选 | 首页「为你推荐」里没有口味推荐 |
| `getDailySongs` | 可选 | 首页「为你推荐」里没有每日推荐 |
| `getMusicComments` | 可选 | 播放页没有评论入口 |
| `importMusicItem` | 可选 | 不能粘贴单曲链接导入 |
| `importMusicSheet` | 可选 | 不能粘贴歌单链接导入 |
| `createLoginQRCode` / `checkLoginQRCode` / `loginStatus` | 可选（三件套） | 不能扫码登录 |
| `refreshLogin` | 可选 | 登录态过期只能重新扫码 |

同族接口要成对实现：`getTopLists` 配 `getTopListDetail`，`getRecommendSheetTags` 配 `getRecommendSheetsByTag`，登录要三个一起。缺一个就是半截功能。

---

## 5. 接口逐个说明

通用约定：

- 所有方法都可以是 `async`，宿主拿到的返回值会被 JSON 序列化。返回 `undefined`、函数、循环引用都会导致调用失败。
- `page` 从 1 开始。
- 参数里的 `item` 就是你之前返回给宿主的那个对象**原样传回**（宿主会保留全部字段）。所以自定义字段（比如 `songId`、`bvid`）可以放心存在 `item` 里，后续从 `item.xxx` 取。

### 5.1 search

```js
search(keyword, page, type) -> { isEnd, data: [item, ...] }
```

| 参数 | 说明 |
|---|---|
| `keyword` | 用户输入的关键词 |
| `page` | 页码，从 1 开始 |
| `type` | `music` / `album` / `artist` / `sheet` / `lyric` |

返回：

| 字段 | 说明 |
|---|---|
| `data` | 结果数组，元素结构见第 6 节 |
| `isEnd` | 是否最后一页。不传时宿主按 `data` 为空判断 |

`supportedSearchType` 决定哪些类型**能出结果**。搜索页的五个页签是固定的（歌曲、专辑、歌手、歌单、歌词），用户点到插件没声明的类型时，宿主不会发请求，结果是空列表。

插件声明了但 `search` 里没处理这个 `type`，那个页签同样是空的，不报错。这是最容易踩的坑，见第 10 节。

`type: 'sheet'` 有个兼容：插件在 `supportedSearchType` 里写 `playlist` 也认，宿主会自动换过去。

### 5.2 getMediaSource

```js
getMediaSource(song, quality) -> { url, headers?, userAgent?, preview? }
```

| 返回字段 | 说明 |
|---|---|
| `url` | 必填。可直接播放的直链（http/https） |
| `headers` | 可选。拉流时要带的请求头，比如 `Referer`、`Cookie` |
| `userAgent` | 可选。单独指定 UA，等价于在 headers 里放 `User-Agent` |
| `preview` | 可选。`true` 表示这只是试听片段，宿主会提示用户且不写入缓存 |

`quality` 取值 `low` / `standard` / `high` / `super`。插件用 `supportedQuality` 声明支持哪些档位，用户切换时宿主传对应值。不支持某档位时**返回该档位能拿到的最高质量**，不要抛错——否则切档位就是播放失败。

拿不到任何地址时必须抛错，宿主会把这次失败当解析失败处理并重试；返回 `{url: ''}` 不会被当成成功。

### 5.3 getLyric

```js
getLyric(song) -> { rawLrc, translation? } | string
```

返回对象时，宿主依次找 `rawLrc`、`rawLrcTxt`、`lrc`、`lyric` 四个键，取第一个非空的。也可以直接返回 LRC 文本字符串。没有歌词返回 `null` 或空字符串。

LRC 格式照常：`[mm:ss.xx]歌词`。带翻译的用 `translation` 字段，同样是 LRC 文本。

### 5.4 getMusicInfo

```js
getMusicInfo(item) -> item
```

播放开始后宿主拿搜索结果里的 `item` 调一次，用来补全**正在播放的这一首**：标题、歌手、封面。返回能拿到的字段就行，缺的字段保留原值，不必回传完整对象。

三条宿主行为要注意：

- 返回的 `artwork` 非空时会替换封面，并写回队列项落盘，下次冷启动不用再请求
- 返回的 `url` **会被忽略**，不会覆盖已经解析好的音源
- 只影响正在播放的那一首，列表里的条目仍然是搜索时的样子

### 5.5 getAlbumInfo / getMusicSheetInfo

```js
getAlbumInfo(item, page)      -> { isEnd?, musicList, albumItem? }
getMusicSheetInfo(item, page) -> { isEnd?, musicList, sheetItem? }
```

| 字段 | 说明 |
|---|---|
| `musicList` | 曲目数组。也可以用 `data` 代替 |
| `isEnd` | 是否最后一页，缺省 `true` |
| `albumItem` / `sheetItem` | 可选。集合自身的元信息（标题、封面、简介），会合并到页面头部 |

`albumItem` / `sheetItem` 里宿主认的字段：`title`（标题）、`artwork` 或 `cover`（封面）、`description`（简介）。

`item` 就是用户点进来的那个专辑/歌单对象，里面有搜索时返回的 `id` 等字段。

### 5.6 getArtistWorks

```js
getArtistWorks(item, page, type) -> { isEnd?, musicList }
```

`type` 是 `music`（歌曲）或 `album`（专辑）。插件用 `artistWorkTypes: ['music', 'album']` 声明支持哪些；不声明时宿主只按 `music` 调用。

返回专辑列表时，`musicList` 里的元素是专辑对象（第 6.2 节），用户点进去会再走 `getAlbumInfo`。

### 5.7 getTopLists / getTopListDetail

```js
getTopLists() -> [ { title, data: [chartItem, ...] }, ... ]
getTopListDetail(item, page) -> { isEnd?, musicList | data }
```

`getTopLists` 返回分组数组。每个分组 `{ title: '分组名', data: [...] }`，`data` 里是榜单条目，条目至少要有 `title` 和一个能区分身份的 `id`。

`getTopListDetail` 收的是用户点的那个榜单条目，返回曲目。

### 5.8 getRecommendSheetTags / getRecommendSheetsByTag

```js
getRecommendSheetTags() -> { pinned?: [tag], data: [ { title, data: [tag] } ] }
getRecommendSheetsByTag(tag, page) -> { isEnd, data: [sheetItem, ...] }
```

分类结构是「置顶 + 分组」：`pinned` 是置顶分类数组，`data` 是分组数组，每组的 `data` 是分类条目。分类条目至少要有 `id` 或 `title`。

用户没选分类时，宿主会取 `pinned[0]` 或第一组的第一个分类去调 `getRecommendSheetsByTag`。没实现 `getRecommendSheetTags` 的话，宿主传一个空对象 `{}` 进去，插件自己兜底默认分类。

### 5.9 getRecommendWorks / getDailySongs

```js
getRecommendWorks() -> { isEnd, data: [musicItem, ...] }   // 按口味推荐，通常需要登录
getDailySongs()     -> { isEnd, data: [musicItem, ...] }   // 每日推荐，通常需要登录
```

这两个只影响首页推荐位。没登录时抛错即可，宿主会跳过。

### 5.10 getMusicComments

```js
getMusicComments(item, page) -> { isEnd, data: [comment, ...] }
```

评论条目宿主认的字段：

| 字段 | 说明 |
|---|---|
| `id` / `commentId` / `uid` | 唯一标识 |
| `nickName` / `username` / `nickname` / `user` | 昵称 |
| `comment` / `content` / `message` / `text` | 正文 |
| `time` / `createTime` / `date` | 时间 |
| `like` / `likeCount` / `likedCount` / `likes` | 点赞数 |
| `replies` / `reply` | 子回复数组，结构同上 |

### 5.11 importMusicItem / importMusicSheet

```js
importMusicItem(text)  -> musicItem
importMusicSheet(text) -> [musicItem, ...] | { musicList|data, title?, coverImg? }
```

`text` 是用户粘贴的原始文本，可能是链接、短链、整段分享文案，插件自己从中提取 ID。

单曲导入必须返回非空对象。歌单导入可以只返回曲目数组（歌单名退回默认、封面退回第一首），也可以返回带 `title` 和 `coverImg` 的对象，宿主会用上这两个字段。

### 5.12 登录四件套

```js
createLoginQRCode()      -> { key, qrData }
checkLoginQRCode(key)    -> { code, cookie? }
loginStatus(cookie)      -> { nickname?, avatar? }
```

`qrData` 是二维码里要编码的内容，通常是登录页 URL。`key` 是轮询凭证，宿主原样回传。

`code` 语义固定：`800` 过期、`801` 等待扫码、`802` 已扫码待确认、`803` 授权成功（此时必须给 `cookie`）。

`cookie` 是 `k=v; k=v` 请求头串，必须包含 `login.sessionCookieKey` 声明的字段。

完整约定见 [plugin-login-spec.md](plugin-login-spec.md)。

### 5.13 refreshLogin

```js
refreshLogin() -> { cookie }
```

用当前凭据换新凭据，不实现则宿主跳过续期。细节同样在登录规范里。

---

## 6. 数据结构

### 6.1 音乐条目

搜索、歌单、专辑、榜单、推荐返回的曲目都用这个结构。宿主认的字段：

| 字段 | 必需 | 说明 |
|---|---|---|
| `id` | **是** | 平台内唯一 ID，播放时原样回传 |
| `title` | **是** | 歌名。也认 `name` |
| `artist` | 建议 | 歌手。也认 `author` |
| `artwork` | 建议 | 封面 URL。也认 `cover`、`avatar` |
| `duration` | 建议 | 时长，秒 |
| `album` | 否 | 专辑名 |
| `type` | 否 | `music`（默认）/ `album` / `sheet` / `artist` |

`id` 缺失时宿主会拿 `title + artist` 拼一个，翻页时容易重复，不建议省。

自定义字段（`bvid`、`cid`、`songId`……）都保留在 `item` 里传回，随便加。

### 6.2 专辑 / 歌单 / 歌手条目

| 字段 | 说明 |
|---|---|
| `id` | 唯一 ID |
| `title` | 名称。也认 `name` |
| `artwork` | 封面。也认 `cover` |
| `artist` | 歌手/作者 |
| `description` | 简介 |
| `type` | `album` / `sheet` / `artist` |

`importMusicSheet` 返回对象时另有一套：`title` 和 `coverImg`（也认 `cover`、`coverUrl`、`coverURL`）。

### 6.3 分页

所有列表接口统一 `{ data, isEnd }`。`isEnd: true` 表示没有下一页。返回空数组等价于结束。

---

## 7. 错误处理

插件抛出的错误会变成用户看到的文案，所以**错误文本本身就是产品文案**，写人话：

```js
if (!token) throw new Error('还没配置 API Token，去插件详情里填一下');
if (res.status === 401) throw new Error('接口令牌失效了，请更新插件配置');
```

不要抛 `Error: 500`、`TypeError: undefined` 这类。宿主对两种情况有特殊处理：

- 错误文本含 `getUserVariables` / `getUserVariable` / `userVariables` 时，转成「请检查插件详情中的配置项」
- 错误文本含 `code=301` 时，视为登录态过期，先续期再重试（见登录规范）

`userVariables` 里声明了 `required: true` 的变量没填时，宿主在调用任何接口前就拦住并提示，插件不用自己校验。

---

## 8. 用户变量定义

```js
userVariables: [
  {
    key: 'token',            // 必填，env.userVariables 里的键名
    name: 'API Token',       // 表单里的标题
    type: 'password',        // text（默认）/ password
    required: true,          // 没填就拦住所有接口调用
    hint: '接口访问令牌',      // 输入框下方短提示
    description: '自建接口开了认证，必须填写才能搜索和播放',  // 详细说明
    defaultValue: ''         // 预填值
  }
]
```

`type: 'password'` 的值在界面上打码显示。变量存在宿主 Keychain 里，WebDAV 备份会带上它们。

---

## 9. 自测清单

装上插件后按顺序过一遍：

1. **搜索**：五个页签分别搜一次，返回的条目点得动
2. **播放**：点歌能出声，切到后台继续播
3. **音质**：切 `standard` / `high`，不报错且真的换了
4. **翻页**：一直翻到底，`isEnd` 生效，不重复不丢
5. **歌词**：有歌词的歌能滚，没歌词不卡住
6. **集合**：歌单、专辑、歌手各点进去一次，曲目能播
7. **发现页**：排行榜、推荐歌单、分类切换
8. **导入**：粘一条单曲链接、一条歌单链接
9. **断网**：断网后每个入口给出人话提示，不是英文异常
10. **切歌**：连续快速切十首，不卡死（说明没有阻塞式等待）

---

## 10. 常见坑

**用了 `setTimeout`。** 沙箱没有定时器，Promise 永远不 resolve，60 秒后运行时被终止，插件要重新加载。

**以为 Cookie 会自动带上。** 每请求独立，登录态必须放进 `headers.Cookie`。

**`headers` 里塞了非字符串。** 值必须是字符串，`{ 'X-Count': 10 }` 会让请求失败，要写 `'10'`。

**`getMediaSource` 返回空 url 而不是抛错。** 宿主当成功处理，然后播放失败，用户看到的是「播放失败」而不是可读原因。

**声明了搜索类型但 `search` 里没分支处理。** 那个页签永远空白，不报错，很难查。

**把大对象塞进 `item`。** `item` 会跟着队列、播放历史、备份走一遍，塞整页 HTML 会让这些数据膨胀。

**在 `search` 里同步阻塞。** 一次调用最多 60 秒，串多个请求时留足余量，能合并的接口就合并。

**`require('fs')`。** 沙箱没有文件系统，需要本地数据就交给宿主（用户变量）。
