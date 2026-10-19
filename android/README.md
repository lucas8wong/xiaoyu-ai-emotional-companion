# Xiaoyu Android local interface

The Android app bundles the existing React interface, lazy-loaded modules, fonts, skins,
story/game images and music. It is a local WebView application, not a Kotlin UI rewrite.
It opens without downloading the website HTML or scripts. Accounts, AI, payments,
server saves, community and generated media still require the existing backend.

## Continuity and release

### Update delivery from 1.1.3

The signed config selects `pgyer-public-page`. The native checker reads only the fixed
HTTPS page `https://www.pgyer.com/xiaoyu-ai-android-1`, without visiting myxiaoyu.com
or using account API credentials. It reads literal public metadata, pins the public
application-group ID and Android type, and compares numeric version names (not Pgyer's
independent build counter). Each release must increase both Android versionCode and
numeric versionName. No JavaScript is executed, no URL from page contents is trusted,
and redirects, duplicate/unknown metadata, oversized pages and unsupported versions fail
closed. Network/parser failures stay silent; the fixed manual download entry remains.

This is a best-effort **public HTML adapter, not the official Pgyer check API**. A page
layout change, access challenge, password protection or unavailable network can prevent
detection; keep the app page public and verify detection after each upload. Publish new
versions to the same Pgyer application and retain its short URL and current-version
selection. Same-version-name rebuilds cannot be detected by this adapter.

The existing once-per-login prompt is retained. Its update button opens the fixed Pgyer
page in the system browser; Android performs signature/package checks during the user's
in-place installation. The former app-managed SHA-256 download pipeline is retained for
legacy manifest mode, but is **not** used for Pgyer browser downloads. Existing 1.1.2
clients require one signed in-place upgrade. They still use the old manifest until then.
There is no new business store, API key, paid API call, cloud account or SDK dependency.
Pgyer only supplies distribution/version discovery; backend connectivity is unchanged.

- Keep application ID `com.myxiaoyu.app`, storage origin `https://myxiaoyu.com`, existing
  storage keys and the **original release signing key**. Install over the old app;
  never uninstall or clear data to upgrade. Browser data and Android app data remain
  separate; upgrading does not upload browser-only saves or move data between devices.
- `LocalContent` serves the packaged allowlist under that original HTTPS origin.
  Unknown code/assets fail closed instead of mixing website releases. The previous
  website service worker is unregistered without clearing business storage. Website
  reload checks and service-worker installation are disabled in the Android build.
- `backend-config.json` is compiled into the signed package. Only listed HTTPS origins
  may receive redirected API calls or deliver updates. There is no retry of generation
  POSTs on another origin. Keep every gateway connected to the same authoritative data.
- Update checks are silent on startup, login and after a day away. There is no permanent
  homepage update panel. An available version prompts once per login (including a restored
  session on cold start), on Home after other dialogs or active typing finish. “Later”
  suppresses further prompts in that login, including returns from stories. This gate is
  memory-only; there is no new persistent business store. Downloads stay in private cache;
  SHA-256, exact length, package ID,
  increasing version and original signing identity must all pass. Android asks the user
  to authorize installation. Cancelling does not delete saves. A new app process can
  check/download again; resumable downloads are not implemented.
- Native messaging accepts only the top frame of the original HTTPS origin. Older
  WebViews without the messaging feature get a download-page link. Image exports use
  Android's document picker; camera/microphone retain Android runtime permission prompts.

## Build and publish

Prerequisites: Node dependencies (including Sharp), FFmpeg/ffprobe, JDK 17,
Android SDK 36/build-tools 36.0.0, Gradle 8.9. Set `FFMPEG_PATH` and `FFPROBE_PATH`
when those build tools are not on PATH. They are not bundled in the APK or required by the server.
The complete private production resource inventory must be present locally. The public
Git repository intentionally excludes some fonts, music and game resources. A successful
build without those resources is not a complete release.

1. Increase `versionCode` and `versionName` in `app/build.gradle` for every release.
2. From the repository root run `npx tsx scripts/build-android-web.mts`.
   This builds in `temp/`, copies only the client-resource allowlist and produces an
   exact asset manifest. It does not overwrite the website `dist/` or user data.
3. Set `JAVA_HOME` / `ANDROID_HOME`; run `gradle -p android :app:assembleRelease`.
4. Sign `app/build/outputs/apk/release/app-release-unsigned.apk` with the original
   privately stored keystore using `apksigner`. Supply passwords through environment
   variables or a secure prompt, never command arguments committed to Git. Verify
   with `apksigner verify --print-certs`; compare the certificate with the prior APK.
5. Rehearse an in-place upgrade and offline boot on the disposable emulator. `probe/`
   contains synthetic storage and updater instrumentation, separately signed with the
   same key. **Never ship the probe or run it on a user's device.**
6. Put the verified signed APK under `public/download/`. Generate
   `android-release.json` with `schema`, `packageId`, `versionCode`, `versionName`,
   `minSdk`, exact `bytes`, `sha256`, and an allowlisted HTTPS `apkUrl`.
   Publish the APK before the manifest. Update the download page and run
   `npm run build:seo`. Check the public manifest and APK range/length afterwards.
   Keep old APKs and the private key backup. Do not overwrite the production database.

Version 1.1.2 reduces the signed full-resource package from 721.8 to 399.1 MiB (44.7%).
Only isolated Android build copies are transformed: imported WebP scene art has a
1280px long-edge cap at quality 78; public photo/WebP art has a 1600px cap at quality 82;
high-bitrate background MP3s use 128 kbps with their original duration/sample rate/channels.
Animated images, fonts, skin artwork, PNGs/QRs, tutorials and speech/effects are retained.
This is lossy media optimization, not a claim of pixel-identical or lossless audio output.
Original website/source resources, every resource URL, app functions and saves stay intact.
No new runtime network dependency or persistent business store is added.

The build-only cache under ignored `temp/android-media-cache/` is keyed by source bytes,
policy and encoder versions, with output digests. It is disposable and cannot be used as
a user-data backup. `bundle-size-report.json` records the generated package totals. Windows
read-only flags are cleared only on generated copies; failed builds do not publish an APK.
Download over Wi-Fi and allow at least 2 GiB free for upgrades from the previous large package.
Further reductions through optional-resource downloads require a separately versioned,
verified cache, reachable hosting, offline fallbacks and continuity tests.

## Mainland connectivity: pending deployment

As confirmed by the operator, no cloud server or filing is available for this rollout.
The only configured backend/download origin is currently `https://myxiaoyu.com`.
Bundling the interface **does not make that backend reachable** on a blocked network.

A future deployment must provision a reachable API/download domain and TLS endpoint,
validate applicable filing/distribution requirements, and measure actual mainland
mobile/broadband connectivity. Use the continuity gates in
[`docs/cloud-deploy-aws-hk.md`](../docs/cloud-deploy-aws-hk.md) before any cutover:
one authoritative database, exact current release/private resources, auth keys,
uploads, voice and model services. Do not create a second independent account/save DB.

Before adding an origin to the signed config, verify CORS for `https://myxiaoyu.com`,
authorization/device headers, streaming, uploads/downloads, generated media URLs,
voice, email deep links and payment callbacks. The fetch routing hook covers API
fetches; absolute generated-media/payment/share links still need an endpoint audit.
Serve the signed APK and manifest on a reachable HTTPS download origin. An APK can
also be transferred directly, but that alone provides no online AI access. No cloud
cutover, mainland connectivity test, store submission or filing is claimed here.

For immediate distribution, share the original signed APK through a reachable file-transfer
or netdisk service. Recipients download the APK to Android and install over the old app;
do not rename it to another file type, unpack/repackage it, or request an uninstall. Keep
the release filename and SHA-256 alongside it. No alternate share link is provisioned here.
Netdisk sharing does not automatically become an in-app updater endpoint: that requires
an approved HTTPS origin serving the manifest and APK directly, plus measured connectivity.

<a id="zh"></a>

# 小愈安卓本地界面

**1.1.3 更新方式：** 新版直接读取固定蒲公英公开页中的版本元数据，校验公开应用标识和
安卓类型后比较数字版本号；不访问 myxiaoyu.com 来检查更新、不携带账号密钥、不执行网页
脚本、不采纳网页中的下载地址。仅较新版本沿用登录后一次提醒，点击后用系统浏览器打开
固定蒲公英链接，由用户下载并覆盖安装，系统核对包名和签名。旧版 App 需先覆盖升级一次。
公开页识别不是蒲公英正式 API，平台改版、验证码、访问限制或网络失败时会静默停止提醒，
不能承诺永久稳定；固定手动入口仍可用。每次发布须增加 versionCode 与数字 versionName，
上传同一应用、保留短链接、确认当前发布版本，再核验识别。仅改构建号而不改版本名无法识别。
此模式不执行旧的 App 内 SHA-256 下载流程；原校验流程保留给旧清单模式。无需云账号、
额外 SDK、付费 API 或新增业务存储。下方早期版本的“无备用链接”描述仅适用于此前状态；
后台的内地连通性仍未解决。

新版把现有 React 界面、页面代码、字体、皮肤、剧情／文游图片和音乐放进安装包，
通过系统 WebView 本地运行。不是重新用 Kotlin 编写整套界面。打开界面不再等网站
下载页面；登录、AI、支付、云端存档、社区和生成素材仍需要后台联网。

升级须沿用原包名、原签名和原 HTTPS 存储域名，直接覆盖安装，不卸载、不清数据。
网页浏览器与 App 的本机数据仍各自独立，不宣称浏览器存档已上传或跨设备迁移。
首页不再常驻显示检查按钮。启动、登录和离开一天后静默检查，有新版才在登录后的首页
弹出提醒，避开其他弹窗和正在输入的内容。「下次再说」后本次登录不重复提示；重开 App
恢复登录或下次重新登录可再次提醒。提醒次数只存在内存，不新增持久业务数据。
下载经过文件大小、SHA-256、包名、递增版本和签名校验，再由安卓系统确认安装。
更新缓存不是业务存档；取消安装不会删除存档。

1.1.2 完整资源包约 399 MiB，比上一版约 722 MiB 小 44.7%。只压缩安卓构建副本：
文游场景图最长边 1280px、质量 78；公共照片／WebP 图最长边 1600px、质量 82；
高码率背景音乐改为 128 kbps，保留时长、采样率和声道。这是有损资源优化，不宣称
画面或音频无损。字体、皮肤、PNG／二维码、教程和语音音效保留原文件，全部资源仍随包
提供，不新增联网下载前提；网页原图、功能和存档不变。构建新增 FFmpeg／ffprobe 工具，
可通过 FFMPEG_PATH／FFPROBE_PATH 配置；编码缓存只在忽略的 temp 目录，随时可重建，
不是业务数据或用户备份。建议 Wi-Fi 下载，旧大包升级仍预留至少 2 GiB 空间。构建、原签名、
测试、先发布 APK 后发布版本清单的步骤见上方。签名密钥及密码必须私下备份，
测试探针不能给用户安装。后续每次界面更新要升版本、打包并发布；后台逻辑可独立更新，
仍须兼容已安装的旧客户端。

目前没有云服务器和备案，实际线路仍只有原网站域名，内地联网尚未解决。后续需要
真实可达的 API／下载域名和服务器，完成数据连续性检查、所需手续及当地网络实测。
多入口必须连同一份权威账号／存档库；配置备用域名之前，须验证跨域、鉴权、流式对话、
上传与生成素材、语音、邮件链接和支付回调。直接传 APK 只能解决安装，不能替代后台连接。

现阶段可以把原签名 APK 用可访问的网盘或文件传输服务发给用户，下载到安卓手机后直接
覆盖安装。保留发布文件名与 SHA-256，不改后缀、不拆包重打包、不要求卸载旧版。
本轮没有创建网盘分享链接。网盘分享也不等于 App 自动更新线路；后者需要配置允许访问的
HTTPS 域名，直接提供版本清单和安装包，并完成实际网络测试。
