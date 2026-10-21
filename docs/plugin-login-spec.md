# 听屿插件登录规范（登录 + 续期）

> 适用对象：任何想在听屿里提供账号登录能力的插件。
> 架构约定：宿主只认协议不认具体平台——宿主导固定流程（模板方法），每个插件自己实现「怎么换凭据」（策略），可选能力用方法存在性表达（抽象方法）。

## 1. 能力声明：login 元数据

```js
module.exports.login = {
  sessionCookieKey: 'SESSIONID', // 核心鉴权字段名（示例），换成你平台真实的会话字段
  sessionTTL: 30,                // 预估有效期（天），账号页展示剩余天数
  preferredVariableKey: 'cookie' // 凭据写入 userVariables 的键名
}
```

- 声明了 `login` 的插件才会出现在「我的 → 账号登录」。
- 三字段都是必填。`sessionTTL` 只是预估，宿主不依赖它做精确续期计时。

## 2. 登录（已有规范，回顾）

三个方法按 MusicFree 插件约定实现：

| 方法 | 语义 |
|---|---|
| `createLoginQRCode()` | 生成扫码登录凭据，返回 `{ key, qrData }`：`qrData` 是二维码内容（登录页 URL 或图片地址），`key` 是轮询凭证 |
| `checkLoginQRCode(key)` | 轮询扫码状态；`803` 授权成功时返回 `{ code: 803, cookie }` |
| `loginStatus(cookie)` | 换用户信息，返回 `{ nickname, avatar }` |

- `cookie` 是 `k=v; k=v` 请求头串，**必须包含 `sessionCookieKey` 声明的字段**，否则宿主拒收。
- 登录成功后宿主负责落库（账号库 + 插件变量两处），插件不需要持久化任何东西。

## 3. 续期（可选能力，v1.1.9 起支持）

### 3.1 接入方式

导出一个 `refreshLogin()` 方法即完成接入。宿主通过方法存在性判断能力：不实现，宿主静默跳过续期，插件一切照旧。

### 3.2 方法契约

```js
async function refreshLogin() {
  const cookie = cookieHeader();          // 自己从 env.userVariables 读（对插件只读）
  if (!cookie) throw new Error('还没有登录');
  // 调你平台自己的会话续期接口……
  return { code: 200, cookie: '<新凭据串>' };
}
```

| 情形 | 插件行为 |
|---|---|
| 换新成功 | `return { code: 200, cookie: '…' }`，凭据串必须包含 `sessionCookieKey` 字段 |
| 凭据已被服务端判死（只能重登） | `throw` 任意错误，宿主一律按「续期失败」处理，引导重新扫码 |
| 网络/接口抖动 | `throw`，宿主静默放弃，下次再试 |

插件**只负责换、不负责存**：`env.userVariables` 对插件只读，回写由宿主完成。

### 3.3 宿主固定流程（模板方法，插件不用管）

1. **single-flight**：同一插件同时只允许一个续期在飞，并发请求共享同一个结果
2. **回写两处**：账号库（Keychain）+ 插件 userVariables（`runtime(for:)` 每次重建，写后自动生效）
3. **节流**：距上次成功续期 ≥ 20 天才真正发请求（按 TTL 30 天留 10 天余量；App 启动时触发，无定时器）
4. **301 兜底**：登录态接口返回失效信号 → 先续期 → 重试原请求一次 → 仍失败才走重新扫码

### 3.4 登录态失效信号（唯一的文本契约）

登录态接口在凭据过期时抛出的错误文本**必须包含 `code=301`**。宿主按这个文本识别「需要续期」——不管你后端原生的未登录码是什么，插件层要归一成这个标记。

JS 桥没有类型化错误，文本就是契约；宿主契约测试锁住了两端格式。

## 4. 接入示例

最小骨架（会话字段名、续期接口路径按你平台真实情况替换；`apiBase()`、`cookieHeader()` 等辅助函数按你插件自己的实现替换）：

```js
/** 登录续期：拿当前 Cookie 调平台的会话续期接口，换回新 Cookie。
 * 成功返回 { code: 200, cookie }；凭据已死或网络失败直接 throw。 */
async function refreshLogin() {
  const cookie = cookieHeader();
  if (!cookie) throw new Error('还没有登录，先去「账号登录」扫码');
  const res = await axios.get(apiBase() + '/auth/refresh', {
    params: { timestamp: Date.now() },
    headers: { Cookie: cookie }
  });
  const body = res.data || {};
  if (body.code !== 200) throw new Error(`续期失败：code=${body.code}`);
  const raw = body.cookie || '';
  // 凭据串必须包含 login.sessionCookieKey 声明的字段，宿主会校验
  if (!/(^|;\s*)SESSIONID=/.test(raw)) throw new Error('续期没有返回有效凭据');
  return { code: 200, cookie: raw };
}

module.exports = {
  // ……其他导出
  login: {
    sessionCookieKey: 'SESSIONID',
    sessionTTL: 30,
    preferredVariableKey: 'cookie'
  },
  createLoginQRCode,
  checkLoginQRCode,
  loginStatus,
  refreshLogin
};
```

两个要点：

1. `refreshLogin` 是**可选**导出：不实现，宿主静默跳过续期，插件其余功能不受影响
2. 凭据串格式必须是 `k=v; k=v` 请求头串（不是 Set-Cookie 数组、不是 JSON），且包含 `sessionCookieKey` 字段
