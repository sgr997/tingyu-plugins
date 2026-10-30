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

/** 组名常带 emoji 和空格，填的时候容易漏；比较前统一去掉。 */
function normName(value) {
  return String(value || '')
    .replace(/[\uFE0F\u200D]/g, '')
    .replace(/[\u{1F000}-\u{1FAFF}]/gu, '')
    .replace(/[\u2600-\u27BF]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/** 从 getConfig 里挖出所有策略组名字，字段名随版本变，几个候选都试。 */
function policyGroupNames(config) {
  const keys = ['all_policy_groups', 'policy_groups', 'policies', 'policyGroups'];
  const out = [];
  for (let i = 0; i < keys.length; i += 1) {
    const list = config && config[keys[i]];
    if (!Array.isArray(list)) continue;
    for (let j = 0; j < list.length; j += 1) {
      const item = list[j];
      const name = typeof item === 'string' ? item : (item && (item.name || item.title || item.group)) || '';
      if (name && out.indexOf(name) === -1) out.push(String(name));
    }
  }
  return out;
}

/** 先精确匹配，再忽略 emoji/空格/大小写，最后按包含关系兜一次。 */
function matchGroup(target, names) {
  if (!target) return '';
  if (names.indexOf(target) !== -1) return target;
  const want = normName(target);
  if (!want) return '';
  for (let i = 0; i < names.length; i += 1) {
    if (normName(names[i]) === want) return names[i];
  }
  for (let i = 0; i < names.length; i += 1) {
    const n = normName(names[i]);
    if (n && (n.indexOf(want) !== -1 || want.indexOf(n) !== -1)) return names[i];
  }
  return '';
}

/** 把策略组解析成它当前选中的节点；传入的本来就是节点名时返回空。 */
function resolveNode(name) {
  if (!name) return '';
  try {
    const selected = $config.getSelectedPolicy(name);
    return selected ? String(selected).trim() : '';
  } catch (e) {
    return '';
  }
}

/** 失败才弹通知，同一内容 5 分钟内只弹一次，避免每首歌都跳。 */
function notifyOnce(subtitle, content) {
  try {
    const key = 'bili-ssid-notify';
    const last = String($persistentStore.read(key) || '');
    const now = Date.now();
    if (last && now - Number(last) < 5 * 60 * 1000) return;
    $persistentStore.write(String(now), key);
    $notification.post('B站按Wi-Fi分流：未生效', subtitle, content);
  } catch (e) {
    // 通知失败不影响放行
  }
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

  const names = policyGroupNames(config);
  const group = hit ? matchGroup(TARGET, names) : '';
  const node = group ? resolveNode(group) : '';

  console.log('[bili-ssid] ssid=' + JSON.stringify(ssid)
    + ', configured=' + WIFI_LIST.length
    + ', hit=' + hit
    + ', target=' + JSON.stringify(TARGET)
    + ', group=' + JSON.stringify(group)
    + ', node=' + JSON.stringify(node));

  if (!hit) {
    // 不在这台 Wi-Fi，交给主配置的规则决定
    finish({});
  } else if (node) {
    // 拿到组里当前选中的节点名，node 对节点名是文档写明的
    finish({ node: node });
  } else {
    // 解析不出节点名就别往下传：node 填了无效值会让 Loon 报「找不到策略」并弄坏这次请求
    const detail = names.length
      ? 'Loon 里的策略组：' + names.join(' / ')
      : '读不到策略组，config 字段：' + Object.keys(config || {}).join(',');
    console.log('[bili-ssid] 没解析出节点，本次放行（不指定出站）。'
      + ' 你填的是 ' + JSON.stringify(TARGET) + '；' + detail);
    notifyOnce('填的策略组没匹配上：' + TARGET, detail);
    finish({});
  }
} catch (e) {
  // 出错时放行，宁可走原规则也不要把请求拦死
  console.log('[bili-ssid] error: ' + String(e && e.message ? e.message : e));
  finish({});
}
