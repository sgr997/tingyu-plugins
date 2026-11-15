/*
 * 由 wyy-lan.plugin 传入 homeWifi、lanBase、publicBase。
 * 在家 Wi-Fi 下把 wyy.goku.top 的请求转到局域网 API，其他网络转到公网 API。
 * 需要 MITM 证书信任，以及 Loon 本地网络权限。
 * HTTP 转发会明文传输凭据与正文，仅用于可信网络。
 */
const options = typeof $argument === 'object' && $argument ? $argument : {};
const HOME_WIFIS = String(options.homeWifi || '')
  .split(/[,，\r\n]+/).map(name => name.trim()).filter(Boolean);
const LAN_BASE = String(options.lanBase || '').trim().replace(/\/+$/, '');
const PUBLIC_BASE = String(options.publicBase || '').trim().replace(/\/+$/, '');
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
    body: JSON.stringify({ code: 502, message: 'Loon API 转发失败，请查看脚本日志' })
  } });
}
try {
  const config = JSON.parse($config.getConfig());
  const validLan = /^https?:\/\/[\w.-]+(?::\d+)?$/i.test(LAN_BASE);
  const validPublic = /^https?:\/\/[\w.-]+(?::\d+)?$/i.test(PUBLIC_BASE);
  const matchesURL = /^https:\/\/wyy\.goku\.top(?=\/|$)/i.test($request.url);
  const atHome = HOME_WIFIS.includes(config.ssid);
  // 在家走局域网；其他网络走公网。两边都没配时保持原地址。
  const target = atHome && validLan ? LAN_BASE : (validPublic ? PUBLIC_BASE : '');
  console.log('[wyy-lan v5] SSID=' + JSON.stringify(config.ssid || '')
    + ', atHome=' + atHome + ', validLan=' + validLan + ', validPublic=' + validPublic);
  if (!matchesURL || !target) {
    console.log('[wyy-lan v5] KEEP: address not matched');
    finish({});
  } else {
    const method = String($request.method || 'GET').toLowerCase();
    const send = $httpClient[method];
    if (typeof send !== 'function') {
      console.log('[wyy-lan v5] Unsupported HTTPClient method: ' + method);
      fail();
    } else {
      const headers = { ...$request.headers };
      Object.keys(headers).forEach(key => {
        if (['host', 'connection', 'content-length', 'transfer-encoding',
          'accept-encoding', 'cf-access-client-id', 'cf-access-client-secret',
          'cf-access-jwt-assertion'].includes(key.toLowerCase())) delete headers[key];
      });
      const params = {
        url: $request.url.replace(/^https:\/\/wyy\.goku\.top(?=\/|$)/i, target),
        headers, node: 'DIRECT', timeout: 30000,
        'binary-mode': true, 'auto-redirect': false, 'auto-cookie': false
      };
      if ($request.body !== undefined && $request.body !== null) params.body = $request.body;
      console.log('[wyy-lan v5] FETCH ' + method.toUpperCase() + ' -> ' + (atHome ? 'LAN' : 'PUBLIC') + ', node=DIRECT');
      send.call($httpClient, params, (error, response, data) => {
        if (error || !response) {
          // 不输出可能包含 URL、查询参数或凭据的底层错误字符串。
          console.log('[wyy-lan v5] transport failed; request not retried');
          fail();
          return;
        }
        const status = Number(response.status);
        if (!Number.isInteger(status) || status < 200 || status > 599) {
          console.log('[wyy-lan v5] Invalid response status');
          fail();
          return;
        }
        console.log('[wyy-lan v5] response: HTTP ' + status);
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
  console.log('[wyy-lan v5] Script exception: ' + e.name);
  fail();
}
