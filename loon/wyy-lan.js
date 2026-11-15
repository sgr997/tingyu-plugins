/*
 * 由 wyy-lan.plugin 传入 homeWifi、publicBase、lanBase。
 * 听屿网易云插件里把 apiBase 填成 PLACEHOLDER；本脚本再按当前网络把占位地址
 * 换成局域网或公网地址。地址只来自参数，脚本不内置任何地址或端口。
 * HTTP 请求不需要 MITM 证书；局域网请求会明文传输凭据与正文，仅用于可信网络。
 */
const PLACEHOLDER = 'http://wyy-api.invalid';

const options = typeof $argument === 'object' && $argument ? $argument : {};
const HOME_WIFIS = String(options.homeWifi || '')
  .split(/[,，\r\n]+/).map(name => name.trim()).filter(Boolean);
const LAN_BASE = String(options.lanBase || '').trim().replace(/\/+$/, '');
const PUBLIC_BASE = String(options.publicBase || '').trim().replace(/\/+$/, '');

const BASE_PATTERN = /^https?:\/\/[\w.-]+(?::\d+)?$/i;
const validLan = BASE_PATTERN.test(LAN_BASE);
const validPublic = BASE_PATTERN.test(PUBLIC_BASE);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const placeholderPrefix = new RegExp('^' + escapeRegExp(PLACEHOLDER) + '(?=/|$)', 'i');

let finished = false;
function finish(result) {
  if (!finished) {
    finished = true;
    $done(result);
  }
}
function fail() {
  // 连接超时可能发生在服务端已处理请求之后，返回错误而不重发。
  finish({ response: {
    status: 502,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ code: 502, message: 'Loon API 转发失败，请查看脚本日志' })
  } });
}
try {
  const config = JSON.parse($config.getConfig());
  const atHome = HOME_WIFIS.includes(config.ssid);
  const matchesURL = placeholderPrefix.test($request.url);
  // 在家且配了局域网地址 → 局域网；否则走公网。两者都缺就原样放行（会失败，
  // 但不会把请求发到脚本里不存在的地址）。
  const target = atHome && validLan ? LAN_BASE : (validPublic ? PUBLIC_BASE : '');
  console.log('[wyy-lan v7] SSID=' + JSON.stringify(config.ssid || '')
    + ', atHome=' + atHome
    + ', validLan=' + validLan + ', validPublic=' + validPublic
    + ', matched=' + matchesURL);
  if (!matchesURL || !target) {
    console.log('[wyy-lan v7] KEEP: address not matched or no target configured');
    finish({});
  } else {
    const method = String($request.method || 'GET').toLowerCase();
    const send = $httpClient[method];
    if (typeof send !== 'function') {
      console.log('[wyy-lan v7] Unsupported HTTPClient method: ' + method);
      fail();
    } else {
      const headers = { ...$request.headers };
      Object.keys(headers).forEach(key => {
        if (['host', 'connection', 'content-length', 'transfer-encoding',
          'accept-encoding', 'cf-access-client-id', 'cf-access-client-secret',
          'cf-access-jwt-assertion'].includes(key.toLowerCase())) delete headers[key];
      });
      const params = {
        url: $request.url.replace(placeholderPrefix, target),
        headers, node: 'DIRECT', timeout: 30000,
        'binary-mode': true, 'auto-redirect': false, 'auto-cookie': false
      };
      if ($request.body !== undefined && $request.body !== null) params.body = $request.body;
      console.log('[wyy-lan v7] FETCH ' + method.toUpperCase() + ' -> ' + (atHome ? 'LAN' : 'PUBLIC') + ', node=DIRECT');
      send.call($httpClient, params, (error, response, data) => {
        if (error || !response) {
          // 不输出可能包含 URL、查询参数或凭据的底层错误字符串。
          console.log('[wyy-lan v7] transport failed; request not retried');
          fail();
          return;
        }
        const status = Number(response.status);
        if (!Number.isInteger(status) || status < 200 || status > 599) {
          console.log('[wyy-lan v7] Invalid response status');
          fail();
          return;
        }
        console.log('[wyy-lan v7] response: HTTP ' + status);
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
  console.log('[wyy-lan v7] Script exception: ' + e.name);
  fail();
}
