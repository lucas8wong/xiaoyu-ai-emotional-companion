/**
 * 按访问者 IP 建议默认界面语言
 * GET /api/geo/lang
 * 中国大陆 → zh-CN（简体）；香港/澳门/台湾 → zh-TW（繁体）；海外 → en（英文）
 * 内网/无法解析 → 默认 en（英文；未知/内部访客用通用语言）
 */

import { Router, type Request, type Response } from 'express';
import { lookupIp, getClientCountry, getClientIp } from '../services/geo.js';
import { type OutputLang } from '../services/zhConvert.js';

const router = Router();

router.get('/lang', (req: Request, res: Response): void => {
  const ip = getClientIp(req);
  const geo = lookupIp(ip, getClientCountry(req));
  let lang: OutputLang;
  if (!geo.isPrivate && geo.country && geo.country !== '未知') {
    // 简体中文地区：中国大陆 + 新加坡/马来西亚（官方中文均为简体）
    if (geo.country === '中国大陆' || geo.country === '新加坡' || geo.country === '马来西亚') lang = 'zh-CN';
    // 繁体中文地区：香港 / 澳门 / 台湾
    else if (geo.country === '香港' || geo.country === '澳门' || geo.country === '台湾') lang = 'zh-TW';
    else lang = 'en'; // 其余海外一律英文
  } else {
    // 内网 / 无法解析 → 默认英文（产品决策：未知/内部访客用通用语言）
    lang = 'en';
  }
  // 把判定结果顺手写成 cookie（非敏感、非 HttpOnly，前端要读）：
  // 这样即使 localStorage 不可用（隐私模式等），下次刷新的**首帧**（index.html 内联脚本读 cookie）
  // 就能按正确语言出标题/遮罩判断，不必等 JS 起来后再切语言 → 消除"闪一下英文"。
  try {
    res.cookie('cure_lang', lang, { path: '/', maxAge: 31536000, sameSite: 'lax' });
  } catch { /* cookie 失败不影响主流程 */ }
  res.json({ success: true, data: { lang, country: geo.country } });
});

/**
 * 按访问者 IP 判断是否中国大陆（地区信息查询）
 * GET /api/geo/me  -> { country, region, isMainland }
 * 注：支付侧与地区无关（自动到账只有 Stripe；微信收款码是人工兜底，对所有地区一样展示），
 *     本接口保留为通用地区信息（前端 src/lib/geo.ts 目前无调用点）。
 */
router.get('/me', (req: Request, res: Response): void => {
  const ip = getClientIp(req);
  const geo = lookupIp(ip, getClientCountry(req));
  const isMainland = geo.country === '中国大陆';
  res.json({ success: true, data: { country: geo.country, region: geo.region, isMainland } });
});

export default router;
