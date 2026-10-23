/**
 * @name 听屿 · 网易云
 * @description 走自建网易云 API；填了登录 Cookie 后可用每日推荐
 * @author 听屿
 * @version 1.1.10
 * @srcUrl 见模块导出
 */

// MusicFree 插件运行在 JS 沙箱里，axios 由宿主注入。
const axios = require('axios');

const PLATFORM = '听屿·网易云';
// 默认接口地址按字符拼出来，源码里不出现明文域名
const DEFAULT_BASE = (() => {
  const codes = [104, 116, 116, 112, 115, 58, 47, 47, 119, 121, 121, 46, 103, 111, 107, 117, 46, 116, 111, 112];
  let out = '';
  for (let i = 0; i < codes.length; i += 1) out += String.fromCharCode(codes[i]);
  return out;
})();
const PLUGIN_SRC_URL = [
  'https://raw.githubusercontent.com',
  'sgr997',
  'tingyu-plugins',
  'main/tingyu/tingyu-netease.js'
].join('/');
const PAGE_SIZE = 30;

/** Cloudflare Access 服务令牌，让插件绕过浏览器那套邮箱验证。 */
function accessCredentials() {
  try {
    if (typeof env !== 'undefined' && env.userVariables) {
      const id = String(env.userVariables.cfClientId || '').trim();
      const secret = String(env.userVariables.cfClientSecret || '').trim();
      if (id && secret) return { id, secret };
    }
  } catch (e) {
    /* env 不存在时当没配 */
  }
  return null;
}

/** 接口 Token，用户在插件设置里填一次，存在宿主 Keychain 里。 */
function apiToken() {
  try {
    if (typeof env !== 'undefined' && env.userVariables && env.userVariables.token) {
      return String(env.userVariables.token).trim();
    }
  } catch (e) {
    /* env 不存在时当没配 */
  }
  return '';
}

/** 用户可以在插件设置里把 apiBase 指到自己的部署。 */
function apiBase() {
  try {
    if (typeof env !== 'undefined' && env.userVariables && env.userVariables.apiBase) {
      return String(env.userVariables.apiBase).trim().replace(/\/+$/, '');
    }
  } catch (e) {
    /* env 不存在时用默认值 */
  }
  return DEFAULT_BASE;
}

const NET_EASE_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
  Referer: 'https://music.163.com/'
};

/** 请求地址由 apiBase 配置决定，局域网切换交给 Loon。Cookie 不走 header：网关只认 ?cookie= query 参数。 */
function requestHeaders() {
  const headers = { ...NET_EASE_HEADERS };
  const token = apiToken();
  if (token) headers['X-Api-Token'] = token;
  const access = accessCredentials();
  if (access) {
    headers['CF-Access-Client-Id'] = access.id;
    headers['CF-Access-Client-Secret'] = access.secret;
  }
  return headers;
}

async function requestApi(path, params, timeout, cookie) {
  // 登录态必须走 ?cookie= query：网关（本地与线上）都不解析 Cookie 请求头
  const query = Object.assign({}, params || {});
  if (cookie) query.cookie = cookie;
  return axios.get(apiBase() + path, {
    params: query,
    headers: requestHeaders(),
    timeout: timeout || 15000
  });
}

/** 全部接口默认带登录态（用户拍板：搜索积累偏好，其他带着也无害）；
 *  仅扫码三步不带（登录流程本身不需要登录态）。
 *  显式传参永远优先：传具体 Cookie 用它，传 null 强制不带。 */

function defaultCookieFor(path) {
  if (path.indexOf('/login/qr/') === 0) return undefined;
  return cookieHeader() || undefined;
}

/**
 * 统一的 GET，把 code !== 200 当成错误抛出去，避免界面拿到空数据以为成功。
 * 登录二维码轮询用 code 800/801/802 表达状态，走 apiRaw（见下）。
 */
async function api(path, params, timeout, cookie) {
  let res;
  try {
    res = await requestApi(path, params, timeout, cookie !== undefined ? cookie : defaultCookieFor(path));
  } catch (e) {
    const status = e && e.response && e.response.status;
    if (status === 401) {
      throw new Error(apiToken() ? 'API Token 不对，去插件设置里改一下' : '这个接口需要 API Token，去插件设置里填');
    }
    throw new Error(status ? `接口返回 HTTP ${status}` : `接口请求失败：${e.message}`);
  }
  const data = res.data;
  if (typeof data === 'string' || (res.headers && String(res.headers['content-type'] || '').includes('text/html'))) {
    throw new Error(accessCredentials()
      ? '接口被 Cloudflare Access 拒绝了，检查插件的 Access 令牌'
      : '接口在 Cloudflare Access 后面，插件里要填 Access 客户端 ID 和密钥');
  }
  if (!data || typeof data !== 'object') throw new Error('接口返回的不是 JSON');
  if (data.code !== undefined && data.code !== 200) {
    throw new Error(`接口返回 code=${data.code}${data.message ? `（${data.message}）` : ''}`);
  }
  return data;
}

// ============================ 字段整理 ============================

/**
 * 网易云的播放地址和封面都爱给 http，App 开了 ATS（不允许明文 HTTP），
 * AVPlayer 会直接报 -1022。这些 CDN 都支持 https，统一升上去。
 */
function secure(url) {
  if (typeof url !== 'string') return '';
  if (!/^http:\/\//i.test(url)) return url;
  // 只动网易云自己的域，别的外链保持原样，免得把不支持的地址改坏
  return /(^https?:\/\/)?[^/]*\.((music\.)?126\.net|kuwo\.cn|kugou\.com|migu\.cn|qq\.com)/i.test(url)
    ? url.replace(/^http:/i, 'https:')
    : url;
}

function artistNames(song) {
  const list = song.ar || song.artists || [];
  if (Array.isArray(list) && list.length) {
    const names = list.map((a) => a && a.name).filter(Boolean);
    if (names.length) return names.join(', ');
    // 云盘/自传歌曲 name 为空但 alias 有名（["Jay Chou", "周董"]），别直接判未知
    const aliases = list.flatMap((a) => (a && a.alias) || []).filter(Boolean);
    if (aliases.length) return aliases.join(', ');
  }
  if (typeof song.artist === 'string' && song.artist) return song.artist;
  if (song.artist && song.artist.name) return song.artist.name;
  return '未知歌手';
}

function albumOf(song) {
  return song.al || song.album || {};
}

/** 插件给 App 的统一歌曲结构，字段沿用 MusicFree 约定。 */
function toSong(song) {
  if (!song || song.id === undefined) return null;
  const album = albumOf(song);
  const id = String(song.id);
  return {
    platform: PLATFORM,
    id,
    title: song.name || '',
    artist: artistNames(song),
    album: album.name || '未知专辑',
    artwork: secure(album.picUrl || album.picUrl_str || song.picUrl || ''),
    duration: song.dt || song.duration || 0,
    qualities: {
      low: { size: (song.l && song.l.size) || 0 },
      standard: { size: (song.m && song.m.size) || 0 },
      high: { size: (song.h && song.h.size) || 0 },
      super: { size: (song.sq && song.sq.size) || 0 }
    },
    _songId: id,
    _albumId: album.id ? String(album.id) : '',
    _fee: song.fee === undefined ? 0 : song.fee
  };
}

function toSheet(playlist) {
  if (!playlist || playlist.id === undefined) return null;
  return {
    platform: PLATFORM,
    id: String(playlist.id),
    title: playlist.name || '',
    artist: (playlist.creator && playlist.creator.nickname) || '网易云音乐',
    artwork: secure(playlist.coverImgUrl || ''),
    description: playlist.description || '',
    trackCount: playlist.trackCount || 0,
    playCount: playlist.playCount || 0,
    _playlistId: String(playlist.id),
    _type: 'playlist'
  };
}

function toAlbum(album) {
  if (!album || album.id === undefined) return null;
  return {
    platform: PLATFORM,
    id: String(album.id),
    title: album.name || '',
    artist: artistNames(album),
    artwork: secure(album.picUrl || ''),
    description: album.description || '',
    _albumId: String(album.id),
    _type: 'album'
  };
}

function toArtist(artist) {
  if (!artist || artist.id === undefined) return null;
  return {
    platform: PLATFORM,
    id: String(artist.id),
    title: artist.name || '',
    name: artist.name || '',
    artist: artist.name || '',
    avatar: secure(artist.picUrl || artist.img1v1Url || ''),
    artwork: secure(artist.picUrl || artist.img1v1Url || ''),
    description: artist.briefDesc || '',
    worksNum: artist.albumSize || 0,
    _artistId: String(artist.id),
    _type: 'artist'
  };
}

// ============================ 搜索 ============================

const SEARCH_TYPE = { music: 1, lyric: 1, album: 10, artist: 100, sheet: 1000 };

async function search(query, page, type) {
  const keyword = String(query || '').trim();
  if (!keyword) return { isEnd: true, data: [] };
  const currentPage = page && page > 0 ? page : 1;
  const data = await api('/search', {
    keywords: keyword,
    type: SEARCH_TYPE[type] || 1,
    limit: PAGE_SIZE,
    offset: (currentPage - 1) * PAGE_SIZE
  });
  const result = data.result || {};
  let items = [];
  if (type === 'album') items = (result.albums || []).map(toAlbum).filter(Boolean);
  else if (type === 'artist') items = (result.artists || []).map(toArtist).filter(Boolean);
  else if (type === 'sheet') items = (result.playlists || []).map(toSheet).filter(Boolean);
  else items = (result.songs || []).map(toSong).filter(Boolean);
  return { isEnd: items.length < PAGE_SIZE, data: items };
}

// ============================ 播放链接 / 歌词 ============================

const QUALITY_LEVEL = {
  low: 'standard',
  standard: 'higher',
  high: 'exhigh',
  super: 'lossless'
};

async function getMediaSource(musicItem, quality) {
  const id = musicItem._songId || musicItem.id;
  if (!id) throw new Error('歌曲 ID 缺失');
  const level = QUALITY_LEVEL[quality] || 'exhigh';

  // 第一步：官方地址。正常歌曲这里就结束了，约 0.4 秒。
  let trialUrl = '';
  try {
    const data = await api('/song/url/v1', { id: String(id), level });
    const item = data.data && data.data[0];
    if (item && item.url && !item.freeTrialInfo) return { url: secure(item.url), headers: NET_EASE_HEADERS };
    if (item && item.url) trialUrl = item.url;
  } catch (e) {
    // 接口报错也继续往下试去灰
  }

  // 第二步：试听片段或没有版权，调去灰接口换其它平台的完整音源（3~15 秒）
  try {
    const matched = await api('/song/url/match', { id: String(id) }, 30000);
    const url = typeof matched.data === 'string' ? matched.data : matched.data && matched.data.url;
    if (url) return { url: secure(url), headers: NET_EASE_HEADERS };
    // 去灰也没拿到整首。不能把试听片段当完整音源悄悄交出去：
    // 打上 preview 标记，宿主据此提示用户，也不会把它写进播放缓存。
  } catch (e) {
    // 去灰也失败，退回试听（如果有）
  }

  if (trialUrl) return { url: secure(trialUrl), headers: NET_EASE_HEADERS, preview: true };
  throw new Error('这首歌拿不到音源');
}

async function getLyric(musicItem) {
  const id = musicItem._songId || musicItem.id;
  if (!id) return null;
  try {
    const data = await api('/lyric', { id: String(id) });
    const rawLrc = (data.lrc && data.lrc.lyric) || '';
    // uncollected 的灰歌（如周杰伦）网易连歌词一起锁，走 lrclib 兜底
    if (!rawLrc.trim() || data.uncollected || /^(\[[^\]]*\]\s*)*暂无歌词\s*$/.test(rawLrc.trim())) {
      const fallback = await lrclibLyric(musicItem);
      if (fallback) return fallback;
    }
    if (!rawLrc.trim()) return null;
    return { rawLrc, translation: (data.tlyric && data.tlyric.lyric) || '' };
  } catch (e) {
    const fallback = await lrclibLyric(musicItem);
    return fallback || null;
  }
}

/** lrclib.net 免费歌词库兜底：按歌名+歌手搜，取时长匹配且有同步歌词的第一条。 */
async function lrclibLyric(musicItem) {
  try {
    const title = String(musicItem.title || '').trim();
    const artist = String(musicItem.artist || '').split(/[\/,，]/)[0].trim();
    if (!title || !artist) return null;
    // 网易的 duration 是毫秒，lrclib 是秒
    const rawDur = Number(musicItem.duration) || 0;
    const dur = rawDur > 10000 ? Math.round(rawDur / 1000) : rawDur;
    const res = await axios.get('https://lrclib.net/api/search', {
      params: { track_name: title, artist_name: artist },
      timeout: 10000,
      headers: { 'User-Agent': 'TingYu/1.0 (https://github.com/sgr997/tingyu-plugins)' }
    });
    const hits = Array.isArray(res.data) ? res.data : [];
    const pick = hits.find((r) => r.syncedLyrics && dur > 0 && Math.abs((r.duration || 0) - dur) <= 2)
      || hits.find((r) => r.syncedLyrics)
      || hits.find((r) => r.plainLyrics && dur > 0 && Math.abs((r.duration || 0) - dur) <= 2);
    if (!pick || !pick.syncedLyrics) return null;
    return { rawLrc: String(pick.syncedLyrics), translation: '' };
  } catch (e) {
    return null;
  }
}

async function getMusicInfo(musicItem) {
  const id = musicItem._songId || musicItem.id;
  if (!id) return musicItem;
  const data = await api('/song/detail', { ids: String(id) });
  const song = (data.songs || [])[0];
  const formatted = toSong(song);
  return formatted ? { ...musicItem, ...formatted } : musicItem;
}

// ============================ 链接导入 ============================

/**
 * 把用户粘的东西变成可以直接查的链接：
 * 支持纯 ID、普通链接、163cn.tv 短链，以及「分享歌单: xxx https://… (@网易云音乐)」这种整段文案。
 */
async function resolveInput(text) {
  const raw = String(text || '').trim();
  if (/^\d{4,}$/.test(raw)) return raw;
  const match = raw.match(/https?:\/\/[^\s"'）)】]+/);
  const url = match ? match[0] : raw;
  const looksShort = /163cn\.(tv|cn)/i.test(url);
  if (!looksShort) return url;
  try {
    const res = await axios.get(url, {
      maxRedirects: 5,
      timeout: 15000,
      headers: NET_EASE_HEADERS
    });
    const finalUrl =
      (res.request && res.request.res && res.request.res.responseUrl) ||
      (res.config && res.config.url) ||
      url;
    return finalUrl;
  } catch (e) {
    const redirected = e && e.request && e.request.res && e.request.res.responseUrl;
    if (redirected) return redirected;
    throw new Error('短链没能展开，可能已过期');
  }
}

function idFromText(text) {
  const raw = String(text || '');
  const query = raw.match(/[?&]id=(\d{4,})/);
  if (query) return query[1];
  const numeric = raw.match(/\d{4,}/g);
  if (!numeric) return null;
  return numeric.sort((a, b) => b.length - a.length)[0];
}

async function importMusicItem(urlLike) {
  const id = idFromText(await resolveInput(urlLike));
  if (!id) throw new Error('没能从这段内容里认出歌曲 ID');
  const data = await api('/song/detail', { ids: id });
  const song = toSong((data.songs || [])[0]);
  if (!song) throw new Error('没查到这首歌');
  return song;
}

async function importMusicSheet(urlLike) {
  const id = idFromText(await resolveInput(urlLike));
  if (!id) throw new Error('没能从这段内容里认出歌单 ID');
  const items = await fetchAllTracks(id, 1000);
  if (!items.length) throw new Error('这个歌单里没有歌');
  // 顺带把歌单名和封面带回去，宿主会把它们存进本地歌单。
  // 详情接口失败不该让整次导入失败，所以单独兜一层。
  let title = '';
  let coverImg = '';
  try {
    const detail = await api('/playlist/detail', { id: String(id) });
    const sheet = detail && detail.playlist;
    if (sheet) {
      title = sheet.name || '';
      coverImg = sheet.coverImgUrl || sheet.picUrl || '';
    }
  } catch (e) {
    title = '';
    coverImg = '';
  }
  return { title: title || '导入的歌单', coverImg, musicList: items };
}

async function fetchAllTracks(playlistId, limit) {
  const all = [];
  const size = 500;
  for (let offset = 0; offset < limit; offset += size) {
    const data = await api('/playlist/track/all', { id: String(playlistId), limit: size, offset });
    const songs = (data.songs || []).map(toSong).filter(Boolean);
    if (!songs.length) break;
    all.push(...songs);
    if (songs.length < size) break;
  }
  return all;
}

// ============================ 集合详情 ============================

async function getMusicSheetInfo(sheetItem, page) {
  const id = sheetItem._playlistId || sheetItem.id;
  if (!id) throw new Error('歌单 ID 缺失');
  const currentPage = page && page > 0 ? page : 1;
  const data = await api('/playlist/track/all', {
    id: String(id),
    limit: PAGE_SIZE,
    offset: (currentPage - 1) * PAGE_SIZE
  });
  const items = (data.songs || []).map(toSong).filter(Boolean);
  let sheet = {};
  if (currentPage === 1) {
    const detail = await api('/playlist/detail', { id: String(id) });
    sheet = toSheet(detail.playlist) || {};
  }
  return { isEnd: items.length < PAGE_SIZE, musicList: items, sheetItem: sheet };
}

async function getAlbumInfo(albumItem, page) {
  const id = albumItem._albumId || albumItem.id;
  if (!id) throw new Error('专辑 ID 缺失');
  const data = await api('/album', { id: String(id) });
  const items = (data.songs || []).map(toSong).filter(Boolean);
  return {
    isEnd: true,
    musicList: items,
    albumItem: toAlbum(data.album) || {}
  };
}

async function getArtistInfo(artistItem) {
  const id = artistItem._artistId || artistItem.id;
  if (!id) return artistItem;
  const data = await api('/artists', { id: String(id) });
  const artist = toArtist(data.artist);
  return artist ? { ...artistItem, ...artist } : artistItem;
}

async function getArtistWorks(artistItem, page, type) {
  const id = artistItem._artistId || artistItem.id;
  if (!id) throw new Error('歌手 ID 缺失');
  const currentPage = page && page > 0 ? page : 1;
  if (type === 'album') {
    const data = await api('/artist/album', {
      id: String(id),
      limit: PAGE_SIZE,
      offset: (currentPage - 1) * PAGE_SIZE
    });
    const items = (data.hotAlbums || []).map(toAlbum).filter(Boolean);
    return { isEnd: items.length < PAGE_SIZE, data: items };
  }
  // 歌曲只有一张“热门 50”，没有分页
  if (currentPage > 1) return { isEnd: true, data: [] };
  const data = await api('/artist/top/song', { id: String(id) });
  const items = (data.songs || []).map(toSong).filter(Boolean);
  return { isEnd: true, data: items };
}

// ============================ 榜单 ============================

async function getTopLists() {
  const data = await api('/toplist');
  const groups = [];
  const official = (data.list || []).map((item) => ({
    platform: PLATFORM,
    id: String(item.id),
    title: item.name || '',
    artwork: item.coverImgUrl || '',
    description: item.updateFrequency || '',
    _playlistId: String(item.id),
    _type: 'playlist'
  }));
  if (official.length) groups.push({ title: '官方榜', data: official });
  if (data.artistToplist && data.artistToplist.name) {
    groups.push({
      title: '歌手榜',
      data: [
        {
          platform: PLATFORM,
          id: 'artist-toplist',
          title: data.artistToplist.name,
          artwork: data.artistToplist.coverUrl || '',
          _playlistId: String(data.artistToplist.id || ''),
          _type: 'playlist'
        }
      ]
    });
  }
  return groups;
}

async function getTopListDetail(topListItem, page) {
  const id = topListItem._playlistId || topListItem.id;
  const currentPage = page && page > 0 ? page : 1;
  const data = await api('/playlist/track/all', {
    id: String(id),
    limit: PAGE_SIZE,
    offset: (currentPage - 1) * PAGE_SIZE
  });
  const items = (data.songs || []).map(toSong).filter(Boolean);
  return { isEnd: items.length < PAGE_SIZE, musicList: items, topListItem };
}

// ============================ 推荐歌单 ============================

const CHAPTER_NAMES = { 0: '语种', 1: '风格', 2: '场景', 3: '情感', 4: '主题' };

async function getRecommendSheetTags() {
  const data = await api('/playlist/catlist');
  const categories = data.categories || {};
  const buckets = {};
  (data.sub || []).forEach((tag) => {
    const key = String(tag.category);
    if (!buckets[key]) buckets[key] = { title: categories[key] || CHAPTER_NAMES[key] || '分类', data: [] };
    buckets[key].data.push({
      id: tag.name,
      title: tag.name,
      parent: categories[key] || '',
      resourceCount: tag.resourceCount || 0
    });
  });
  const pinned = [
    { id: '全部', title: '全部' },
    { id: '最新', title: '最新' }
  ];
  const groups = Object.keys(buckets)
    .sort((a, b) => Number(a) - Number(b))
    .map((key) => buckets[key]);
  return { pinned, data: groups };
}

/** 「最新」用精品歌单的时间游标翻页，游标按分类缓存，page 是插件协议里唯一的上下文。 */
const highQualityCursor = {};

async function getRecommendSheetsByTag(tag, page) {
  const currentPage = page && page > 0 ? page : 1;
  const category = (tag && (tag.id || tag.title)) || '全部';

  if (category === '最新') {
    const key = 'root';
    const before = currentPage > 1 ? highQualityCursor[key] : undefined;
    const data = await api('/top/playlist/highquality', {
      cat: '全部',
      limit: PAGE_SIZE,
      ...(before ? { before } : {})
    });
    const items = (data.playlists || []).map(toSheet).filter(Boolean);
    if (items.length) {
      highQualityCursor[key] = (data.playlists[data.playlists.length - 1] || {}).updateTime;
    }
    return { isEnd: !data.more || items.length < PAGE_SIZE, data: items };
  }

  const data = await api('/top/playlist', {
    cat: category,
    order: 'hot',
    limit: PAGE_SIZE,
    // 「全部」的第一页加随机起点：order=hot 按收藏量排，第 1 页基本永不变化，
    // 发现页会几天都是同一批歌单。会话内从随机页接着往下翻，用户选了具体分类时不随机。
    offset: (hotStartPage(category, currentPage) + currentPage - 2) * PAGE_SIZE
  });
  const items = (data.playlists || []).map(toSheet).filter(Boolean);
  return { isEnd: !data.more || items.length < PAGE_SIZE, data: items };
}

/** 「全部」分类的随机起始页：每次第 1 页请求重新抽 1~20，后续页沿用同一次的抽签。 */
let hotPlaylistStartPage = 0;
function hotStartPage(category, page) {
  if (category !== '全部') return 1;
  if (page === 1) {
    hotPlaylistStartPage = 1 + Math.floor(Math.random() * 20);
  }
  return hotPlaylistStartPage || 1;
}

// ============================ 心动模式（需登录） ============================

/** 「我喜欢的音乐」歌单 id 缓存：/playmode/intelligence/list 的 pid 只认它。 */
let heartbeatPidCache = null;

async function likedPlaylistId() {
  if (heartbeatPidCache) return heartbeatPidCache;
  const acc = await api('/user/account');
  const uid = acc && acc.profile && acc.profile.userId;
  if (!uid) throw new Error('登录已过期，重新扫码后再用心动模式');
  const res = await api('/user/playlist', { uid, limit: 5 });
  const liked = (res.playlist || []).find((p) => p.specialType === 5);
  if (!liked) throw new Error('没有找到「我喜欢的音乐」歌单，心动模式要用它做种子');
  heartbeatPidCache = liked.id;
  return liked.id;
}

/** 心动模式：种子歌在队首，后面接智能推荐。没传种子就从喜欢列表随机挑一首。 */
async function getHeartbeatSongs(musicItem) {
  if (!cookieHeader()) throw new Error('先扫码登录再用心动模式');
  const pid = await likedPlaylistId();

  let seed = musicItem && (musicItem._songId || musicItem.id) ? musicItem : null;
  if (!seed) {
    const likeRes = await api('/likelist');
    const ids = (likeRes.ids || []).filter((n) => typeof n === 'number' || /^\d+$/.test(String(n)));
    if (!ids.length) throw new Error('喜欢列表是空的，先收藏几首歌再用心动模式');
    const pickId = ids[Math.floor(Math.random() * ids.length)];
    const detail = await api('/song/detail', { ids: String(pickId) });
    const raw = ((detail.songs || [])[0]);
    seed = raw ? toSong(raw) : null;
  }
  const seedId = seed ? (seed._songId || seed.id) : null;
  if (!seedId) throw new Error('心动模式没找到种子歌');

  const res = await api('/playmode/intelligence/list', {
    id: String(seedId), pid: String(pid), sid: String(seedId), count: 30
  });
  const songs = (Array.isArray(res.data) ? res.data : (res.data && res.data.songs) || [])
    .map((entry) => entry && (entry.songInfo || entry))
    .map(toSong).filter(Boolean);
  if (!songs.length) throw new Error('心动模式没有拿到推荐歌曲');
  return { isEnd: true, data: [seed, ...songs] };
}

// ============================ 评论 ============================

function toComment(raw) {
  return {
    id: String(raw.commentId || ''),
    nickName: (raw.user && raw.user.nickname) || '匿名',
    avatar: (raw.user && raw.user.avatarUrl) || '',
    comment: raw.content || '',
    like: raw.likedCount || 0,
    createAt: raw.time || Date.now(),
    location: (raw.ipLocation && raw.ipLocation.location) || '',
    replies: (raw.beReplied || []).map((r) => ({
      id: String(r.commentId || ''),
      nickName: (r.user && r.user.nickname) || '匿名',
      avatar: (r.user && r.user.avatarUrl) || '',
      comment: r.content || '',
      like: 0,
      createAt: r.time || Date.now(),
      location: (r.ipLocation && r.ipLocation.location) || '',
      replies: []
    }))
  };
}

async function getMusicComments(musicItem, page) {
  const id = musicItem._songId || musicItem.id;
  const currentPage = page && page > 0 ? page : 1;
  const data = await api('/comment/music', {
    id: String(id),
    limit: PAGE_SIZE,
    offset: (currentPage - 1) * PAGE_SIZE
  });
  const normal = (data.comments || []).map(toComment);
  const hot = currentPage === 1 ? (data.hotComments || []).map(toComment) : [];
  return { isEnd: normal.length < PAGE_SIZE, data: [...hot, ...normal] };
}

/** 同 api()，但业务 code 由调用方判断（二维码轮询 800/801/802 不是错误）。 */
async function apiRaw(path, params, timeout, cookie) {
  let res;
  try {
    res = await requestApi(path, params, timeout, cookie !== undefined ? cookie : defaultCookieFor(path));
  } catch (e) {
    const status = e && e.response && e.response.status;
    throw new Error(status ? `接口返回 HTTP ${status}` : `接口请求失败：${e.message}`);
  }
  const data = res.data;
  if (typeof data === 'string' || (res.headers && String(res.headers['content-type'] || '').includes('text/html'))) {
    throw new Error('接口被 Cloudflare Access 拒绝了，检查插件的 Access 令牌');
  }
  if (!data || typeof data !== 'object') throw new Error('接口返回的不是 JSON');
  return data;
}

// ============================ 登录（插件登录规范） ============================

/** 登录 Cookie：用户从「账号登录」扫码拿到后一键填进变量，请求带它就有登录态。 */
function cookieHeader() {
  try {
    if (typeof env !== 'undefined' && env.userVariables && env.userVariables.cookie) {
      return String(env.userVariables.cookie).trim();
    }
  } catch (e) {
    /* env 不存在时当没登录 */
  }
  return '';
}

/** 扫码登录三步：key → 二维码 → 轮询状态。code 语义与网易云原生一致（800/801/802）。 */
async function createLoginQRCode() {
  const keyRes = await api('/login/qr/key', { timestamp: Date.now() });
  const key = keyRes && keyRes.data && keyRes.data.unikey;
  if (!key) throw new Error('接口没有返回二维码 key');
  const qrRes = await api('/login/qr/create', { key, qrimg: 1, timestamp: Date.now() });
  const data = (qrRes && qrRes.data) || {};
  // 优先给 base64 图（宿主直接当图片显示），没有就退回扫码 URL（宿主自己编码成二维码）
  const qrData = data.qrimg || data.qrurl;
  if (!qrData) throw new Error('接口没有返回二维码');
  return { key, qrData };
}

async function checkLoginQRCode(key) {
  const res = await apiRaw('/login/qr/check', { key, timestamp: Date.now() });
  // 状态码沿用网易云原生约定，宿主按同一套解释：
  // 800 二维码过期 / 801 等待扫码 / 802 已扫码待确认 / 803 授权成功。
  const code = res.code === undefined ? 801 : res.code;
  if (code === 803) {
    const raw = res.cookie || (res.data && res.data.cookie) || '';
    const items = Array.isArray(raw) ? raw : String(raw).split(';');
    // 服务端把整串 Set-Cookie 用分号拼起来了，可能夹带 Path/Domain 之类的属性，只留真正的键值对
    const skip = ['path', 'domain', 'expires', 'max-age', 'samesite', 'secure', 'httponly'];
    const pairs = items
      .map((item) => String(item).trim().split(';')[0].trim())
      .filter((item) => item.includes('='))
      .filter((item) => !skip.includes(item.split('=')[0].trim().toLowerCase()));
    const cookie = pairs.join('; ');
    if (!/(^|;\s*)MUSIC_U=/.test(cookie)) throw new Error('登录成功但接口没有返回有效凭据');
    return { code: 803, cookie };
  }
  return { code };
}

/** 登录续期：拿当前 Cookie 调 /login/refresh 换新 Cookie。
 * 成功返回 { code: 200, cookie }；code 301 = 网易判定已过期，只能重新扫码。
 * 续出来的 Cookie 由宿主写回插件变量（env.userVariables 对插件只读），
 * 插件自己改不了，所以这里只负责换、不负责存。 */
async function refreshLogin() {
  const cookie = cookieHeader();
  if (!cookie) throw new Error('还没有登录，先去「账号登录」扫码');
  const res = await apiRaw('/login/refresh', { timestamp: Date.now() });
  const body = (res && res.data) || res || {};
  const code = body.code;
  if (code !== 200) {
    throw new Error(code === 301 ? '登录已过期，重新扫码即可' : `续期失败：接口返回 code=${code}`);
  }
  const raw = res.cookie || body.cookie || '';
  const items = Array.isArray(raw) ? raw : String(raw).split(';');
  // 服务端把整串 Set-Cookie 用分号拼起来了，可能夹带 Path/Domain 之类的属性，只留真正的键值对
  const skip = ['path', 'domain', 'expires', 'max-age', 'samesite', 'secure', 'httponly'];
  const pairs = items
    .map((item) => String(item).trim().split(';')[0].trim())
    .filter((item) => item.includes('='))
    .filter((item) => !skip.includes(item.split('=')[0].trim().toLowerCase()));
  const refreshed = pairs.join('; ');
  if (!/(^|;\s*)MUSIC_U=/.test(refreshed)) throw new Error('续期成功但接口没有返回有效凭据');
  return { code: 200, cookie: refreshed };
}

async function loginStatus(cookie) {
  // 必须带登录 Cookie，否则接口只会返回未登录的空 profile
  const res = await api('/login/status', { timestamp: Date.now() }, 15000, cookie);
  const body = (res && res.data) || res || {};
  const profile = body.profile || (body.data && body.data.profile) || (res && res.profile);
  if (!profile) return { nickname: '', avatar: '' };
  return { nickname: profile.nickname || '', avatar: profile.avatarUrl || '' };
}

// ============================ 每日推荐（需登录） ============================

/** 每日推荐歌单：30 张按账号口味推荐。没登录（没 cookie）时抛错，宿主据此隐藏入口。 */
async function getRecommendWorks() {
  const cookie = cookieHeader();
  if (!cookie) throw new Error('先在插件设置里填登录 Cookie 才能用每日推荐');
  const res = await api('/recommend/resource');
  let list = (res && res.recommend && Array.isArray(res.recommend) ? res.recommend : [])
    .map((item) => {
      const sheet = item && item.platformRecommendationInfo && item.platformRecommendationInfo.songSheetRecommendation;
      const base = sheet || item;
      const pic = (base && base.picUrl) || (base && base.coverUrl) || '';
      return {
        id: String((base && (base.id !== undefined ? base.id : base.playlistId)) || ''),
        title: (base && (base.name || base.title)) || '推荐歌单',
        artist: '',
        album: '',
        cover: pic,
        sheet: { id: String((base && (base.id !== undefined ? base.id : base.playlistId)) || ''), platform: PLATFORM }
      };
    })
    .filter((item) => item.id);
  if (!list.length) throw new Error('今日没有推荐歌单（账号不满足条件或登录已过期）');
  // /recommend/resource 只回几张，首页一页三项时显得太薄，用 /personalized 补到 12 张。
  // /personalized 是固定热门榜，全量取永远同一批，这里拉 30 张随机抽样，横滑行隔天换一批。
  if (list.length < 9) {
    try {
      const extra = await api('/personalized', { limit: 30 });
      const seen = new Set(list.map((item) => item.id));
      const topUp = (Array.isArray(extra && extra.result) ? extra.result : [])
        .map((item) => ({
          id: String((item && item.id) || ''),
          title: (item && item.name) || '',
          artist: (item && item.copywriter) || '',
          album: '',
          cover: (item && item.picUrl) || '',
          sheet: { id: String((item && item.id) || ''), platform: PLATFORM }
        }))
        .filter((item) => item.id && item.title && !seen.has(item.id));
      for (let i = topUp.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = topUp[i];
        topUp[i] = topUp[j];
        topUp[j] = tmp;
      }
      list = list.concat(topUp);
    } catch (error) {
      // 补位失败不影响已有推荐
    }
  }
  return { isEnd: true, data: list };
}

/** 每日 30 首：按口味推荐的歌曲。 */
async function getDailySongs() {
  const cookie = cookieHeader();
  if (!cookie) throw new Error('先在插件设置里填登录 Cookie 才能用每日推荐');
  const res = await api('/recommend/songs');
  const raw = (res && res.data && Array.isArray(res.data.dailySongs)) ? res.data.dailySongs : [];
  const list = raw.map((song) => toSong(song));
  if (!list.length) throw new Error('今日没有推荐歌曲（账号不满足条件或登录已过期）');
  return { isEnd: true, data: list };
}

module.exports = {
  platform: PLATFORM,
  version: '1.1.10',
  author: '听屿',
  srcUrl: PLUGIN_SRC_URL,
  cacheControl: 'no-cache',
  primaryKey: ['id', '_songId'],
  supportedSearchType: ['music', 'album', 'artist', 'sheet', 'lyric'],
  supportedArtistWorkTypes: ['music', 'album'],
  defaultSearchType: 'music',
  hints: {
    importMusicItem: ['支持网易云歌曲链接或 ID'],
    importMusicSheet: ['支持网易云歌单链接、短链或整段分享文案']
  },
  login: {
    sessionCookieKey: 'MUSIC_U',
    sessionTTL: 30,
    preferredVariableKey: 'cookie'
  },
  userVariables: [
    {
      key: 'cookie',
      name: '登录 Cookie',
      type: 'password',
      hint: '从「账号登录」扫码后一键填入',
      description: '填了才有每日推荐和按口味推荐歌单；在「我的 → 账号登录」扫码获取'
    },
    {
      key: 'token',
      name: 'API Token',
      type: 'password',
      required: true,
      hint: '接口访问令牌',
      description: '自建接口开了认证，必须填写才能搜索和播放'
    },
    {
      key: 'cfClientId',
      name: 'Access Client ID',
      type: 'password',
      hint: 'Cloudflare Access 服务令牌 ID',
      description: '接口在 Access 后面，插件靠服务令牌免邮箱验证'
    },
    {
      key: 'cfClientSecret',
      name: 'Access Client Secret',
      type: 'password',
      hint: 'Cloudflare Access 服务令牌密钥'
    },
    {
      key: 'apiBase',
      name: 'API 地址',
      hint: '默认走作者的公开部署，换自建部署时改这里'
    }
  ],
  search,
  getMediaSource,
  getLyric,
  getMusicInfo,
  importMusicItem,
  importMusicSheet,
  getMusicSheetInfo,
  getAlbumInfo,
  getArtistInfo,
  getArtistWorks,
  getTopLists,
  getTopListDetail,
  getRecommendSheetTags,
  getRecommendSheetsByTag,
  getMusicComments,
  createLoginQRCode,
  checkLoginQRCode,
  loginStatus,
  refreshLogin,
  getRecommendWorks,
  getDailySongs,
  getHeartbeatSongs
};
