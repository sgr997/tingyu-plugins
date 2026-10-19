/*
 * 由 wyy-lan.plugin 传入 homeWifi 与 lanBase。
 * 指定 Wi-Fi 下主动请求局域网 API，转发方法、正文及响应。
 * 需要 MITM 证书信任，以及 Loon 本地网络权限。
 * HTTP 局域网请求会明文传输凭据与正文，仅用于可信网络。
 */
const options = typeof $argument === 'object' && $argument ? $argument : {};
const HOME_WIFIS = String(options.homeWifi || '')
  .split(/[,，\r\n]+/).map(name => name.trim()).filter(Boolean);
const LAN_BASE = String(options.lanBase || '').trim().replace(/\/+$/, '');
let finished = false;
function finish(result) {
  if (!finished) {
    finished = true;
    $done(result);
  }
}
function fail() {
  // 连接超时可能发生在服务端已处理请求之后，返回错误而不重发公网。
  finish({ response: {
    status: 502,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ code: 502, message: 'Loon 局域网 API 转发失败，请查看脚本日志' })
  } });
}
try {
  const config = JSON.parse($config.getConfig());
  const validBase = /^https?:\/\/[\w.-]+(?::\d+)?$/i.test(LAN_BASE);
  const matchesURL = /^https:\/\/wyy\.goku\.top(?=\/|$)/i.test($request.url);
  console.log('[wyy-lan v4] SSID=' + JSON.stringify(config.ssid || '')
    + ', configured=' + HOME_WIFIS.length + ', validBase=' + validBase);
  if (!HOME_WIFIS.length || !validBase || !HOME_WIFIS.includes(config.ssid) || !matchesURL) {
    console.log('[wyy-lan v4] KEEP: network or address not matched');
    finish({});
  } else {
    const method = String($request.method || 'GET').toLowerCase();
    const send = $httpClient[method];
    if (typeof send !== 'function') {
      console.log('[wyy-lan v4] Unsupported HTTPClient method: ' + method);
      fail();
    } else {
      const headers = { ...$request.headers };
      Object.keys(headers).forEach(key => {
        if (['host', 'connection', 'content-length', 'transfer-encoding',
          'accept-encoding', 'cf-access-client-id', 'cf-access-client-secret',
          'cf-access-jwt-assertion'].includes(key.toLowerCase())) delete headers[key];
      });
      const params = {
        url: $request.url.replace(/^https:\/\/wyy\.goku\.top(?=\/|$)/i, LAN_BASE),
        headers, node: 'DIRECT', timeout: 30000,
        'binary-mode': true, 'auto-redirect': false, 'auto-cookie': false
      };
      if ($request.body !== undefined && $request.body !== null) params.body = $request.body;
      console.log('[wyy-lan v4] FETCH ' + method.toUpperCase() + ' -> ' + LAN_BASE + ', node=DIRECT');
      send.call($httpClient, params, (error, response, data) => {
        if (error || !response) {
          // 不输出可能包含 URL、查询参数或凭据的底层错误字符串。
          console.log('[wyy-lan v4] LAN transport failed; request not retried');
          fail();
          return;
        }
        const status = Number(response.status);
        if (!Number.isInteger(status) || status < 200 || status > 599) {
          console.log('[wyy-lan v4] Invalid LAN response status');
          fail();
          return;
        }
        console.log('[wyy-lan v4] LAN response: HTTP ' + status);
        const responseHeaders = { ...(response.headers || {}) };
        // HTTPClient 已解码响应，由 Loon 重新计算长度与传输编码。
        Object.keys(responseHeaders).forEach(key => {
          if (['content-length', 'content-encoding', 'transfer-encoding', 'connection']
            .includes(key.toLowerCase())) delete responseHeaders[key];
        });
        finish({ response: {
          status, headers: responseHeaders,
          body: method === 'head' || status === 204 || status === 304 ? '' : (data == null ? '' : data)
        } });
      });
    }
  }
} catch (e) {
  console.log('[wyy-lan v4] Script exception: ' + e.name);
  fail();
}
