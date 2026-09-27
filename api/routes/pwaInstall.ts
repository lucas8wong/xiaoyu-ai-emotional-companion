/**
 * 用户「安装/下载 Xiaoyu」上报
 * POST /api/pwa/install  (body 可空)
 *
 * 用户端在装成 App（桌面 beforeinstallprompt→装好 / iOS 首次从主屏打开）时上报一次。
 * 用现有 resolveUserId(req) 识别用户（登录→账号 userId，游客→设备指纹+IP 哈希），
 * 记录到 activityStore（installCount / installedAt）。测试/内网设备与运营自查 IP 不计。
 */
import { Router, type Request, type Response } from 'express';
import { resolveUserId } from '../services/session.js';
import { isTestRequest, activityStore } from '../services/activity.js';
import { getClientIp } from '../services/geo.js';
import { isSelfExcludedIp } from '../services/selfExclude.js';

const router = Router();

router.post('/', (req: Request, res: Response): void => {
  const deviceId = String(req.headers['x-device-id'] || '');
  const clientIp = getClientIp(req);
  // 测试/开发/运营自查（按公网 IP）不计，避免污染统计口径
  if (isTestRequest(req.ip, deviceId) || (clientIp && isSelfExcludedIp(clientIp))) {
    res.json({ success: true, recorded: false });
    return;
  }
  const userId = resolveUserId(req);
  if (!userId) {
    res.json({ success: true, recorded: false });
    return;
  }
  const country = String(req.headers['cf-ipcountry'] || req.headers['x-vercel-ip-country'] || '').slice(0, 2);
  activityStore.trackInstall(userId, { ip: clientIp, country });
  res.json({ success: true, recorded: true });
});

export default router;
