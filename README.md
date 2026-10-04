# LX-Y Music 插件商店

LX-Y Music App 内置「插件商店」功能，本仓库即官方商店的云端数据源。App 通过 jsDelivr / raw.githubusercontent.com 镜像拉取 `catalog.json`，并按清单中的相对路径下载插件脚本，在 WebView 沙箱中运行。

## 目录结构

```
catalog.json                      商店清单
plugins/
  qishui-music@1.0.0.js           插件脚本（单文件 .js，头部含 manifest 注释）
```

## catalog.json 格式

```json
{
  "schema": 1,
  "name": "商店名称",
  "plugins": [
    {
      "id": "qishui-music",
      "version": "1.0.0",
      "name": "汽水音乐",
      "description": "展示用描述（可省略，省略时用插件 manifest 自带文案）",
      "icon": "🥤",
      "author": "lx-y",
      "homepage": "https://...",
      "minAppVersion": "26.09.28",
      "tags": ["music-source"],
      "file": "plugins/qishui-music@1.0.0.js",
      "sha256": "可选，脚本 SHA-256",
      "fileSize": 18492,
      "updatedAt": "2026-10-04"
    }
  ]
}
```

字段要求：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 必须与脚本头注释 `@id` 一致，且不能与 App 内置功能冲突 |
| `version` | 是 | 点分版本号，App 据此判断是否显示「更新」 |
| `file` | 是 | 相对 `catalog.json` 的脚本路径，支持单文件 `.js` 或 `{manifest,code}` 包装的 `.json` |
| `minAppVersion` | 否 | 最低宿主 App 版本 |
| `sha256` | 否 | 脚本校验值（展示预留） |

## 上架新插件

1. 将单文件插件脚本放入 `plugins/`，建议命名 `id@version.js`；
2. 在 `catalog.json` 的 `plugins` 中新增条目（或更新版本号与 `file`）；
3. 提交到 `main` 分支。用户在 App 内点「刷新商店」即可看到（jsDelivr 缓存可能有数分钟延迟）。

## 自建商店源

任何静态托管（GitHub Pages、对象存储、本地 HTTP 服务）按上述结构提供 `catalog.json` 即可。在 App「插件扩展 → 插件商店 → 商店源设置」填入完整地址即可切换；留空保存恢复官方源。

## 安全说明

- 商店插件与本地导入插件使用同一套沙箱：插件只能通过宿主桥接访问受控能力（网络代理、播放事件、存储、UI 提示等）；
- 上架脚本应公开可读、可审计；不要上架来源不明的插件。
