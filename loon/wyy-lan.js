/*
 * 由 wyy-lan.plugin 传入 homeWifi 与 lanBase。
 * 指定 Wi-Fi 下主动请求局域网 API，将响应返回客户端；失败时使用原公网请求。
 * 仅处理 GET。需要 MITM 证书信任，以及 Loon 本地网络权限。
 * HTTP 局域网请求会明文传输 API Token 和 Cookie，仅用于可信网络。
 */

const options = typeof $argument === 'object' && $argument ? $argument : {};
const HOME_WIFIS = String(options.homeWifi || '')
  .split(/[,，\r\n]+/)
  .map(name => name.trim())
  .filter(Boolean);
const LAN_BASE = String(options.lanBase || '').trim().replace(/\/+$/, '');

try {
  const config = JSON.parse($config.getConfig());
  const validBase = /^https?:\/\/[\w.-]+(?::\d+)?$/i.test(LAN_BASE);
  const matchesURL = /^https:\/\/wyy\.goku\.top(?=\/|$)/i.test($request.url);
  const isGet = String($request.method || '').toUpperCase() === 'GET';
  console.log('[wyy-lan v3] SSID=' + JSON.stringify(config.ssid || '')
    + ', configured=' + HOME_WIFIS.length + ', validBase=' + validBase);

  if (!HOME_WIFIS.length || !validBase || !HOME_WIFIS.includes(config.ssid)
      || !matchesURL || !isGet) {
    console.log('[wyy-lan v3] KEEP: network, address or method not matched');
    $done({});
  } else {
    const headers = { ...$request.headers };
    Object.keys(headers).forEach(key => {
      if ([
        'host', 'connection', 'content-length', 'accept-encoding',
        'cf-access-client-id', 'cf-access-client-secret',
        'cf-access-jwt-assertion'
      ].includes(key.toLowerCase())) delete headers[key];
    });

    const url = $request.url.replace(/^https:\/\/wyy\.goku\.top(?=\/|$)/i, LAN_BASE);
    console.log('[wyy-lan v3] FETCH -> ' + LAN_BASE + ', node=DIRECT');
    $httpClient.get({
      url,
      headers,
      node: 'DIRECT',
      timeout: 30000,
      'auto-redirect': false,
      'auto-cookie': false
    }, (error, response, data) => {
      if (error || !response) {
        console.log('[wyy-lan v3] LAN connection failed; using public request. Error: '
          + String(error || 'missing response').split(url).join('[LAN request]'));
        $done({});
        return;
      }

      const status = Number(response.status);
      const responseHeaders = { ...(response.headers || {}) };
      const contentType = Object.keys(responseHeaders)
        .find(key => key.toLowerCase() === 'content-type');
      const isJSON = contentType && /application\/json/i.test(responseHeaders[contentType]);
      console.log('[wyy-lan v3] LAN response: HTTP ' + status + ', JSON=' + !!isJSON);
      if (!isJSON || status >= 500 || status < 200 || (status >= 300 && status < 400)) {
        console.log('[wyy-lan v3] Unusable LAN response; using public request');
        $done({});
        return;
      }

      // Loon HTTPClient 已解码响应，交回客户端时重新计算长度和传输编码。
      Object.keys(responseHeaders).forEach(key => {
        if (['content-length', 'content-encoding', 'transfer-encoding', 'connection']
          .includes(key.toLowerCase())) delete responseHeaders[key];
      });
      $done({ response: { status, headers: responseHeaders, body: data } });
    });
  }
} catch (e) {
  console.log('[wyy-lan v3] Script exception; using public request: ' + e.name);
  $done({});
}
