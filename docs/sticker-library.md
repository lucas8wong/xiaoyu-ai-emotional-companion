# Shared sticker library

The local library serves both daily character chat and Moments. Assets are bundled
under `public/stickers/`; they do not require an online sticker API or a model call.
This delivery provides the assets and shared retrieval functions. Automatic character
sending, message attachments and Moments rendering have **not** been connected yet.

## Contents and provenance

- 2,279 unique assets: 1,514 Fluent 3D, 455 Blob community reactions, 310 Blobfox.
- 130 animated assets, each with a static poster. WebP is used for compressed
  images/animations; source APNG animations stay PNG because sharp cannot decode
  their animation. No APNG is silently reduced to its first frame.
- 33 categories cover emotions, greetings, comfort, agreement, daily life, food,
  drinks, work/study, games, music, exercise, weather, nature, animals, travel,
  shopping, festivals, people, objects and symbols. Categories can overlap.
- Simplified/Traditional Chinese aliases plus English source keywords. Fluent
  names also retain pinned Unicode CLDR Chinese annotations. Specific aliases
  distinguish cats/foxes/dogs and Christmas/New Year rather than tagging an entire
  topic with every species or festival name.
- Original image bytes total 74,477,995; catalog image bytes total 25,768,061
  (65.4% smaller, excluding separate posters, catalog and notices).

`catalog.json` records each stable ID, content-addressed URL, SHA-256, original
SHA-256, source URL/path, pinned upstream revision, license, dimensions, frame
count, style, topics and supported contexts. `summary.json` supplies counts.
Sources: [Fluent Emoji](https://github.com/microsoft/fluentui-emoji),
[Blob archive](https://github.com/Raymo111/emoji),
[Blobfox team](https://github.com/adri326/blobfox), and
[Unicode CLDR](https://github.com/unicode-org/cldr-json).
Full upstream licenses, author notices and README credits ship in `licenses/`.
Read `NOTICE.txt` when redistributing. This is a broad collection of commonly used
styles, not a measured live popularity ranking. The importer performs source and
filename screening; the catalog's `review` field does not claim every image has
received individual human visual approval. Three sample contact sheets were checked.

## Reuse in chat and Moments

`src/lib/stickerLibrary.ts` is a pure shared module. Load `/stickers/catalog.json`
lazily once outside the main UI bundle, then call `searchStickerLibrary` with a
query, `context: 'chat' | 'moments'`, optional persona style, categories and recent
IDs to exclude. Queries such as 好困, 摸摸, 收到, 下班了, 吃飯 and coffee work.
Empty queries return a mix of styles; unknown topics can return no result.

Resolve any chosen ID through `stickerById`; model output must never invent image
URLs. `stickerDisplayUrl(asset, reducedMotion)` selects the static poster.
`allowAnimated: false` excludes animated candidates entirely. Match style and
relationship/context before attaching anything; a search result is not an
instruction to send. Keep the option to send no sticker.

For the later sending integration, persist the attachment's ID, immutable URL and
accessible description alongside the actual message/post. Retain files referenced
by historical messages when revising the library. Do not put the full catalog,
technical asset URLs or fake "sent a sticker" prose into model history. Only a
small relevant candidate set belongs in changing context; preserve existing prompt
cache ordering, quota caps, safety checks and failure-state rules. Existing online
search and chat transcripts are unchanged by this delivery.

## Import, validate and deploy

Run `node scripts/build-sticker-library.mjs --dry-run` to inspect pinned candidates;
`--apply` downloads/resumes original files into ignored `temp/sticker-library`,
compresses assets and replaces the manifest last. No credentials or production data
are used. It reuses installed sharp 0.34.5; the direct package/lock declaration is
included for clean installs, with no local installation or version change. The
importer never deletes historical asset files.
Pinned sources and the taxonomy are explicit in the script and
`scripts/lib/stickerTaxonomy.mjs`. Change them deliberately when refreshing sources.

Run `node node_modules/tsx/dist/cli.mjs --test test/unit/stickerLibrary.test.ts`.
Checks cover all asset hashes/sizes/decoding, posters, bilingual search relevance,
persona/context/repeat filters, unknown IDs and path traversal. Publish assets with
the normal atomic `npm run build:seo`; no running backend imports this new module,
so this asset/module-only delivery needs no production restart. Keep the complete
`public/stickers` tree, catalog and licenses in every deployment/migration. The raw
download cache and local QA sheets are rebuildable, not user records or off-host backup.

Validation for this delivery: six library tests pass (all files decoded and hashes
checked); cache contract 184/184; typecheck zero diagnostics; targeted lint clean;
atomic SEO build passes (67 pages plus two Chinese snapshots). Local and public
origins each pass 12 HTTP/hash checks covering catalog, static/WebP/APNG samples,
posters and licenses, with health 200. No backend restart was needed. The full
shared-worktree suite is **not green**: 3,474/3,504 pass, with 30 pricing-related
failures across quota, roleplay-cache ledger, turn estimates and usage tests, mainly
`AI_BUDGET_MODEL_UNPRICED`. No pricing/ledger source changes are part of this delivery.
Private evidence and the portable ZIP: `temp/sticker-library/`.

<a id="zh"></a>

# 共用表情包库

本地库供日常角色聊天和朋友圈共用。本轮交付素材、中文检索标签与共用检索函数，尚未接入角色自动发送、消息附件或朋友圈展示；原聊天记录与在线搜索不变。

共 2,279 张去重素材：Fluent 3D 1,514 张、Blob 反应贴纸 455 张、小狐狸 310 张，其中 130 张动图均有静态预览。图片合计由约 74.48 MB 压缩至 25.77 MB，缩减 65.4%，此数字不含另存预览、索引与授权文件。采用 WebP；不支持完整解码的 APNG 保留原动画 PNG，避免悄悄变成静图。

33 类覆盖情绪、问候、安慰、收到与拒绝、饮食、工作学习、娱乐、音乐、运动、天气、花草风景、动物、出行、居家、礼物购物、节日、人物动作、物品与符号。支持简繁中文与英文关键词；猫、狗、狐狸以及不同节日分别匹配，避免整类套用错误标签。每张保存来源、固定版本、授权、哈希、尺寸与动画信息。完整条款和作者署名随库分发；不是实时热榜，来源／文件名筛选也不等于逐张人工审图。本轮已查看三张抽样联系表。

公共素材位于 `public/stickers/`，检索函数位于 `src/lib/stickerLibrary.ts`，支持聊天／朋友圈场景、角色画风、话题、最近用过的 ID 排除、减少动态效果。模型只能选已存在的 ID，由程序校验并解析地址；不强制发送，不把整库塞进提示词。后续接入时附件须随真实消息保存并保留不可变地址，历史引用的素材不能因更新被清除。

导入命令、测试、来源与发布方法见上方英文。整库跟随正常前端构建发布，无运行中的后端引用，无需重启生产。上云必须携带整个素材目录、索引与授权文件；`temp` 中原始下载缓存和抽样图可重建，不是用户数据或异机备份。没有新增付费调用、密钥或用户持久层；复用已安装的 sharp 0.34.5，补直接依赖声明供干净安装使用，本机没有安装或更换版本。

本轮素材专项 6／6、缓存 184／184、类型零诊断、定向 lint 及 SEO 构建通过；本机／公网各 12 项 HTTP／哈希校验通过、健康 200。全量共享工作区测试不是全绿：3,474／3,504 通过，另外 30 项计费相关失败，主要为测试模型缺价；本轮没有改动计费／账本源码。证据和便携 ZIP 位于上述私有目录。
