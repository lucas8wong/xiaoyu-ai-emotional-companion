# New annual purchase prices

Annual memberships are independent, one-time 365-day purchases. New quotes use `annualPricing.ts`, reading `PLUS_PRICE_CNY_YEARLY`, `PRO_PRICE_CNY_YEARLY` and `MAX_PRICE_CNY_YEARLY`. CNY is the source; regional USD/HKD quotes use the existing checkout FX and round upward to a cent. Invalid monetary configuration fails closed. Deprecated standalone annual USD settings do not determine new quotes.

Annual purchases do not stack monthly campaign, legacy monthly or QR discounts. Monthly prices, automatic subscription prices/coupons, daily/monthly/welcome grants, existing annual-channel switches and historical membership periods are separate and unchanged. A new annual price does not authorize a subscription update or customer migration. Existing stored orders retain their own price and term; delayed paid sessions settle using actual paid receipts, idempotently.

Restore the existing full SQLite database, including all original orders, receipt references, user membership boundaries and subscriptions, plus privately provisioned price settings. Ship the current payment/manual-catalog/admin-projection and QR copy with the generated frontend/locales. No new persistent store, browser state, secret, dependency or service is introduced. Production continuity evidence belongs in private release artifacts, never public Git.

The shared checkout contains other ongoing work. An isolated public policy commit is not a substitute for the exact complete current release and ignored assets required by the cloud-continuity gates.

<a id="zh"></a>

# 新购年付价格

年付是独立的一次性365天购买。新报价由上述年价模块读取三项人民币配置，按既有结账汇率派生美元／港币并向上取整到分；非法金额配置拒绝报价，旧独立美元年价不再决定新报价。

年付不叠加月付活动、老用户月付优惠或扫码折扣。月付、自动订阅价格／优惠券、每日／每月／欢迎赠送、年付渠道开关及历史会员期限独立保留。调新年价不授权修改订阅或迁移用户。原订单保留已存金额和期限，迟到已付结账按真实支付凭证幂等履约。

恢复时保留完整SQLite原订单、收款凭证、用户会员边界与订阅，并私下配置价格变量；当前支付／人工目录／管理投影／扫码说明与生成前端及语言文件一同发布，无新持久层／浏览器状态／密钥／依赖／服务。完整性证据仅放私有发布产物，不进入公开Git。

共享工作区还有其他并行改动，独立公开价格模块提交不等于完整当前发布版，迁移仍须遵循完整源码及被忽略资源的连续性门禁。
