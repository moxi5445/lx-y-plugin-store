/*
 * @id qishui-music
 * @version 1.0.0
 * @apiVersion 1
 * @name 汽水音乐
 * @description 接入汽水音乐音源：歌单广场、歌单详情、歌词、封面与试听播放；配置自建 qishui-api 服务后支持关键词搜索。直连模式下播放为约 30 秒试听片段（官方 H5 接口限制），仅供个人学习使用。
 * @icon 🥤
 * @author lx-x
 */

/**
 * 能力说明：
 *  - 直连模式（默认，零配置）：
 *      歌单广场 / 歌单详情 / 歌词 / 封面 / 30 秒试听均可直接访问 beta-luna H5 接口；
 *      搜索接口被官方风控拦截（需要 X-Helios / X-Medusa 签名），直连模式不可用。
 *  - 自建服务模式：
 *      部署参考项目 qishui-api（Node.js），在下方填写服务地址（需与手机同一网络），
 *      即可通过服务端签名使用关键词搜索与歌单搜索；播放仍走 H5 试听地址。
 *
 * 本插件运行在 WebView 沙箱中，所有网络请求均经宿主 api.network 代理。
 */
(function () {
  'use strict'

  var LUNA_HOST = 'https://beta-luna.douyin.com'
  var PC_HOST = 'https://api.qishui.com'
  var WEB_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
  var APP_UA = 'Luna/19.1.0 Android'
  var SEO_CACHE_TTL = 10 * 60 * 1000
  var SQUARE_PAGE_SIZE = 30
  var DETAIL_PAGE_SIZE = 20

  window.__LX_PLUGIN__.register({
    settingsSchema: [
      {
        key: 'mode',
        type: 'select',
        title: '接入模式',
        description: '直连：免配置，可用歌单/歌词/试听；自建服务：额外支持搜索',
        default: 'direct',
        options: [
          { label: '直连模式（免配置）', value: 'direct' },
          { label: '自建 qishui-api 服务', value: 'server' }
        ]
      },
      {
        key: 'apiBase',
        type: 'input',
        title: '自建服务地址',
        description: 'qishui-api 服务地址，不带末尾斜杠，如 http://192.168.1.10:3300；仅自建服务模式生效',
        placeholder: 'http://192.168.1.10:3300'
      },
      {
        key: 'xHelios',
        type: 'input',
        title: 'X-Helios 签名（可选）',
        description: '直连模式下尝试 PC 搜索接口的签名头，一般用户无需填写',
        placeholder: ''
      },
      {
        key: 'xMedusa',
        type: 'input',
        title: 'X-Medusa 签名（可选）',
        description: '直连模式下尝试 PC 搜索接口的签名头，一般用户无需填写',
        placeholder: ''
      },
      {
        key: 'previewHint',
        type: 'switch',
        title: '试听提示',
        description: '播放时提示当前为汽水音乐 30 秒试听片段',
        default: true
      }
    ],

    activate: function (api) {
      var seoCache = Object.create(null)
      // 官方歌单接口基于游标分页：保存第 N 页请求所需的 cursor
      var squareCursors = ['']
      var detailCursors = Object.create(null)
      var lastHintAt = 0

      function setting(key, fallback) {
        return api.setting.get(key, fallback)
      }

      function isServerMode() {
        return setting('mode', 'direct') === 'server'
      }

      function apiBase() {
        return String(setting('apiBase', '') || '').replace(/\/+$/, '')
      }

      function http(url, options) {
        return api.network.request(url, options || {}).then(function (res) {
          if (!res || res.status < 200 || res.status >= 300) {
            throw new Error('网络请求失败：HTTP ' + (res ? res.status : '0'))
          }
          return res.body
        })
      }

      function postJson(url, body, ua) {
        return http(url, {
          method: 'POST',
          headers: {
            'User-Agent': ua || APP_UA,
            'Content-Type': 'application/json'
          },
          data: body,
          timeout: 20000
        })
      }

      // ---- 通用字段提取 ----

      function pickUrl(value) {
        if (!value) return ''
        if (typeof value === 'string') return value
        if (Array.isArray(value)) {
          for (var i = 0; i < value.length; i++) {
            var u = pickUrl(value[i])
            if (u) return u
          }
          return ''
        }
        if (Array.isArray(value.urls) && value.urls.length) return String(value.urls[0] || '') + (value.uri || '')
        return value.url || value.uri || value.template || ''
      }

      function artistNames(track) {
        if (!track) return ''
        if (Array.isArray(track.artists)) {
          return track.artists.map(function (a) {
            if (!a) return ''
            return a.name || (a.user_info && a.user_info.nickname) || a.simple_display_name || ''
          }).filter(Boolean).join('、')
        }
        if (track.user_info && track.user_info.nickname) return track.user_info.nickname
        return track.singer || ''
      }

      function coverOf(track) {
        if (!track) return ''
        var album = track.album || {}
        return pickUrl(album.url_cover || album.cover_url || album.coverURL || track.cover_url || track.url_cover)
      }

      function toSeconds(duration) {
        var n = Number(duration)
        if (!isFinite(n) || n <= 0) return 0
        return n > 100000 ? Math.round(n / 1000) : Math.round(n)
      }

      function mapTrack(track) {
        if (!track || !track.id) return null
        return {
          songmid: String(track.id),
          name: String(track.name || track.trackName || ''),
          singer: artistNames(track),
          albumName: track.album ? String(track.album.name || '') : '',
          interval: toSeconds(track.duration != null ? track.duration : track.duration_ms),
          img: coverOf(track) || null
        }
      }

      // ---- H5 SEO 曲目（歌词 / 试听地址 / 封面的统一来源，带缓存） ----

      function seoTrack(trackId) {
        var hit = seoCache[trackId]
        if (hit && Date.now() - hit.at < SEO_CACHE_TTL) return Promise.resolve(hit.data)
        return http(LUNA_HOST + '/luna/h5/seo_track?track_id=' + encodeURIComponent(trackId) +
          '&device_platform=web', {
          method: 'GET',
          headers: {
            'User-Agent': WEB_UA,
            Referer: LUNA_HOST + '/'
          },
          timeout: 20000
        }).then(function (body) {
          seoCache[trackId] = { at: Date.now(), data: body }
          return body
        })
      }

      function parseVideoModel(seo) {
        var raw = seo && seo.track_player && seo.track_player.video_model
        if (!raw) return null
        if (typeof raw === 'object') return raw
        try {
          return JSON.parse(raw)
        } catch (e) {
          return null
        }
      }

      function chooseVideo(seo, quality) {
        var model = parseVideoModel(seo)
        var list = model && Array.isArray(model.video_list) ? model.video_list : []
        if (!list.length) return null
        var scored = list.map(function (v) {
          var meta = v.video_meta || {}
          var bitrate = Number(meta.bitrate) || 0
          var level = /higher|highest/.test(String(meta.quality)) ? 2 : 1
          return { v: v, bitrate: bitrate, level: level }
        }).filter(function (item) {
          return item.v && (item.v.main_url || item.v.backup_url)
        })
        if (!scored.length) return null
        var wantHigh = quality && quality !== '128k'
        scored.sort(function (a, b) {
          if (wantHigh) {
            return (b.level * 1000000 + b.bitrate) - (a.level * 1000000 + a.bitrate)
          }
          return (a.level * 1000000 + a.bitrate) - (b.level * 1000000 + b.bitrate)
        })
        var picked = scored[0].v
        return pickUrl(picked.main_url) || pickUrl(picked.backup_url)
      }

      // ---- 搜索 ----

      function unsupportedSearch() {
        return Promise.reject(new Error('直连模式不支持搜索：请在插件设置中填写自建 qishui-api 服务地址'))
      }

      function serverCall(route, payload) {
        var base = apiBase()
        if (!base) return Promise.reject(new Error('未配置自建服务地址'))
        return http(base + route, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          data: payload,
          timeout: 20000
        }).then(function (body) {
          if (!body || body.code !== 0) {
            throw new Error('服务返回错误：' + (body && body.message ? body.message : 'code ' + (body && body.code)))
          }
          return body.data || {}
        })
      }

      function searchViaServer(keyword, page, limit) {
        return serverCall('/search/mixed', {
          keywords: keyword,
          cursor: String((page - 1) * limit)
        }).then(function (data) {
          var tracks = Array.isArray(data.tracks) ? data.tracks : []
          var list = tracks.map(mapTrack).filter(Boolean)
          var total = (page - 1) * limit + list.length + (list.length >= limit ? limit : 0)
          return { list: list, total: total, limit: limit, allPage: Math.max(1, Math.ceil(total / limit)) }
        })
      }

      // 直连 + 签名头的尽力而为路径：PC 搜索响应结构随版本变化，递归查找“曲目数组”
      function deepFindTracks(node, depth) {
        if (depth > 6 || !node || typeof node !== 'object') return null
        if (Array.isArray(node)) {
          if (node.length && node.every(function (x) {
            return x && typeof x === 'object' && x.id && (x.name || x.trackName) &&
              (Array.isArray(x.artists) || x.user_info || x.singer)
          })) {
            return node
          }
          for (var i = 0; i < node.length; i++) {
            var r = deepFindTracks(node[i], depth + 1)
            if (r) return r
          }
          return null
        }
        var keys = Object.keys(node)
        for (var k = 0; k < keys.length; k++) {
          var r2 = deepFindTracks(node[keys[k]], depth + 1)
          if (r2) return r2
        }
        return null
      }

      function searchViaSignature(keyword, page, limit) {
        var helios = setting('xHelios', '')
        var medusa = setting('xMedusa', '')
        if (!helios && !medusa) return unsupportedSearch()
        var params = new URLSearchParams({
          aid: '386088',
          app_name: 'luna_pc',
          device_platform: 'windows',
          device_type: 'Windows',
          version_code: '30000000',
          version_name: '3.0.0',
          channel: 'official',
          q: keyword,
          cursor: String((page - 1) * limit),
          search_method: 'input'
        }).toString()
        var headers = {
          'User-Agent': WEB_UA,
          Referer: 'https://www.qishui.com/',
          Origin: 'https://www.qishui.com'
        }
        if (helios) headers['X-Helios'] = helios
        if (medusa) headers['X-Medusa'] = medusa
        return http(PC_HOST + '/luna/pc/search/track?' + params, {
          method: 'GET',
          headers: headers,
          timeout: 20000
        }).then(function (body) {
          var rawTracks = deepFindTracks(body, 0) || []
          var list = rawTracks.map(mapTrack).filter(Boolean)
          var total = (page - 1) * limit + list.length + (list.length >= limit ? limit : 0)
          return { list: list, total: total, limit: limit, allPage: Math.max(1, Math.ceil(total / limit)) }
        })
      }

      // ---- 歌单广场 / 详情 ----

      function extractPlaylists(body) {
        var blocks = Array.isArray(body.inner_block) ? body.inner_block : []
        return blocks.reduce(function (acc, block) {
          var resources = Array.isArray(block.resources) ? block.resources : []
          resources.forEach(function (resource) {
            var p = resource && resource.entity && resource.entity.playlist
            if (!p || !p.id) return
            acc.push({
              id: String(p.id),
              name: String(p.title || p.name || ''),
              author: p.user_info && p.user_info.nickname ? String(p.user_info.nickname) : '',
              img: pickUrl(p.url_cover || p.cover_url || p.cover || p.coverURL) || undefined,
              desc: p.intro || p.description || undefined,
              total: p.count_tracks != null ? p.count_tracks : (p.track_count || p.song_count)
            })
          })
          return acc
        }, [])
      }

      function unwrapTrack(resource) {
        return (resource && resource.entity && resource.entity.track_wrapper &&
          resource.entity.track_wrapper.track) ||
          (resource && resource.entity && resource.entity.track) ||
          (resource && resource.track) || null
      }

      function mapPlaylistInfo(p) {
        if (!p) return {}
        return {
          name: String(p.title || p.name || ''),
          img: pickUrl(p.url_cover || p.cover_url || p.cover || p.coverURL) || undefined,
          desc: p.intro || p.description || undefined,
          author: p.user_info && p.user_info.nickname ? String(p.user_info.nickname) : ''
        }
      }

      function provider() {
        return {
          id: 'qs',
          name: '汽水音乐',
          qualitys: ['128k', '320k'],

          search: function (keyword, page, limit) {
            page = page || 1
            limit = limit || 30
            if (isServerMode()) return searchViaServer(String(keyword || ''), page, limit)
            return searchViaSignature(String(keyword || ''), page, limit)
          },

          getMusicUrl: function (song, quality) {
            var id = String(song && song.songmid || '')
            if (!id) return Promise.reject(new Error('缺少曲目 ID'))
            if (setting('previewHint', true) && Date.now() - lastHintAt > 60000) {
              lastHintAt = Date.now()
              api.ui.toast('当前为汽水音乐 30 秒试听片段', 'short')
            }
            return seoTrack(id).then(function (seo) {
              var url = chooseVideo(seo, quality)
              if (!url) throw new Error('该曲目暂无可播放片段')
              return url
            })
          },

          getLyric: function (song) {
            var id = String(song && song.songmid || '')
            if (!id) return Promise.resolve(null)
            return seoTrack(id).then(function (seo) {
              var lrc = seo && seo.lyric && seo.lyric.content
              return lrc ? { lyric: String(lrc) } : null
            })
          },

          getPic: function (song) {
            var id = String(song && song.songmid || '')
            if (!id) return Promise.resolve('')
            return seoTrack(id).then(function (seo) {
              var track = seo && seo.seo_track && seo.seo_track.track
              return coverOf(track) || ''
            })
          },

          getSongLists: function (page, limit) {
            page = page || 1
            limit = limit || SQUARE_PAGE_SIZE
            var cursor = squareCursors[page - 1]
            if (cursor === undefined) {
              return Promise.resolve({ list: [], total: (page - 1) * limit, limit: limit, page: page, hasMore: false })
            }
            return postJson(LUNA_HOST + '/luna/discover/mix', {
              block_type: 'playlist',
              count: limit,
              cursor: cursor
            }, APP_UA).then(function (body) {
              if (body && body.has_more && body.next_cursor) squareCursors[page] = String(body.next_cursor)
              return {
                list: extractPlaylists(body),
                total: 0,
                limit: limit,
                page: page,
                hasMore: Boolean(body && body.has_more)
              }
            })
          },

          getSongListDetail: function (id, page, limit) {
            page = page || 1
            limit = limit || DETAIL_PAGE_SIZE
            var chain = detailCursors[id]
            if (!chain) chain = detailCursors[id] = ['']
            var cursor = chain[page - 1]
            if (cursor === undefined) {
              return Promise.resolve({ list: [], total: (page - 1) * limit, limit: limit, page: page, hasMore: false })
            }
            return postJson(LUNA_HOST + '/luna/playlist/detail', {
              playlist_id: String(id),
              count: limit,
              cursor: cursor
            }, APP_UA).then(function (body) {
              if (body && body.has_more && body.next_cursor) chain[page] = String(body.next_cursor)
              var resources = Array.isArray(body.media_resources) ? body.media_resources : []
              var list = resources.map(unwrapTrack).map(mapTrack).filter(Boolean)
              return {
                list: list,
                total: 0,
                limit: limit,
                page: page,
                hasMore: Boolean(body && body.has_more),
                info: mapPlaylistInfo(body && body.playlist)
              }
            })
          },

          searchSongLists: function (keyword, page, limit) {
            page = page || 1
            limit = limit || 20
            if (!isServerMode()) return unsupportedSearch()
            return serverCall('/search/playlist', {
              keywords: String(keyword || ''),
              cursor: String((page - 1) * limit)
            }).then(function (data) {
              var playlists = Array.isArray(data.playlists) ? data.playlists : []
              var list = playlists.filter(Boolean).map(function (p) {
                return {
                  id: String(p.id || ''),
                  name: String(p.title || p.name || ''),
                  img: pickUrl(p.cover_url || p.coverUrl) || undefined,
                  desc: p.description || undefined,
                  total: p.count_tracks != null ? p.count_tracks : undefined
                }
              }).filter(function (x) { return x.id })
              var total = (page - 1) * limit + list.length + (list.length >= limit ? limit : 0)
              return { list: list, total: total, limit: limit, page: page, allPage: Math.max(1, Math.ceil(total / limit)) }
            })
          }
        }
      }

      return api.source.register(provider()).then(function (unregister) {
        api.log.info('qishui music source registered: qs')
        return function () {
          if (typeof unregister === 'function') unregister()
        }
      })
    }
  })
})()
