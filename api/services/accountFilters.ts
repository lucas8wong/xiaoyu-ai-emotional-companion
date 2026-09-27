/**
 * 账号过滤：测试账号 / 开发者账号
 *
 * 为什么单独抽一个服务模块（原本内联在 api/routes/paymentAdmin.ts）：
 *   运营端统计、群发邮件、以及新增的成人向定向邮件（services/adultCampaign.ts）都要排除这两类账号。
 *   服务层**不能**反向 import 路由文件（routes ← services 是单向依赖，反向会成循环依赖），
 *   所以把这两个判定挪到这里，路由与服务共用同一份口径——避免两处各写一份、日后口径漂移。
 *
 * 判定口径与拆分前完全一致，只是搬了家。⚠️ 2026-09-27：原先内置的开发者邮箱已**移出代码**，
 * 改由 .env 的 DEV_ACCOUNTS 提供（仓库里不留个人邮箱）。
 */

/**
 * 判断是否测试账户（邮箱 @test.com 或用户名/邮箱前缀在 TEST_ACCOUNTS 配置中）
 */
export function isTestAccount(acc: { username?: string | null; email: string }): boolean {
  const email = (acc.email || '').toLowerCase();
  if (email.endsWith('@test.com')) return true;
  const list = (process.env.TEST_ACCOUNTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const username = (acc.username || '').toLowerCase();
  if (list.includes(username)) return true;
  return list.some(x => email.startsWith(x + '@'));
}

/**
 * 判断是否开发者账号（不纳入用户统计/用户列表）
 * 邮箱或用户名精确命中 DEV_ACCOUNTS 配置（逗号分隔，支持前缀匹配）。
 * （原内置默认开发者邮箱 2026-09-27 移出代码，避免个人邮箱进仓库；线上请在 .env 配置 DEV_ACCOUNTS。）
 */
export function isDeveloperAccount(acc: { username?: string | null; email: string }): boolean {
  const email = (acc.email || '').toLowerCase();
  const username = (acc.username || '').toLowerCase();
  const list = [
    ...(process.env.DEV_ACCOUNTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  ];
  if (list.includes(email) || list.includes(username)) return true;
  return list.some(x => email.startsWith(x + '@') || username.startsWith(x));
}
