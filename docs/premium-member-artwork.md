# Prestige and Sovereign artwork

The approved illustration family provides one Prestige (`mini`) heart medallion and one Sovereign (`flagship`) crown for each current interface skin. Their distinct silhouettes share fine jewelry details while matching the skin's colors, material and rendering style. Pixel Cottage retains pixel artwork.

Production files live under `public/skins/membership-v2/<skin>/` as `prestige.webp`, `sovereign.webp` (512px) and their `-sm.webp` variants (128px). Both sizes preserve transparent alpha. `src/lib/premiumMemberArt.ts` owns the supported-skin mapping; `SkinPlanIcon` uses the small variant for interface badges and decorative fallbacks for unknown future skins. Register and review new artwork when adding another skin.

The original images were generated with built-in imagegen from the approved concept and each existing skin's artwork. Sharp only resized and re-encoded the originals. Validate transparency, dimensions, unique files, public image MIME/hash, small-size rendering on light/dark backgrounds and narrow translated membership views before publishing. This frontend asset family introduces no persistent store or backend dependency.

<a id="zh"></a>

# 尊享与至尊图标

每套现有皮肤分别有尊享心钻徽章与至尊冠冕，沿用已批准的珠宝插画风格，按皮肤适配颜色／材质／装饰；像素木屋保留像素画法。生产目录membership-v2包含512像素大图与128像素小图，均保留透明通道。premiumMemberArt集中管理映射，SkinPlanIcon共用，未知新皮肤保留基础装饰图标兜底；增加皮肤时须补图并复核。

原图由内置imagegen按样稿与皮肤参考生成，Sharp仅优化尺寸／格式。发布前检查透明度、尺寸、文件独立性、官网资源类型／哈希、深浅背景小图及窄屏三语会员页面。本资源不新增持久层或后端依赖。
