/**
 * @name 听屿 · 网易云
 * @description 走自建网易云 API（wyy.goku.top），不需要登录 Cookie
 * @author 听屿
 * @version 1.0.0
 * @srcUrl https://wyy.goku.top/plugin/tingyu-netease.js
 */

// MusicFree 插件运行在 JS 沙箱里，axios 由宿主注入。
const axios = require('axios');

const PLATFORM = '听屿·网易云';
const DEFAULT_BASE = 'https://wyy.goku.top';
const PAGE_SIZE = 30;

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

/** 统一的 GET，把 code !== 200 当成错误抛出去，避免界面拿到空数据以为成功。 */
async function api(path, params) {
  const url = apiBase() + path;
  let res;
  try {
    res = await axios.get(url, {
      params: params || {},
      headers: NET_EASE_HEADERS,
      timeout: 15000
    });
  } catch (e) {
    const status = e && e.response && e.response.status;
    throw new Error(status ? `接口返回 HTTP ${status}` : `接口请求失败：${e.message}`);
  }
  const data = res.data;
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
  return /(^https?:\/\/)?[^/]*\.(music\.)?126\.net/i.test(url) ? url.replace(/^http:/i, 'https:') : url;
}

function artistNames(song) {
  const list = song.ar || song.artists || [];
  if (Array.isArray(list) && list.length) {
    return list.map((a) => a && a.name).filter(Boolean).join(', ') || '未知歌手';
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
  let data = await api('/song/url/v1', { id: String(id), level });
  let item = data.data && data.data[0];
  // 匿名会话有时第一下拿不到地址，隔一下重试一次再判死
  if (!item || !item.url) {
    await new Promise((resolve) => setTimeout(resolve, 600));
    data = await api('/song/url/v1', { id: String(id), level });
    item = data.data && data.data[0];
  }
  if (!item || !item.url) {
    if (item && item.code === 404) throw new Error('这首歌在网易云没有版权，换一首试试');
    if (item && item.fee === 1) throw new Error('这首歌需要会员权限，当前接口拿不到播放地址');
    throw new Error('没有拿到播放地址');
  }
  return { url: secure(item.url), headers: NET_EASE_HEADERS };
}

async function getLyric(musicItem) {
  const id = musicItem._songId || musicItem.id;
  if (!id) return null;
  try {
    const data = await api('/lyric', { id: String(id) });
    const rawLrc = (data.lrc && data.lrc.lyric) || '';
    if (!rawLrc.trim()) return null;
    return { rawLrc, translation: (data.tlyric && data.tlyric.lyric) || '' };
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
  return items;
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
    offset: (currentPage - 1) * PAGE_SIZE
  });
  const items = (data.playlists || []).map(toSheet).filter(Boolean);
  return { isEnd: !data.more || items.length < PAGE_SIZE, data: items };
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

module.exports = {
  platform: PLATFORM,
  version: '1.0.0',
  author: '听屿',
  srcUrl: 'https://wyy.goku.top/plugin/tingyu-netease.js',
  cacheControl: 'no-cache',
  primaryKey: ['id', '_songId'],
  supportedSearchType: ['music', 'album', 'artist', 'sheet', 'lyric'],
  supportedArtistWorkTypes: ['music', 'album'],
  defaultSearchType: 'music',
  hints: {
    importMusicItem: ['支持网易云歌曲链接或 ID'],
    importMusicSheet: ['支持网易云歌单链接、短链或整段分享文案']
  },
  userVariables: [
    {
      key: 'apiBase',
      name: 'API 地址',
      hint: '默认 https://wyy.goku.top，换自建部署时改这里'
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
  getMusicComments
};
