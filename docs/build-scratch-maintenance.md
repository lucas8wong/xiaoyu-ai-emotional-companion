# Build scratch maintenance

Frontend and Android builders register disposable generated directories in
`temp/.build-scratch/`. Normal completion or failure removes owned scratch with
bounded retries. A later build reclaims registered remnants only after a one-hour
grace period and only when the owning process no longer exists. A live frontend
build keeps its lock regardless of elapsed time.

Unregistered legacy directories, historical release evidence, business data,
database backups, links and protected files are not cleanup targets. Android
replacement failures retain their rollback directory. Signed release originals,
live `dist/`, public assets and application stores are outside scratch cleanup.

For old, generated APK copies, the optional utility previews content hashes:

```powershell
npx tsx scripts/deduplicate-build-apks.mts --store=D:/private-build-apk-store
```

Add `--apply` to replace byte-identical old APK copies with verified hardlinks to
an independent private content-addressed store on the same volume. Original file
paths and contents remain available; no live APK or signed release original is
changed. Treat these archived aliases as immutable. Generate a new file and
replace the path instead of editing an alias in place. Back up/export actual
contents, or preserve hardlinks and the store together. The private alias manifest
records original paths, hashes, sizes and modification times.

This store and relocated developer snapshots are workstation continuity items,
not production dependencies or off-host backups. Preserve local development
history separately when moving workstations. Do not apply a blanket `temp/`
retention policy to migration bundles, database backups or historical evidence.

Validation: `npx tsx --test test/unit/buildScratch.test.ts
test/unit/androidBundleOptimize.test.ts`, plus the project and build-script type
checks. Application runtime restart is unnecessary for build-tool-only changes.

<a id="zh"></a>

# 构建临时目录维护

网页及安卓构建登记明确归属的临时目录，正常结束或失败时清理并有限重试。
若进程被强制终止，后续构建只回收登记过、进程已退出且超过一小时的遗留。
活跃网页构建不会仅因运行时间长而被抢锁。

未登记的旧目录、发布证据、数据、存档、数据库备份、链接及受保护文件不参与自动清理。
安卓替换失败时保留回滚目录，原始签名包、线上dist、public及业务存储不属于清理范围。

旧构建APK可用上述工具先预览，确认后加`--apply`。工具先核对SHA-256，再让相同APK
通过硬链接共享同卷私有文件库，保留原路径和内容。别名是不可变产物，应生成新文件再
替换，不能原地修改。导出时复制实际内容，或完整保留硬链接及文件库；私有清单保存
原路径、哈希、大小和修改时间。

私有文件库与迁盘后的开发快照属于本机连续性资料，不是生产依赖，也不等于异机备份。
不得把统一按天删除temp的规则应用到迁移包、数据库备份或历史证据。
