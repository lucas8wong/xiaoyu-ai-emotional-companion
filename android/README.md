# Xiaoyu Android local interface

The Android app bundles the existing React interface, lazy-loaded modules, fonts, skins,
story/game images and music. It is a local WebView application, not a Kotlin UI rewrite.
It opens without downloading the website HTML or scripts. Accounts, AI, payments,
server saves, community and generated media still require the existing backend.

## Continuity and release

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

Prerequisites: Node dependencies, JDK 17, Android SDK 36/build-tools 36.0.0, Gradle 8.9.
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

The initial full-resource package is approximately 722 MiB. Download over Wi-Fi and
allow at least 2 GiB of free space for installation/update. Future size reductions
should use a separately versioned, verified optional-resource cache, with offline
fallbacks and continuity tests; do not silently remove current game/media resources.

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

完整资源首包约 722 MiB，建议 Wi-Fi 下载并预留至少 2 GiB 空间。构建、原签名、
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
