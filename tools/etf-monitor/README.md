# QQQM / SPYM monitor

An independent TypeScript Cloudflare Worker with D1 persistence and ServerChan Turbo WeChat notifications. Local implementation is verified; cloud deployment and an actual WeChat receipt are still required before enabling the monitor. It is not part of the Xiaoyu production runtime.

Daily combined briefing: **08:00 Asia/Shanghai**. Price analysis: **30 minutes after a completed US exchange session**, with two consecutive closes required for confirmed signals. The scheduler checks due jobs every 15 minutes. State, task leases, outbox and the five-attempt Beijing-day push budget survive restarts.

Price signals and fundamental valuation are independent. Initial price thresholds are unvalidated heuristics. No cheap/expensive valuation label is enabled without 60 consecutive prior month-end FY1 observations from the same source, method and index proxy. No trading or portfolio allocation is automated. [Chinese instructions](#zh) include setup, activation and limitations.

Requirements: Node.js 24+, a Cloudflare account with Workers/D1 access, and a ServerChan Turbo SCT SendKey bound to your own WeChat. No paid plan or data subscription is automatically opened. Source data and credentials are subject to their providers' terms and limits.

```powershell
npm ci --ignore-scripts --cache .wrangler/npm-cache
npm run check
npm test
npm run build
npm run login
npm run setup
# Put your SERVERCHAN_SENDKEY in ignored .dev.vars, never in chat or Git.
npm run deploy
npm run activate -- --url https://YOUR-MONITOR.workers.dev
```

OAuth state, D1 identifiers, local secrets, build files and reports are ignored. The activation command requires the six-digit code read from the actual WeChat test message; an HTTP/API acceptance alone cannot enable monitoring. Failed cloud checks leave monitoring paused. Changing the SendKey requires another receipt check. No off-host backup or continuous cloud availability is claimed before verification.

<a id="zh"></a>

# QQQM／SPYM 长期监控

这是独立的 Cloudflare Worker 项目。**本地代码和测试已完成，尚未部署云端，也尚未验证微信实际送达。** 部署后不依赖电脑开机。小愈网站、3001服务、真实用户数据和计费系统不参与本项目。

## 使用方式

在本目录打开 PowerShell，依次运行上面的命令。安装仅使用本项目的依赖与缓存，不更改小愈依赖。

1. `npm run login` 输出 Cloudflare OAuth 登录网址，在浏览器中自行完成账户登录及授权。本项目把 OAuth 状态保存在忽略目录 `.wrangler/profile/`，普通全局 Wrangler 登录不会自动共享到这里。
2. `npm run setup` 建立或复用名为 `qqqm-spym-monitor` 的独立 D1 数据库，生成忽略的 `wrangler.local.json` 和管理密钥 `.dev.vars`。中断后重跑会先核对现有数据库，不盲目另建。
3. 到 [Server酱 Turbo](https://sct.ftqq.com/) 完成微信绑定，把自己的 SCT SendKey 填入 `.dev.vars` 的 `SERVERCHAN_SENDKEY`。保留自动生成的 `ADMIN_TOKEN`。密钥不发到聊天、不提交 Git。
4. `npm run deploy` 先做类型、测试和构建检查，应用独立 D1 迁移并暂停旧监控，再部署、上传云端 Secrets 和验证真实云端取数。任何门禁失败都停止后续启用。
5. `npm run activate -- --url 你的Worker地址` 再次核对云端行情，发送一条测试微信。只有在终端输入**微信中实际读到的六位验证码**后才启用。验证码30分钟内有效，验收证明与当前推送密钥绑定。

免费 Workers 的 CPU 预算较小。必须让真实云端取数、D1写入和消息验收全部通过；本机测试和打包成功不等于云端通过。若免费限额或数据源限制导致失败，保持暂停，不自动购买或升级。

## 日报与信号

每天北京时间08:00发送一份合并简报，休市日也发简短报告。收盘后30分钟开始正式分析，自动处理纽约夏令时、周末、法定休市和提前收盘；失败每15分钟重试，同一交易日最多3次。

| 规则 | SPYM | QQQM |
| --- | --- | --- |
| 低位观察 | 252交易日回撤≤−10%，且距200日均线≤−5% | 回撤≤−15%，且距均线≤−8% |
| 价格偏热 | 距200日均线≥10% | 距均线≥15% |
| 正式确认 | 连续两个完整交易日满足 | 连续两个完整交易日满足 |

改门槛使用 `src/signals.ts` 的 `defaultThresholds`，先重跑验证再部署。持续处于相同状态时不反复推送；退出需要两天确认，同方向重入至少距上次推送5个交易日，反方向确认可立即提醒。日报始终显示当前和已确认状态。

Yahoo 非承诺稳定的免费接口提供复权日线；通知展示真实收盘价，涨跌幅、回撤和均线偏离使用复权口径。SPYM 的自身历史包含原 SPLG，不额外拼接别的基金。正文会列出触发条件及仍未满足的条件。

当前 FY1 市盈率来自 SSGA 的 [SPYM 指数页面](https://www.ssga.com/us/en/individual/etfs/state-street-spdr-portfolio-sp-500-etf-spym) 和 [QNDX 指数页面](https://www.ssga.com/us/en/individual/etfs/state-street-spdr-portfolio-nasdaq-100-etf-qndx)。QQQM 明确使用 Nasdaq-100 指数代理。只读取 Index Characteristics 中的 FY1 行，拒绝与基金或指数的滚动市盈率混用。

当前估值超过5个交易日未更新，或没有60个连续完整月末的同来源、同算法、同指数 FY1 记录时，显示“估值待确认”。具备合格历史后，以前60个月末为固定五年样本，当前值的中位秩分位≤20%为相对便宜，≥80%为相对昂贵，并经两天确认。每日快照从上线后开始积累，**不会凭空补出过去五年历史**。

## 验证与历史回看

```powershell
npm run live:check
npm run backtest -- --symbol QQQM --live --out qqqm-history
npm run backtest -- --symbol SPYM --live --out spym-history
```

公开取数结果、JSON、Markdown及CSV写入忽略的 `output/`。回看从 QQQM 实际成立日、SPYM 开始跟踪现指数之日读取自身历史；指标需要252条观察预热。列出全部确认事件及被冷却抑制的事件，未来不足1／3／6／12个月的收益留空。最大不利变动分别表示低位信号后的继续下跌、偏热信号后的继续上涨。没有组合收益、税费或预测成功率承诺。

`npm run dev` 仅启动8787本地模拟器并初始化独立本地D1，默认暂停。`/health` 返回脱敏状态；所有 `/admin/*` 接口要求 `Authorization: Bearer ADMIN_TOKEN`。管理接口有 `/admin/status`、`/admin/validate`、`/admin/test-push`、`/admin/confirm-delivery`、`/admin/enable`、`/admin/pause`。仅发送测试消息的接口也计入每日额度。测试夹具均为合成数据，不发送真实微信。

## 运维与数据保留

- Server酱免费每日最多5次请求，失败与测试也计数，按北京时间重置。每天保留一个日报名额；低位／偏热提醒按两标的合并，其他失败延后重试。配额若被本项目之外的相同 SendKey 消费，本地计数无法感知，建议专用密钥。
- API返回成功只记录“已接收”。网络结果不明不会自动重发，避免同一消息重复送达；状态与结果不明原因可在鉴权状态接口查看。
- D1保存公开行情、FY1快照、确认／冷却状态、任务租约、待发消息及发送凭据；部署保留现有 D1，不用本机旧库覆盖。云端 Secrets、账户配置与OAuth状态分别保留。
- 手动备份使用本项目配置执行 Wrangler 的 D1 export，写入忽略的 `output/`，并另行安排安全保存及恢复演练。**尚未配置自动异机备份。** 本地 `.wrangler/state` 仅是开发模拟器，不是云端生产数据库。
- 交易日历规则支持2020至2040年，已登记2025-01-09特别休市。每年应对照[交易所日历](https://www.nyse.com/markets/hours-calendars)检查；临时特别休市需要维护。新日历异常、行情缺失、接口或页面结构变化都应失败停止新信号。
- 部署时保留暂停状态和原D1。升级失败后从 Cloudflare 版本界面恢复上版代码，先核对数据库和密钥，重新运行云端与微信验收后启用。不要删除数据库来解决代码错误。

信号是固定规则观察，不能确定未来底部或顶部；价格低位不等于估值便宜。
