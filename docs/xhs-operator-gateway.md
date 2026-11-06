# Private operator gateway

The owner workbench is available at `https://myxiaoyu.com/xhs/`. Sign in using the existing admin credential. Every operator resource, API, image and event stream is authenticated. The gateway uses an eight-hour Secure, HttpOnly, SameSite=Strict cookie scoped to `/xhs`, validates mutation origins, rate-limits login failures, never passes the admin credential upstream and disables shared caching. Rotating `ADMIN_TOKEN` invalidates existing sessions. No credentials belong in URLs or this document.

This is remote access to the existing Windows process, not a cloud migration. The gateway in `api/middleware/xhsOperator.ts` forwards only to loopback port3188, before the website's body parsers and business observers. Keep the PC, website origin and independent operator service running. An offline operator returns503 without making the website depend on operator startup. The website database remains separate and unchanged. Existing version-bound approval, no-repeat publication and uncertain-result handling remain mandatory.

The operator artifact supports both localhost root and `/xhs/`, including images, exports and SSE. Browser automation and official login windows run on the host PC; remote clients can view the existing preview/QR flow, but this does not implement a remote desktop or CAPTCHA bypass.

Recovery inventory: preserve the entire independent operator runtime, database, media, evidence, account cookies/browser storage, model configuration and connector/Skill versions using its private backup/restore scripts. Carry the gateway and admin environment configuration with the website. Never place operator data in the public website assets or overwrite it with the website database. A future cloud origin requires a separately authenticated link to the Windows worker or an independently validated migration; the current loopback route is not an off-host service or backup.

Validation: isolated proxy authentication/origin/upload/stream/credential-stripping/rate-limit tests;296 operator tests and Chrome83 staged gates; public HTTP checks for the login page, unauthorized denial, authenticated artifact/data/image parity, SSE, logout and website health. QA HTTP requests use the explicit Xiaoyu test marker. No test publication, generation or user-data migration.

<a id="zh"></a>

# 运营台受保护入口

入口为 `https://myxiaoyu.com/xhs/`，使用现有admin管理口令。稿件、图片、接口和实时进度全部鉴权；会话八小时有效，退出清理浏览器会话，修改管理口令会使旧会话失效。

这是远程访问本机运营台，不是上云。电脑、网站源站和独立3188服务需持续运行；运营台离线时返回明确提示，不影响网站其他入口。正式发布仍受具体稿件版本批准和防重发约束。登录及发布浏览器仍在本机，远端可看预览／二维码，不具备远程桌面或代过验证能力。

恢复须保留运营台整套私有运行数据、素材、登录状态、模型配置和固定连接器／Skill版本，与小愈数据库分开。未来迁移网站源站时必须另建安全的本机执行连接或完成独立迁移，不能把当前环回代理描述为云服务或异机备份。验证范围见英文，未测试发帖或调用收费模型。
