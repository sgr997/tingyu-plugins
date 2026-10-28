/**
 * @name 听屿 · bilibili
 * @description 哔哩哔哩音源。按 bilibili-API-collect 现行文档改造：WBI 签名、buvid3 cookie、https 封面、评论翻页
 * @author 猫头猫（原版）/ 听屿（改造）
 * @version 0.4.2
 * @srcUrl 见模块导出
 */

// MusicFree 插件运行在 JS 沙箱里，这些包由宿主注入。
const axios = require('axios');
const dayjs = require('dayjs');
const he = require('he');
const CryptoJs = require('crypto-js');

const PLATFORM = '听屿·bilibili';
const API = 'https://api.bilibili.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
/** 播放地址请求头用的 UA，与原版保持一致（CDN 按它分档）。 */
const MEDIA_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/89.0.4389.90 Safari/537.36 Edg/89.0.774.63';
const PLUGIN_SRC_URL = [
  'https://raw.githubusercontent.com',
  'sgr997',
  'tingyu-plugins',
  'main/tingyu/tingyu-bilibili.js'
].join('/');
const pageSize = 20;

const BASE_HEADERS = {
  'user-agent': UA,
  accept: '*/*',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8'
};

// ============================ 错误与字段整理 ============================

/** code 不为 0 就抛错；风控类错误单独给文案，避免把 -352 当普通失败。 */
function assertPayload(payload, what) {
  if (!payload || typeof payload !== 'object') {
    throw new Error(what + '：接口没有返回数据');
  }
  if (payload.code === undefined || payload.code === 0) return payload;
  if (payload.code === -352 || payload.code === -412 || payload.code === -403) {
    throw new Error(what + '：被 B 站风控拦截（' + payload.code + '），稍后再试');
  }
  throw new Error(what + '：' + (payload.message || 'code=' + payload.code));
}

/**
 * B 站封面和播放地址都爱给 http，App 开了 ATS（不允许明文 HTTP）会直接失败。
 * 只把 B 站自家 CDN 升到 https，外链保持原样。
 */
const SECURE_HOSTS = /(hdslb\.com|biliimg\.com|bilivideo\.(com|cn)|biliapi\.net)/i;
function secure(url) {
  if (typeof url !== 'string' || !url) return '';
  const normalized = url.startsWith('//') ? 'https:' + url : url;
  if (/^http:\/\//i.test(normalized) && SECURE_HOSTS.test(normalized)) {
    return normalized.replace(/^http:/i, 'https:');
  }
  return normalized;
}

function durationToSec(duration) {
  if (typeof duration === 'number') return duration;
  if (typeof duration === 'string') {
    return duration.split(':').reduce(function (prev, curr) {
      return 60 * prev + +curr;
    }, 0);
  }
  return 0;
}

// ============================ 设备标识与 WBI 密钥 ============================

/** buvid3 / buvid4 全站通用，取一次复用（与原版一致）。 */
let buvid = null;
async function ensureBuvid() {
  if (buvid) return buvid;
  const res = await axios.get(API + '/x/frontend/finger/spi', {
    headers: { 'user-agent': UA },
    timeout: 15000
  });
  const data = assertPayload(res.data, '获取设备标识').data;
  if (!data || !data.b_3) throw new Error('获取设备标识：接口没有返回 buvid3');
  buvid = { b_3: data.b_3, b_4: data.b_4, nut: Math.floor(Date.now() / 1000) };
  return buvid;
}

/** WBI 密钥来自 bili_ticket 的 nav 字段，文档说明每日更替，这里按 6 小时刷新。 */
const WBI_TTL = 6 * 60 * 60 * 1000;
let wbi = null;

function keyFromURL(url) {
  const text = String(url || '');
  return text.slice(text.lastIndexOf('/') + 1, text.lastIndexOf('.'));
}

async function fetchWbiKeys() {
  const ts = Math.floor(Date.now() / 1000);
  const hexsign = CryptoJs.HmacSHA256('ts' + ts, 'XgwSnGZ1p').toString(CryptoJs.enc.Hex);
  const res = await axios.post(
    API + '/bapis/bilibili.api.ticket.v1.Ticket/GenWebTicket',
    null,
    {
      params: { key_id: 'ec02', hexsign: hexsign, 'context[ts]': ts, csrf: '' },
      headers: { 'user-agent': UA },
      timeout: 15000
    }
  );
  const body = assertPayload(res.data, '获取 WBI 密钥').data || {};
  const nav = body.nav || {};
  if (!nav.img || !nav.sub) throw new Error('获取 WBI 密钥：接口没有返回 img/sub');
  return {
    imgKey: keyFromURL(nav.img),
    subKey: keyFromURL(nav.sub),
    ticket: body.ticket || '',
    at: Date.now()
  };
}

async function ensureWbi(force) {
  if (!wbi || force || Date.now() - wbi.at > WBI_TTL) wbi = await fetchWbiKeys();
  return wbi;
}

/** 与原版一致：只带 buvid3 / buvid4，bili_ticket 只用来换 WBI 密钥。 */
async function cookieForApi() {
  // 与原版一致：只带 buvid3 / buvid4 两个字段。
  const device = await ensureBuvid();
  return 'buvid3=' + device.b_3 + ';buvid4=' + device.b_4;
}

const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5,
  49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55,
  40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57,
  62, 11, 36, 20, 34, 44, 52
];

function mixinKey(imgKey, subKey) {
  const raw = imgKey + subKey;
  let out = '';
  for (let i = 0; i < MIXIN_TAB.length; i += 1) {
    const char = raw.charAt(MIXIN_TAB[i]);
    if (char) out += char;
  }
  return out.slice(0, 32);
}

/** 参数按 key 升序、值过滤 !'()* 后拼接，末尾接 mixin_key 取 MD5。 */
function encWbi(params, imgKey, subKey) {
  const signed = Object.assign({}, params, { wts: Math.floor(Date.now() / 1000) });
  const query = Object.keys(signed)
    .sort()
    .filter(function (key) {
      return signed[key] !== undefined && signed[key] !== null;
    })
    .map(function (key) {
      const value = String(signed[key]).replace(/[!'()*]/g, '');
      return encodeURIComponent(key) + '=' + encodeURIComponent(value);
    })
    .join('&');
  signed.w_rid = CryptoJs.MD5(query + mixinKey(imgKey, subKey)).toString();
  return signed;
}

// ============================ 请求 ============================

/** 风控挑战：签名通过但返回 v_voucher，说明被要求验证，不是「没结果」。 */
function isChallenge(data) {
  return !!(data && data.data && data.data.v_voucher);
}

/** 风控类失败单独给文案，方便一眼看出是限流而不是接口坏了。 */
function riskError(what, detail) {
  const error = new Error(what + '：' + detail + '，稍后再试');
  error.risk = true;
  return error;
}

const RISK_CODES = [-352, -403, -412];

/**
 * 一次请求，失败就把原因抛给宿主——原版插件没有重试，这里也不加。
 * 宿主运行时没有定时器（只注入 __hostHTTPRequest），任何退避等待都会直接抛
 * `Can't find variable: setTimeout`，表现为「详情加载失败」。
 */
async function signedGet(path, params, options) {
  const opts = options || {};
  const what = opts.what || '请求';
  const keys = await ensureWbi(false);
  const query = encWbi(params || {}, keys.imgKey, keys.subKey);
  const headers = Object.assign({}, BASE_HEADERS, opts.headers || {});
  if (opts.cookie !== false) headers.cookie = await cookieForApi();
  let res;
  try {
    res = await axios.get(API + path, { params: query, headers: headers, timeout: 15000 });
  } catch (e) {
    const status = e && e.response && e.response.status;
    if (status === 412) throw riskError(what, '被 B 站风控拦截（HTTP 412）');
    throw new Error(what + '：' + (status ? '接口返回 HTTP ' + status : '请求失败：' + e.message));
  }
  const data = res.data;
  if (isChallenge(data)) throw riskError(what, '触发了 B 站人机校验（v_voucher）');
  if (data && RISK_CODES.indexOf(data.code) !== -1) {
    throw riskError(what, '被 B 站风控拦截（' + data.code + '）');
  }
  return assertPayload(data, what);
}

/** 不需要签名的 GET。 */
async function plainGet(path, params, options) {
  const opts = options || {};
  const what = opts.what || '请求';
  const headers = Object.assign({}, BASE_HEADERS, opts.headers || {});
  if (opts.cookie) headers.cookie = await cookieForApi();
  let res;
  try {
    res = await axios.get(API + path, { params: params || {}, headers: headers, timeout: 15000 });
  } catch (e) {
    const status = e && e.response && e.response.status;
    if (status === 412) throw riskError(what, '被 B 站风控拦截（HTTP 412）');
    throw new Error(what + '：' + (status ? '接口返回 HTTP ' + status : '请求失败：' + e.message));
  }
  const data = res.data;
  if (isChallenge(data)) throw riskError(what, '触发了 B 站人机校验（v_voucher）');
  if (data && RISK_CODES.indexOf(data.code) !== -1) {
    throw riskError(what, '被 B 站风控拦截（' + data.code + '）');
  }
  return assertPayload(data, what);
}

// ============================ 视频信息 ============================

/**
 * 取分P信息（含 cid）。按原版用 /x/web-interface/view：
 * 它同时给 data.cid 和 data.pages，单P 视频也有 cid 兜底。
 */
async function getPages(bvid, aid) {
  const params = bvid ? { bvid: bvid } : { aid: aid };
  const data = (await plainGet('/x/web-interface/view', params, {
    what: '获取视频信息'
  })).data || {};
  if (Array.isArray(data.pages) && data.pages.length) return data.pages;
  return data.cid ? [{ cid: data.cid }] : [];
}

/** cid 按 bvid/aid 缓存，重播和重复取流不用再打一次分P接口。 */
const cidCache = {};

/**
 * 从条目里认出视频身份。宿主「查看专辑」只给一个 id（就是我们返回的 albumId），
 * 不带 bvid/aid，所以这里要把 BV 号或纯数字 aid 从 id 里还原出来。
 */
function videoIds(item) {
  let bvid = item.bvid;
  let aid = item.aid;
  if (!bvid && !aid && item.id !== undefined && item.id !== null) {
    const text = String(item.id).trim();
    if (/^BV[0-9A-Za-z]{10}$/i.test(text)) bvid = text;
    else if (/^\d+$/.test(text)) aid = text;
  }
  return { bvid: bvid, aid: aid };
}

function mediaKey(item) {
  const ids = videoIds(item || {});
  if (ids.bvid) return ids.bvid;
  if (ids.aid) return 'aid' + ids.aid;
  return '';
}

async function resolveCid(item) {
  if (item.cid) return item.cid;
  const key = mediaKey(item);
  if (key && cidCache[key]) return cidCache[key];
  const ids = videoIds(item);
  const pages = await getPages(ids.bvid, ids.aid);
  const cid = pages.length ? pages[0].cid : null;
  if (cid && key) cidCache[key] = cid;
  return cid;
}

function formatMedia(result) {
  const raw = result || {};
  const title = he.decode(String(raw.title || '').replace(/(<em(.*?)>)|(<\/em>)/g, ''));
  const alias = title.match(/《(.+?)》/);
  const upMid = raw.mid || (raw.owner && raw.owner.mid);
  const bvid = raw.bvid;
  return {
    id: raw.cid || bvid || raw.aid,
    aid: raw.aid,
    bvid: bvid,
    artist: raw.author || (raw.owner && raw.owner.name),
    // 宿主的「歌手」入口优先读 artistId，没有它就只能拿歌名去搜，容易落到别的 UP 主。
    artistId: upMid ? String(upMid) : undefined,
    title: title,
    alias: alias ? alias[1] : undefined,
    // 「专辑」入口同理：直接给 bvid，宿主据此调 getAlbumInfo 拿分P，不用再按名字搜。
    album: bvid || raw.aid,
    albumId: bvid || raw.aid,
    artwork: secure(raw.pic),
    duration: durationToSec(raw.duration),
    tags: raw.tag ? raw.tag.split(',') : undefined,
    date: raw.pubdate || raw.created
      ? dayjs.unix(raw.pubdate || raw.created).format('YYYY-MM-DD')
      : undefined
  };
}

// ============================ 搜索 ============================

const searchHeaders = {
  accept: 'application/json, text/plain, */*',
  origin: 'https://search.bilibili.com',
  referer: 'https://search.bilibili.com/'
};

async function searchBase(keyword, page, searchType) {
  // 与原版一致：普通接口 + buvid cookie，不做 WBI 签名。
  const data = (await plainGet(
    '/x/web-interface/search/type',
    {
      context: '',
      page: page,
      order: '',
      page_size: pageSize,
      keyword: keyword,
      duration: '',
      tids_1: '',
      tids_2: '',
      __refresh__: true,
      _extra: '',
      highlight: 1,
      single_column: 0,
      platform: 'pc',
      from_source: '',
      search_type: searchType,
      dynamic_offset: 0
    },
    { headers: searchHeaders, cookie: true, what: '搜索' }
  )).data;
  return data || {};
}

async function searchAlbum(keyword, page) {
  const data = await searchBase(keyword, page, 'video');
  const list = Array.isArray(data.result) ? data.result : [];
  return {
    isEnd: (data.numResults || 0) <= page * pageSize || list.length === 0,
    data: list.map(formatMedia)
  };
}

async function searchArtist(keyword, page) {
  const data = await searchBase(keyword, page, 'bili_user');
  const list = Array.isArray(data.result) ? data.result : [];
  return {
    isEnd: (data.numResults || 0) <= page * pageSize || list.length === 0,
    data: list.map(function (result) {
      return {
        name: result.uname,
        id: result.mid,
        fans: result.fans,
        description: result.usign,
        avatar: secure(result.upic),
        worksNum: result.videos
      };
    })
  };
}

// ============================ UP 主投稿 ============================

async function getArtistWorks(artistItem, page) {
  // dm_img_* 是网页端带的反爬指纹，去掉后更容易被判 -352，所以保留。
  const payload = await signedGet(
    '/x/space/wbi/arc/search',
    {
      mid: artistItem.id,
      ps: 30,
      tid: 0,
      pn: page,
      web_location: 1550101,
      order_avoided: true,
      order: 'pubdate',
      keyword: '',
      platform: 'web',
      dm_img_list: '[]',
      dm_img_str: 'V2ViR0wgMS4wIChPcGVuR0wgRVMgMi4wIENocm9taXVtKQ',
      dm_cover_img_str:
        'QU5HTEUgKE5WSURJQSwgTlZJRElBIEdlRm9yY2UgR1RYIDE2NTAgKDB4MDAwMDFGOTEpIERpcmVjdDNEMTEgdnNfNV8wIHBzXzVfMCwgRDNEMTEpR29vZ2xlIEluYy4gKE5WSURJQS',
      dm_img_inter: '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}'
    },
    {
      headers: {
        accept: '*/*',
        'accept-encoding': 'gzip, deflate, br, zstd',
        origin: 'https://space.bilibili.com',
        'sec-fetch-site': 'same-site',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
        referer: 'https://space.bilibili.com/' + artistItem.id + '/video'
      },
      what: '获取 UP 主投稿'
    }
  );
  const data = payload.data || {};
  const list = (data.list && data.list.vlist) || [];
  const info = data.page || {};
  const total = info.count || list.length;
  return {
    isEnd: !list.length || (info.pn || page) * (info.ps || 30) >= total,
    data: list.map(formatMedia)
  };
}

// ============================ 播放地址 ============================

function hostOf(url) {
  const match = /^[a-z]+:\/\/([^/?#]+)/i.exec(String(url || ''));
  return match ? match[1] : '';
}

/**
 * baseUrl 常是 mcdn.bilivideo.cn:8082 这类 P2P 边缘节点，实测首字节 300–450ms、
 * 速度 0.7–1MB/s；同一首歌的 backupUrl 里 upos 镜像首字节 60–190ms、6–16MB/s。
 * AVPlayer 不会自己换源，所以这里按 host 挑最快的一档。
 * 优先级：upos 镜像 > 国内 cn- 节点 > mcdn 原始地址 > 其它未知域名（可能是死节点）。
 */
const HOST_UPOS = /^upos-[a-z0-9-]+\.bilivideo\.com$/i;
const HOST_CN = /^cn-[a-z0-9-]+\.bilivideo\.com$/i;
const HOST_MCDN = /mcdn\.bilivideo\.cn/i;

function rankCandidate(url) {
  const host = hostOf(url);
  if (HOST_UPOS.test(host)) return 0;
  if (HOST_CN.test(host)) return 1;
  if (HOST_MCDN.test(host)) return 2;
  return 3;
}

function pickBestURL(baseURL, backups) {
  const candidates = [baseURL].concat(Array.isArray(backups) ? backups : []).filter(Boolean);
  const unique = candidates.filter(function (url, index) {
    return candidates.indexOf(url) === index;
  });
  unique.sort(function (a, b) {
    return rankCandidate(a) - rankCandidate(b);
  });
  return unique[0];
}

/**
 * playurl 结果按 cid + 音质缓存 5 分钟。
 * 同一集来回点、暂停后重播、失败重试都不用再打一次接口；
 * 直链有效期是小时级，5 分钟内不会过期（过期由宿主 403 重解析兜底）。
 */
const playurlCache = {};
const PLAYURL_TTL = 5 * 60 * 1000;

function cachedMedia(key) {
  const hit = playurlCache[key];
  if (!hit) return null;
  if (Date.now() - hit.at > PLAYURL_TTL) { delete playurlCache[key]; return null; }
  return { url: hit.url, headers: Object.assign({}, hit.headers) };
}

async function getMediaSource(musicItem, quality) {
  const cid = await resolveCid(musicItem);
  if (!cid) throw new Error('获取播放地址：缺少视频 cid');

  const cacheKey = cid + '|' + (quality || 'standard');
  const hit = cachedMedia(cacheKey);
  if (hit) return hit;

  // 与原版一致：普通 playurl 接口，参数只有 bvid/aid + cid + fnval。
  const ids = videoIds(musicItem);
  const params = { cid: cid, fnval: 16 };
  if (ids.bvid) params.bvid = ids.bvid;
  else params.aid = ids.aid;

  const data = (await plainGet('/x/player/playurl', params, {
    what: '获取播放地址'
  })).data;
  if (!data) throw new Error('获取播放地址：接口没有返回数据');

  let url;
  const audios = data.dash && Array.isArray(data.dash.audio) ? data.dash.audio.slice() : [];
  if (audios.length) {
    audios.sort(function (a, b) {
      return a.bandwidth - b.bandwidth;
    });
    const last = audios.length - 1;
    let audio;
    switch (quality) {
      case 'low':
        audio = audios[0];
        break;
      case 'standard':
        audio = audios[Math.min(1, last)];
        break;
      case 'high':
        audio = audios[Math.min(2, last)];
        break;
      default:
        audio = audios[last];
    }
    // 唯一的性能改动：从 baseUrl + backupUrl 里挑最快的 CDN，而不是死用 baseUrl。
    url = pickBestURL(audio.baseUrl, audio.backupUrl || audio.backup_url);
  } else if (data.durl && data.durl[0]) {
    url = pickBestURL(data.durl[0].url, data.durl[0].backup_url || data.durl[0].backupUrl);
  }
  if (!url) throw new Error('获取播放地址：这个视频没有可用音轨');

  const finalURL = secure(url);
  const media = {
    url: finalURL,
    headers: {
      'user-agent': MEDIA_UA,
      accept: '*/*',
      host: hostOf(finalURL),
      'accept-encoding': 'gzip, deflate, br',
      connection: 'keep-alive',
      referer: 'https://www.bilibili.com/video/' + (ids.bvid || ids.aid || '')
    }
  };
  playurlCache[cacheKey] = { at: Date.now(), url: media.url, headers: media.headers };
  return media;
}

// ============================ 分 P ============================

async function getAlbumInfo(albumItem) {
  const ids = videoIds(albumItem);
  const pages = await getPages(ids.bvid, ids.aid);
  if (!pages.length) {
    return { musicList: [albumItem] };
  }
  if (pages.length === 1) {
    return { musicList: [Object.assign({}, albumItem, { cid: pages[0].cid })] };
  }
  return {
    musicList: pages.map(function (page) {
      return Object.assign({}, albumItem, {
        cid: page.cid,
        title: page.part,
        duration: durationToSec(page.duration),
        id: page.cid
      });
    })
  };
}

// ============================ 榜单 ============================

async function getTopLists() {
  const weekly = { title: '每周必看', data: [] };
  try {
    const payload = await plainGet('/x/web-interface/popular/series/list', {}, {
      cookie: true,
      what: '获取每周必看'
    });
    const list = (payload.data && payload.data.list) || [];
    weekly.data = list.slice(0, 8).map(function (item) {
      return {
        id: 'popular/series/one?number=' + item.number,
        title: item.subject,
        description: item.name,
        coverImg: 'https://s1.hdslb.com/bfs/static/jinkela/popular/assets/icon_weekly.png'
      };
    });
  } catch (e) {
    /* 每周必看拉不到时留空分组，不影响其他分组 */
  }

  const precious = {
    title: '入站必刷',
    data: [
      {
        id: 'popular/precious?page_size=100&page=1',
        title: '入站必刷',
        coverImg: 'https://s1.hdslb.com/bfs/static/jinkela/popular/assets/icon_history.png'
      }
    ]
  };

  const boardKeys = [
    { id: 'ranking/v2?rid=0&type=all', title: '全站' },
    { id: 'ranking/v2?rid=3&type=all', title: '音乐' },
    { id: 'ranking/v2?rid=1&type=all', title: '动画' },
    { id: 'ranking/v2?rid=119&type=all', title: '鬼畜' },
    { id: 'ranking/v2?rid=168&type=all', title: '国创相关' },
    { id: 'ranking/v2?rid=129&type=all', title: '舞蹈' },
    { id: 'ranking/v2?rid=4&type=all', title: '游戏' },
    { id: 'ranking/v2?rid=36&type=all', title: '知识' },
    { id: 'ranking/v2?rid=188&type=all', title: '科技' },
    { id: 'ranking/v2?rid=234&type=all', title: '运动' },
    { id: 'ranking/v2?rid=223&type=all', title: '汽车' },
    { id: 'ranking/v2?rid=160&type=all', title: '生活' },
    { id: 'ranking/v2?rid=211&type=all', title: '美食' },
    { id: 'ranking/v2?rid=217&type=all', title: '动物圈' },
    { id: 'ranking/v2?rid=155&type=all', title: '时尚' },
    { id: 'ranking/v2?rid=5&type=all', title: '娱乐' },
    { id: 'ranking/v2?rid=181&type=all', title: '影视' },
    { id: 'ranking/v2?rid=0&type=origin', title: '原创' },
    { id: 'ranking/v2?rid=0&type=rookie', title: '新人' }
  ];
  const board = {
    title: '排行榜',
    data: boardKeys.map(function (item) {
      return Object.assign({}, item, {
        coverImg: 'https://s1.hdslb.com/bfs/static/jinkela/popular/assets/icon_rank.png'
      });
    })
  };

  return [weekly, precious, board];
}

async function getTopListDetail(topListItem) {
  const payload = await plainGet('/x/web-interface/' + topListItem.id, {}, {
    cookie: true,
    headers: { referer: 'https://www.bilibili.com/' },
    what: '获取榜单内容'
  });
  const list = (payload.data && payload.data.list) || [];
  return Object.assign({}, topListItem, { musicList: list.map(formatMedia) });
}

// ============================ 收藏夹导入 ============================

async function getFavoriteList(id) {
  const result = [];
  let page = 1;
  while (page <= 50) {
    const payload = await plainGet('/x/v3/fav/resource/list', {
      media_id: id,
      platform: 'web',
      ps: 20,
      pn: page
    }, { what: '获取收藏夹' });
    const data = payload.data || {};
    const medias = Array.isArray(data.medias) ? data.medias : [];
    result.push.apply(result, medias);
    if (!data.has_more || !medias.length) break;
    page += 1;
  }
  return result;
}

function extractFavId(urlLike) {
  const text = String(urlLike || '');
  let match = text.match(/^\s*(\d+)\s*$/);
  if (match) return match[1];
  match = text.match(/[?&]fid=(\d+)/);
  if (match) return match[1];
  match = text.match(/\/playlist\/pl(\d+)/i);
  if (match) return match[1];
  match = text.match(/\/medialist\/detail\/ml(\d+)/i);
  if (match) return match[1];
  match = text.match(/\/list\/ml(\d+)/i);
  if (match) return match[1];
  return null;
}

async function importMusicSheet(urlLike) {
  const id = extractFavId(urlLike);
  if (!id) throw new Error('没能从链接里识别收藏夹 ID，可以只粘贴数字 ID');
  const medias = await getFavoriteList(id);
  if (!medias.length) throw new Error('收藏夹是空的，或者不是公开收藏夹');
  return medias.map(function (media) {
    return {
      id: media.id,
      aid: media.aid,
      bvid: media.bvid,
      artwork: secure(media.cover),
      title: media.title,
      artist: media.upper && media.upper.name,
      album: media.bvid || media.aid,
      duration: durationToSec(media.duration)
    };
  });
}

// ============================ 评论 ============================

function formatComment(item) {
  const location = item.reply_control && item.reply_control.location;
  return {
    id: item.rpid,
    nickName: item.member && item.member.uname,
    avatar: secure(item.member && item.member.avatar),
    comment: item.content && item.content.message,
    like: item.like,
    createAt: item.ctime * 1000,
    location: location && location.startsWith('IP属地：') ? location.slice(5) : undefined
  };
}

/** 协议只给 page，翻页靠上一页的 next_offset，按视频缓存。
 *  注意：未登录时 B 站只返回 3 条热门评论且 is_end=true，翻页拿不到更多，
 *  要完整评论得在请求里带 SESSDATA。 */
const commentOffsets = {};

async function getMusicComments(musicItem, page) {
  const oid = musicItem.aid;
  if (!oid) throw new Error('获取评论：缺少视频 aid');
  const current = page && page > 0 ? page : 1;

  let offset = '';
  if (current > 1) {
    offset = commentOffsets[oid] || '';
    if (!offset) return { isEnd: true, data: [] };
  }

  const payload = await signedGet('/x/v2/reply/wbi/main', {
    type: 1,
    oid: oid,
    mode: 3,
    plat: 1,
    web_location: 1315875,
    pagination_str: JSON.stringify({ offset: offset })
  }, {
    // 关键：这个接口不能带 buvid/bili_ticket cookie。
    // 实测同一条视频，无 cookie 返回 19 条主楼且 is_end=false（可翻页）；
    // 带上设备 cookie 反而被当成未登录设备，只给 3 条并把 is_end 设成 true。
    cookie: false,
    what: '获取评论'
  });

  const data = payload.data || {};
  const cursor = data.cursor || {};
  const next = cursor.pagination_reply && cursor.pagination_reply.next_offset;
  if (next) commentOffsets[oid] = next;
  else delete commentOffsets[oid];

  const list = Array.isArray(data.replies) ? data.replies : [];
  const comments = list.map(function (item) {
    const formatted = formatComment(item);
    if (Array.isArray(item.replies) && item.replies.length) {
      formatted.replies = item.replies.map(formatComment);
    }
    return formatted;
  });
  return { isEnd: !next || !comments.length, data: comments };
}

// ============================ 导出 ============================

module.exports = {
  platform: PLATFORM,
  version: '0.4.3',
  author: '猫头猫 / 听屿',
  srcUrl: PLUGIN_SRC_URL,
  cacheControl: 'no-cache',
  primaryKey: ['id', 'aid', 'bvid', 'cid'],
  supportedSearchType: ['music', 'album', 'artist'],
  hints: {
    importMusicSheet: [
      'bilibili 移动端：APP点击我的，空间，右上角分享，复制链接，浏览器打开切换桌面版网站，点击播放全部视频，复制链接',
      'bilibili H5/PC端：复制收藏夹URL，或者直接输入ID即可',
      '非公开收藏夹无法导入，编辑收藏夹改为公开即可',
      '导入时间和歌单大小有关，请耐心等待'
    ]
  },
  search: async function (keyword, page, type) {
    if (type === 'artist') return await searchArtist(keyword, page);
    return await searchAlbum(keyword, page);
  },
  getMediaSource: getMediaSource,
  getAlbumInfo: getAlbumInfo,
  getArtistWorks: getArtistWorks,
  getTopLists: getTopLists,
  getTopListDetail: getTopListDetail,
  importMusicSheet: importMusicSheet,
  getMusicComments: getMusicComments
};
