/**
 * IP 地理定位（商业分析用）
 *
 * 数据源优先级（P1 修复，2026-08-25）：
 *   1) Cloudflare / Vercel 国家头（cf-ipcountry / x-vercel-ip-country）：全球覆盖、准确，海外首选
 *   2) ip2region 离线库：国内省份/城市/运营商细分；港澳台独立；海外兜底（实测覆盖有限且可能错标，
 *      如 1.1.1.1→澳大利亚、UK IPv6→德国，因此海外以国家码为准）
 * 纯本地解析：不调用任何第三方 API，不把用户 IP 外发（符合数据保护红线）
 *
 * 口径说明（面向运营/商业分析）：
 * - 香港 / 澳门 / 台湾 独立为地区
 * - 大陆按「省份」细分；海外按「国家」细分（有国家码时以码为准）
 * - 无法识别 → country='未知'（isPrivate=false，运营统计中保留为「未知/未识别」桶，不再静默丢弃）
 */

import type { Request } from 'express';

// CJS/ESM 互操作：ip2region 是 CJS（exports.default = 构造函数），tsx/ESM 下 default 可能是 {default: ctor}
import ip2regionMod from 'ip2region';
const IP2RegionCtor: any = ((ip2regionMod as any).default ?? ip2regionMod) as any;

export interface GeoInfo {
  /** 展示地区：香港 / 澳门 / 台湾 / 中国大陆 / 美国 / 日本 …（未知另有值） */
  country: string;
  /** 大陆省份（如 广东）；港澳台与海外为空串 */
  region: string;
  city: string;
  /** 归一化运营商（可能为空） */
  isp: string;
  /** 是否内网/本地/保留地址（不计入用户分布） */
  isPrivate: boolean;
}

/** 从请求头取国家码（Cloudflare cf-ipcountry / Vercel x-vercel-ip-country；仅当经这些代理时存在） */
export function getClientCountry(req: Request): string | undefined {
  const c = String(req.headers['cf-ipcountry'] || req.headers['x-vercel-ip-country'] || '').trim().toUpperCase();
  return c || undefined;
}

/** ISO 3166-1 alpha-2 → 中文国家/地区名（运营展示用；未收录的码原样返回） */
export const COUNTRY_CODE_MAP: Record<string, string> = {
  // 大中华区
  CN: '中国大陆', HK: '香港', MO: '澳门', TW: '台湾',
  // 亚洲
  JP: '日本', KR: '韩国', KP: '朝鲜', SG: '新加坡', MY: '马来西亚', TH: '泰国', VN: '越南',
  ID: '印度尼西亚', PH: '菲律宾', IN: '印度', PK: '巴基斯坦', BD: '孟加拉', LK: '斯里兰卡',
  NP: '尼泊尔', MM: '缅甸', KH: '柬埔寨', LA: '老挝', BN: '文莱', TL: '东帝汶', MN: '蒙古',
  KZ: '哈萨克斯坦', UZ: '乌兹别克斯坦', SA: '沙特阿拉伯', AE: '阿联酋', IL: '以色列', TR: '土耳其',
  IR: '伊朗', IQ: '伊拉克', QA: '卡塔尔', KW: '科威特', OM: '阿曼', JO: '约旦', LB: '黎巴嫩',
  SY: '叙利亚', YE: '也门', AF: '阿富汗', AM: '亚美尼亚', AZ: '阿塞拜疆', GE: '格鲁吉亚',
  CY: '塞浦路斯', BH: '巴林',
  // 欧洲
  GB: '英国', FR: '法国', DE: '德国', IT: '意大利', ES: '西班牙', PT: '葡萄牙', NL: '荷兰',
  BE: '比利时', CH: '瑞士', AT: '奥地利', SE: '瑞典', NO: '挪威', DK: '丹麦', FI: '芬兰',
  IE: '爱尔兰', PL: '波兰', CZ: '捷克', SK: '斯洛伐克', HU: '匈牙利', RO: '罗马尼亚', BG: '保加利亚',
  GR: '希腊', UA: '乌克兰', RU: '俄罗斯', BY: '白俄罗斯', LT: '立陶宛', LV: '拉脱维亚', EE: '爱沙尼亚',
  SI: '斯洛文尼亚', HR: '克罗地亚', RS: '塞尔维亚', IS: '冰岛', LU: '卢森堡', MT: '马耳他',
  AL: '阿尔巴尼亚', MK: '北马其顿', BA: '波黑', MD: '摩尔多瓦', ME: '黑山',
  // 美洲
  US: '美国', CA: '加拿大', MX: '墨西哥', BR: '巴西', AR: '阿根廷', CL: '智利', PE: '秘鲁',
  CO: '哥伦比亚', VE: '委内瑞拉', UY: '乌拉圭', PY: '巴拉圭', BO: '玻利维亚', EC: '厄瓜多尔',
  GT: '危地马拉', CU: '古巴', DO: '多米尼加', CR: '哥斯达黎加', PA: '巴拿马', HN: '洪都拉斯',
  SV: '萨尔瓦多', NI: '尼加拉瓜', JM: '牙买加', TT: '特立尼达和多巴哥', HT: '海地',
  // 大洋洲
  AU: '澳大利亚', NZ: '新西兰', FJ: '斐济', PG: '巴布亚新几内亚',
  // 非洲
  ZA: '南非', EG: '埃及', NG: '尼日利亚', KE: '肯尼亚', ET: '埃塞俄比亚', GH: '加纳', MA: '摩洛哥',
  DZ: '阿尔及利亚', TN: '突尼斯', TZ: '坦桑尼亚', UG: '乌干达', CM: '喀麦隆', CI: '科特迪瓦',
  SN: '塞内加尔', ZM: '赞比亚', ZW: '津巴布韦', AO: '安哥拉', MZ: '莫桑比克', MW: '马拉维',
  ML: '马里', BF: '布基纳法索', NE: '尼日尔', TD: '乍得', SO: '索马里', SD: '苏丹', LY: '利比亚',
  CD: '刚果(金)', CG: '刚果(布)',
};

/** 国家码 → 中文名（未收录返回原码） */
export function countryCodeToName(code: string): string {
  const c = String(code || '').trim().toUpperCase();
  return c ? (COUNTRY_CODE_MAP[c] || c) : '';
}

let searcher: any = null;

function getSearcher(): any {
  if (searcher === null) {
    try {
      searcher = new IP2RegionCtor();
    } catch {
      searcher = false;
    }
  }
  return searcher || null;
}

/** 内网/保留地址（不计入用户分布） */
const PRIVATE_RE = /^(::1|fe80:|fc00:|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.)/;

/** 规范化 IP：去首尾空白、去 IPv4-mapped 前缀（::ffff:） */
function normalizeIp(raw: string): string {
  const s = String(raw || '').trim();
  return s.replace(/^::ffff:/i, '').trim();
}

/** 是否内网/本地/保留地址（不计入真实访客 IP；先规范化，避免 ::ffff: 前缀漏检） */
export function isPrivateIp(ip: string): boolean {
  return PRIVATE_RE.test(normalizeIp(ip));
}

/**
 * 取真实客户端 IP（地区分布用）。按优先级读 Cloudflare / Vercel / 通用代理头，
 * 取第一个公网（非内网/保留）地址；全部内网时回退 req.ip。
 * 解决「控制台地区分布显示本地/内网」：代理/本机内网地址不再被当作访客 IP。
 */
export function getClientIp(req: Request): string {
  const headers = (req.headers || {}) as Record<string, string | string[] | undefined>;
  const candidates: string[] = [];
  const add = (v: string | string[] | undefined): void => {
    if (!v) return;
    const parts = Array.isArray(v) ? v : String(v).split(',');
    for (const raw of parts) {
      const ip = normalizeIp(raw);
      if (ip) candidates.push(ip);
    }
  };
  add(headers['cf-connecting-ip']);
  add(headers['x-vercel-forwarded-for']);
  add(headers['x-forwarded-for']);
  add(headers['x-real-ip']);
  const fallback = normalizeIp(String(req.ip || ''));
  if (fallback) candidates.push(fallback);
  const socket = normalizeIp(String((req.socket as any)?.remoteAddress || ''));
  if (socket && !candidates.includes(socket)) candidates.push(socket);
  // 取第一个公网地址（真实访客）；无公网则回退第一个地址
  return candidates.find((ip) => !isPrivateIp(ip)) || candidates[0] || '';
}

/** 港澳台：ip2region 以 province 字段返回 */
const TERRITORY_PROVINCES: Record<string, string> = {
  香港: '香港',
  澳门: '澳门',
  台湾省: '台湾',
  台湾: '台湾',
};

const PROVINCE_SUFFIX_RE = /(省|市|壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区)$/;

function normalizeIsp(isp?: string): string {
  const s = (isp || '').trim();
  if (!s || s === '内网IP') return '';
  if (/移动/.test(s)) return '移动';
  if (/中华电信/.test(s)) return '中华电信';
  if (/电信/.test(s)) return '电信';
  if (/联通/.test(s)) return '联通';
  if (/谷歌|^Google/.test(s)) return 'Google';
  if (/Cloudflare/i.test(s)) return 'Cloudflare';
  return s.slice(0, 20);
}

/**
 * IP 定位。countryCode 优先（Cloudflare/Vercel 国家头，全球覆盖准确）；
 * 无码/未收录时回退 ip2region（大陆省份/城市/运营商细分、港澳台、海外兜底）。
 */
export function lookupIp(ip: string, countryCode?: string): GeoInfo {
  const raw = (ip || '').trim();
  const norm = normalizeIp(raw);
  const base: GeoInfo = { country: '', region: '', city: '', isp: '', isPrivate: true };
  if (!raw) return { ...base, country: '未知', isPrivate: false };
  if (isPrivateIp(norm)) return { ...base, country: '本地/内网' };

  const code = (countryCode || '').trim().toUpperCase();
  const codeName = countryCodeToName(code);
  if (codeName && code !== 'CN') {
    // 海外/港澳台：以国家码为准（不再依赖 ip2region 的海外错标）
    return { ...base, country: codeName, isPrivate: false };
  }
  // 中国大陆（码=CN）或无国家码：走 ip2region 细分省份/城市/运营商
  const s = getSearcher();
  if (!s) return { ...base, country: codeName || '未知', isPrivate: false };
  try {
    const r = s.search(raw);
    if (!r || !r.country) return { ...base, country: codeName || '未知', isPrivate: false };
    const country = String(r.country).trim();
    const provinceRaw = String(r.province || '').trim();
    const isp = normalizeIsp(r.isp);

    // 港澳台独立为地区
    const territory = TERRITORY_PROVINCES[provinceRaw];
    if (territory) return { country: territory, region: '', city: String(r.city || '').trim(), isp, isPrivate: false };

    // 大陆：省份细分（有 CN 码时即使 ip2region 判定异常也按大陆处理）
    if (country === '中国' || codeName === '中国大陆') {
      const region = provinceRaw.replace(PROVINCE_SUFFIX_RE, '');
      return { country: '中国大陆', region, city: String(r.city || '').trim(), isp, isPrivate: false };
    }

    // 海外（无国家码兜底）：国家
    return { country: country || '未知', region: '', city: String(r.city || '').trim(), isp, isPrivate: false };
  } catch {
    return { ...base, country: codeName || '未知', isPrivate: false };
  }
}
