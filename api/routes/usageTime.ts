/**
 * 用户真实使用时长上报
 * POST /api/usage-time/hit
 *
 * 用户端在「页面可见 + 窗口聚焦（或近期有交互）」期间周期性心跳上报活跃秒数，并在离开页面时用
 * sendBeacon 兜底 flush。本接口用 resolveUserIdWithFallback(req) 识别用户（登录→账号，
 * 游客→设备指纹+IP 哈希）——**因为 sendBeacon 无法带自定义请求头**，身份会同时放在 body 里兜底
 * （见 api/services/session.ts 的注释；旧版只认请求头，导致兜底那段时间被记成「无设备身份」幽灵游客）。
 *
 * 免计口径（2026-09-18 收紧，与 visits.ts 一致）：测试设备（deviceId 以 test- 开头）、
 * RFC5737 测试网段、内网/本地/保留地址、运营自查 IP 一律不落账、也不计诊断。
 * ⚠️ 判定必须用「生效的 deviceId」（请求头优先、body 兜底），否则本地/自动化测试用 body 兜底身份就能绕过。
 * 仅隔离验证实例可用 `USAGE_TIME_ALLOW_LOCAL=1` 放行内网 IP（生产不设）。
 */

import { Router, type Request, type Response } from 'express';
import { resolveUserIdWithFallback, getAuthUserWithFallback } from '../services/session.js';
import { isTestRequest } from '../services/activity.js';
import { usageTimeStore, usageDiagStore } from '../services/usageTime.js';
import { getClientIp, isPrivateIp } from '../services/geo.js';
import { isSelfExcludedIp } from '../services/selfExclude.js';

const router = Router();

router.post('/hit', (req: Request, res: Response): void => {
  const body = (req.body || {}) as {
    seconds?: unknown; deviceId?: unknown; token?: unknown;
    vis?: unknown; focus?: unknown; interaction?: unknown; beacon?: unknown; diag?: unknown;
  };
  const seconds = Math.floor(Number(body.seconds) || 0);
  /** 0 秒兜底诊断：只记「活跃门状态」，不记时长（让 WebView 里一秒都没计到的情况在线上可见） */
  const diagOnly = body.diag === true;
  if (!diagOnly && !(Number.isFinite(seconds) && seconds > 0)) {
    // 异常/空上报：静默忽略，不报错（前端 fire-and-forget）
    res.json({ success: true, recorded: false });
    return;
  }

  // 生效身份：请求头优先，body 兜底（sendBeacon 唯一可用的通道）
  const headerDeviceId = String(req.headers['x-device-id'] || '');
  const bodyDeviceId = typeof body.deviceId === 'string' ? body.deviceId.trim() : '';
  const bodyToken = typeof body.token === 'string' ? body.token : '';
  const deviceId = headerDeviceId || bodyDeviceId;

  const clientIp = getClientIp(req);
  const allowLocal = process.env.USAGE_TIME_ALLOW_LOCAL === '1'; // 仅隔离验证实例使用

  // 测试设备 / RFC5737 测试网段：一律免计（deviceId 用生效值，防 body 兜底绕过）
  if (isTestRequest(req.ip, deviceId) || isTestRequest(clientIp, deviceId)) {
    res.json({ success: true, recorded: false });
    return;
  }
  // 内网/本地（自测、健康检查、本机脚本）+ 运营自查 IP：免计（与 visits.ts「今日访问」同口径）
  if (!allowLocal) {
    if ((clientIp && isPrivateIp(clientIp)) || (req.ip && isPrivateIp(String(req.ip)))) {
      res.json({ success: true, recorded: false });
      return;
    }
    if (clientIp && isSelfExcludedIp(clientIp)) {
      res.json({ success: true, recorded: false });
      return;
    }
  }

  const userId = resolveUserIdWithFallback(req, { deviceId: bodyDeviceId, token: bodyToken });
  if (!userId) {
    res.json({ success: true, recorded: false });
    return;
  }

  const isAccount = !!getAuthUserWithFallback(req, bodyToken);
  const vis = body.vis === true;
  const focus = body.focus === true;
  const interaction = body.interaction === true;
  const beacon = body.beacon === true;

  usageDiagStore.bump({
    reports: 1,
    withSeconds: seconds > 0,
    diagOnly,
    beacon,
    fetch: !beacon,
    // 身份来源：请求头 / body 兜底 / 账号 / 游客
    identityHeader: !!headerDeviceId,
    identityBody: !headerDeviceId && !!bodyDeviceId,
    identityAccount: isAccount,
    identityGuest: !isAccount,
    // 门状态（用于确认「内嵌浏览器 hasFocus() 恒 false」这一假设）
    visible: vis,
    focused: focus,
    interacted: interaction,
    focusFalseVisible: vis && !focus,
    gateClosedVisible: vis && !focus && !interaction,
    // 无头/自动化浏览器常见的特征组合（可见但既无焦点也无交互，且没有任何秒数）
    autoLike: vis && !focus && !interaction && diagOnly,
  });

  if (seconds > 0) usageTimeStore.addActiveTime(userId, seconds);
  res.json({ success: true, recorded: seconds > 0 });
});

export default router;
