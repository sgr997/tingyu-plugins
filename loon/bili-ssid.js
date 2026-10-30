/*
 * 由 bili-ssid.plugin 传入 officeWifi 与 proxyPolicy。
 * 当前 Wi-Fi 命中配置的名字时，把这个请求指定到代理策略组；否则原样放行，按主配置规则走。
 *
 * 只改出站策略，不改请求本身：url / headers / body 都不碰。
 */
const options = typeof $argument === 'object' && $argument ? $argument : {};

const WIFI_LIST = String(options.officeWifi || '')
  .split(/[,，\r\n]+/)
  .map(name => name.trim())
  .filter(Boolean);

const TARGET = String(options.proxyPolicy || '').trim() || 'PROXY';

/** getConfig 的字段随版本变动，ssid 用多个候选名兜一遍。 */
function currentSSID(config) {
  const keys = ['ssid', 'ssid_name', 'current_ssid', 'wifi_name'];
  for (let i = 0; i < keys.length; i += 1) {
    const value = config && config[keys[i]];
    if (typeof value === 'string') return value;
  }
  return '';
}

let finished = false;
function finish(result) {
  if (!finished) {
    finished = true;
    $done(result);
  }
}

try {
  const config = JSON.parse($config.getConfig() || '{}');
  const ssid = currentSSID(config);
  const hit = WIFI_LIST.length > 0 && WIFI_LIST.indexOf(ssid) !== -1;

  console.log('[bili-ssid] ssid=' + JSON.stringify(ssid)
    + ', configured=' + WIFI_LIST.length
    + ', hit=' + hit
    + ', target=' + TARGET);

  if (hit) {
    // node 接受 DIRECT、节点名或策略组名
    finish({ node: TARGET });
  } else {
    // 放行，交给主配置的规则决定（B 站一般是直连）
    finish({});
  }
} catch (e) {
  // 出错时放行，宁可走原规则也不要把请求拦死
  console.log('[bili-ssid] error: ' + String(e && e.message ? e.message : e));
  finish({});
}
