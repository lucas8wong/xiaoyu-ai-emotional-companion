/**
 * 用户当前皮肤上报
 * POST /api/skin/usage   body: { skin: string }
 *
 * 用户端在「首次加载 + 切换皮肤」时上报一次；本接口用现有 resolveUserId(req)
 * 识别用户（登录→账号 userId，游客→设备指纹+IP 哈希），按 last-write-wins 记录
 * 到 skinUsageStore。测试/内网设备与运营自查 IP 不计（与 usage-time 口径一致）。
 */

import { Router, type Request, type Response } from 'express';
import { resolveUserId } from '../services/session.js';
import { isTestRequest } from '../services/activity.js';
import { skinUsageStore } from '../services/skinUsage.js';
import { pushSubscriptionStore } from '../services/push.js';

const router = Router();

router.post('/', (req: Request, res: Response): void => {
  const body = (req.body || {}) as { skin?: unknown };
  const skin = typeof body.skin === 'string' ? body.skin.trim() : '';
  if (!skin) {
    // 异常/空上报：静默忽略，不报错（前端 fire-and-forget）
    res.json({ success: true, recorded: false });
    return;
  }

  const deviceId = String(req.headers['x-device-id'] || '');
  // 只有「测试/开发」设备不计（运营自查 IP 不再跳过皮肤——再跳会把管理员自己登录后的皮肤也漏掉，
  // 导致「我明明切了星空，但我账号的皮肤仍是旧值」）。皮肤按身份记录，不影响统计口径。
  if (isTestRequest(req.ip, deviceId)) {
    res.json({ success: true, recorded: false });
    return;
  }

  const userId = resolveUserId(req);
  if (!userId) {
    res.json({ success: true, recorded: false });
    return;
  }

  skinUsageStore.setSkin(userId, skin);
  // 同步更新该账号所有订阅设备的皮肤（通知图标紧跟当前皮肤）
  try { pushSubscriptionStore.setSkinForUser(userId, skin); } catch { /* 忽略 */ }
  res.json({ success: true, recorded: true });
});

export default router;
