# Modern shared sticker collection

The user-approved A/C/D/E/F/G/H/I families replace the retired Fluent/Blob/Blobfox
collection. Version 2026-10-25.2 contains **372 curated images, 115 animated**, with
27 scene indexes. The private bundle is `resources/stickers-modern/2026-10-25/`;
open `index.html` locally. The ZIP is `temp/sticker-modern/xiaoyu-modern-stickers-20261025.zip`.

| Family | Collection | Curated |
|---|---|---:|
| A | Real cat reactions | 12 |
| C | Arms-behind-back opossum | 26 |
| D | Elegant penguin poses/templates | 101 |
| E | Maltese line dog and golden retriever | 18 |
| F | Peach and Goma cats | 28 |
| G | Bear couple | 30 |
| H | Capybara Lululu | 18 |
| I | Abstract Nailong | 139 |

745 unique downloads were visually inspected through contact sheets; repetitive
penguin templates and unsuitable images were excluded. Each animation's poster was
inspected and all frames decoded; this does not claim full motion-by-motion review.
This is an approved style collection, not a measured popularity ranking or a claim
that each source image was created recently. Penguin entries include reusable
poses and props, rather than 101 finished captioned memes.

The curated originals total 188,912,202 bytes; compressed primary images total
63,958,784 bytes (66.1% smaller), or 65,473,026 bytes including static posters.
The verified ZIP is 65,587,137 bytes / 527 files. Both the ZIP CRC and every archived
file's SHA-256 were checked against the local bundle.

## Scenes and common metadata

`scenes/<primary-scene>/` stores each image once. `scene-index/*.json` provides
cross-scene indexes: greetings, agreement, confusion, laughter, teasing, speechless
reactions, work/study, rest/goodnight, food/drink, care, sadness, missing/waiting,
hugs, kisses, flirting, jealousy, reconciliation, absurd humour, observing,
refusal, play, music, sport/travel, weather, home, shopping and celebration.

Every record retains its source URL/page, pinned repository revision where relevant,
original/output SHA-256, dimensions, animation frames, Chinese title, search aliases,
scene categories and `contexts: ['chat', 'moments']`. Romantic reactions are labelled
separately from everyday agreement/comfort. No new message/post records are created.

`src/lib/stickerLibrary.ts` remains a shared pure search/ID/URL allowlist helper.
It excludes `rightsStatus: unverified` or `publicationAllowed: false` records.
The retired public catalog stays empty. The private catalog's `file`/`posterFile`
paths work in the offline gallery; its old prospective `url` fields are not deployed.
The operator subsequently requested in-app activation: `characterStickers.ts` uses
a separate explicit private runtime-approval.json allowlist and immutable first-party
API image URLs, preserving the original source-rights metadata without claiming an IP
license. Daily chat and Moments now store/show occasional persona/relationship/scene
matched attachments. See [runtime contract](character-stickers.md) for pacing, history,
reduced motion, fallback and deployment checks. This does not publish a bulk catalog
or include third-party media in public Git.

## Sources and actual reuse limits

Downloads use public files from the pinned repositories and source pages recorded
in `scripts/collect-modern-stickers.mjs` and each private catalog row. Repository
code licenses do not establish commercial rights to third-party characters.
The collection's source-rights records remain **unverified / publicationAllowed=false** and gitignored;
source README/license notices are preserved without claiming they license the IP.

SigStick was excluded because its [terms](https://www.sigstick.com/tos) explicitly
prohibit bulk automated collection. Tenor was not a media source.
[GetStickerPack terms](https://getstickerpack.com/terms-of-service) retain underlying
owner rights and require uploader permission; public download availability is not
commercial redistribution clearance. No authentication, paywall or blocked website
access was bypassed. No synthetic replacement of these branded characters was made.

## Reproduce, verify and migrate

- `node scripts/collect-modern-stickers.mjs --dry-run` inspects the explicit source list.
- `--apply` downloads privately and compresses; it refuses to overwrite a curated bundle.
- `node scripts/organize-modern-stickers.mjs --apply --verify` applies manually reviewed
  scene assignments and checks every selected hash, size, image, animation and poster.
  Rejected raw downloads are retained outside the deliverable in ignored temp.
- `node node_modules/tsx/dist/cli.mjs --test test/unit/stickerLibrary.test.ts`
  checks public retirement, rights exclusion, ID/path safety, common search semantics,
  style balance, scene curation and reduced motion without requiring private media in CI.
- `npm run test:cache`, typecheck and normal `npm run build:seo` retain project gates.

The legacy importer now refuses `--apply`. Old assets were moved out of active
public source/build directories, with a private rollback copy. A read-only SQLite
scan found no old library URL references before retirement; all business records
remain untouched. The publisher merges static folders, so removal of `dist/stickers`
requires the separately checked exact-directory retirement step, not just a build.

The new private directory must be explicitly provisioned and hash-verified during a
future cloud migration; it is not in public Git or an automatic cloud/off-host backup.
No new database key, browser state, dependency or runtime service. No backend restart
was needed for that source/static-library-only phase. The subsequent backend
integration requires the normal guarded restart and uses the explicit in-app
deployment configuration described in character-stickers.md; source-rights
uncertainty remains documented separately.

<a id="zh"></a>

# 现代聊天与朋友圈共用表情库

旧 Fluent／Blob／Blobfox 已退出可用库。新库精选372张、115张动图、27类场景，
涵盖真实猫咪、背手负鼠、高雅企鹅、线条小狗、蜜桃猫灰猫、小熊一二布布、水豚噜噜、
抽象奶龙。候选去重745张，剔除重复模板与不适合日常互动的图片；企鹅含可用姿势模板，
不将所有模板夸成现成配字梗图。系列选择符合用户确认，未声称每张都出自最近或有实时热度排名。

私有目录与压缩包见英文路径，打开index.html可按系列／场景／关键词检索，默认静态预览，
可切换动图。scenes按主场景归档，多场景交叉索引不重复占图像空间。恋爱抱抱／亲亲／撒娇、
日常问候／晚安／工作／吃饭／安慰、抽象吐槽／吃瓜等分别标注；全部保留出处、哈希与动画。

主图由约188.91MB压到63.96MB，加预览65.47MB，ZIP约65.59MB。全部文件校验与解码通过，
逐组看过静态／动图封面，未声称逐帧人工审查。旧库移出源目录及发布目录；只读未查到旧地址引用，
未修改聊天、朋友圈或其他用户记录。

新角色IP的商业再分发授权尚未核实，素材保存在被Git忽略的私有目录，公共索引暂为空；
后续已按用户明确要求接入聊天／朋友圈偶尔配表情，使用独立站内启用名单，详见character-stickers.md；
不将站内启用要求当成第三方版权授权证明。明确禁止批量抓取的SigStick已排除，
没有从Tenor下载，也未绕过登录／付费／封禁页面。来源可下载不等于取得IP授权。
上云须私下携带新目录并验哈希，不能当成已上传或已异机备份。无用户持久层或后端服务变动。
