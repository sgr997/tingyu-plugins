/*
 * Loon 请求脚本，由 wyy-lan.plugin 传入 homeWifi 与 lanBase 参数。
 * 家中 Wi-Fi 使用局域网网易云 API，其他网络保持原请求。
 * 需要为 wyy.goku.top 开启 MITM 并信任 Loon 证书。
 * LAN 地址使用 HTTP 时，API Token 和 Cookie 在局域网内明文传输。
 */

const options = typeof $argument === 'object' && $argument ? $argument : {};
const HOME_WIFIS = String(options.homeWifi || '')
  .split(/[,，\r\n]+/)
  .map(name => name.trim())
  .filter(Boolean);
const LAN_BASE = String(options.lanBase || '').trim().replace(/\/+$/, '');

try {
  const config = JSON.parse($config.getConfig());

  if (!HOME_WIFIS.length || !/^https?:\/\/[\w.-]+(?::\d+)?$/i.test(LAN_BASE) || !HOME_WIFIS.includes(config.ssid)) {
    $done({});
  } else {
    const headers = { ...$request.headers };
    Object.keys(headers).forEach(key => {
      if ([
        'host',
        'cf-access-client-id',
        'cf-access-client-secret',
        'cf-access-jwt-assertion'
      ].includes(key.toLowerCase())) {
        delete headers[key];
      }
    });

    $done({
      url: $request.url.replace(
        /^https:\/\/wyy\.goku\.top(?=\/|$)/i,
        LAN_BASE
      ),
      headers,
      node: 'DIRECT'
    });
  }
} catch (e) {
  console.log('网易云局域网切换：' + e.message);
  $done({});
}
