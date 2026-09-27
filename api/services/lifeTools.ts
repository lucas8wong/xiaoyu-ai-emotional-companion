/**
 * 生活能力工具（天气 / 地名地理编码 / 地图导航）—— 供「聊一聊」DeepSeek function-calling 调用。
 *
 * 设计原则：
 * - 默认走「免费、无 API key」数据源，保证零配置可用：
 *     · 天气：Open-Meteo（全球免费，无需 key）
 *     · 地名→坐标：Nominatim / OpenStreetMap（免费，需 User-Agent；需遵守其使用条款与限速）
 *     · 路线：免费兜底给出「直线距离估算 + 高德/Google 地图 App 深链」，用户点击即跳转导航
 * - 可选升级（.env 填 key 后自动启用，未填则降级到免费路径）：
 *     · AMAP_API_KEY=xxx           大陆：高德地理编码 + 驾车/步行路线
 *     · GOOGLE_MAPS_API_KEY=xxx    海外：Google Geocoding + Directions
 * - 所有输出归一化为「结构化文本摘要」，由模型自然转述成对话，绝不直接吐给用户 JSON。
 *
 * 错误处理：任何外部请求失败都返回「用户友好的错误摘要」，不让整个聊天失败；
 * 调用方（gemini.ts dispatchToolResults）已带 try/catch 兜底。
 */

const APP_UA = 'xiaoyu-life-tools/1.0 (https://myxiaoyu.com/)';
const TIMEOUT = 5000;

const AMAP_KEY = (process.env.AMAP_API_KEY || '').trim();
const GOOGLE_KEY = (process.env.GOOGLE_MAPS_API_KEY || '').trim();

import { type OutputLang } from './zhConvert.js';

/** 工具上下文：由路由层从请求/偏好解析后透传，供工具选数据源与默认位置。 */
export interface ToolCtx {
  isMainland?: boolean;   // 用户是否中国大陆（决定默认走高德还是 Google）
  city?: string;          // 用户当前城市（IP 定位或偏好，仅作兜底）
  lang?: OutputLang;
}

/** 带超时的 fetch 封装，返回解析后的 JSON；失败/超时返回 null。 */
async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<any | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': APP_UA, ...headers },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** WMO 天气现象码 → { zh, en }（Open-Meteo 使用 WMO weather_code）。 */
const WMO: Record<number, { zh: string; en: string }> = {
  0: { zh: '晴', en: 'Clear sky' },
  1: { zh: '大部晴朗', en: 'Mainly clear' },
  2: { zh: '局部多云', en: 'Partly cloudy' },
  3: { zh: '阴', en: 'Overcast' },
  45: { zh: '雾', en: 'Fog' },
  48: { zh: '雾凇', en: 'Depositing rime fog' },
  51: { zh: '小毛毛雨', en: 'Light drizzle' },
  53: { zh: '毛毛雨', en: 'Drizzle' },
  55: { zh: '浓毛毛雨', en: 'Dense drizzle' },
  56: { zh: '冻毛毛雨', en: 'Freezing drizzle' },
  57: { zh: '浓冻毛毛雨', en: 'Dense freezing drizzle' },
  61: { zh: '小雨', en: 'Slight rain' },
  63: { zh: '中雨', en: 'Moderate rain' },
  65: { zh: '大雨', en: 'Heavy rain' },
  66: { zh: '冻雨', en: 'Freezing rain' },
  67: { zh: '强冻雨', en: 'Heavy freezing rain' },
  71: { zh: '小雪', en: 'Slight snow' },
  73: { zh: '中雪', en: 'Moderate snow' },
  75: { zh: '大雪', en: 'Heavy snow' },
  77: { zh: '雪粒', en: 'Snow grains' },
  80: { zh: '小阵雨', en: 'Slight rain showers' },
  81: { zh: '阵雨', en: 'Moderate rain showers' },
  82: { zh: '强阵雨', en: 'Violent rain showers' },
  85: { zh: '小阵雪', en: 'Slight snow showers' },
  86: { zh: '强阵雪', en: 'Heavy snow showers' },
  95: { zh: '雷阵雨', en: 'Thunderstorm' },
  96: { zh: '雷雨伴冰雹', en: 'Thunderstorm with slight hail' },
  99: { zh: '强雷雨伴冰雹', en: 'Thunderstorm with heavy hail' },
};

function wmoLabel(code: number, lang: string): string {
  const m = WMO[code] || { zh: '未知', en: 'Unknown' };
  return lang === 'en' ? m.en : m.zh;
}

/** 计算两点直线距离（米），用于无 key 时的近似估算。 */
function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export interface GeoPoint {
  lat: number;
  lng: number;
  name: string;
}

/**
 * 地名 → 坐标。按「是否大陆 + 是否配 key」选数据源，失败降级 Nominatim。
 * source ∈ amap | google | nominatim。同名地名可能多义，取第一个结果（走最常用地名）。
 */
async function geocode(address: string, ctx: ToolCtx = {}): Promise<GeoPoint | null> {
  const addr = (address || '').trim();
  if (!addr) return null;

  // 大陆且配了高德 key → 高德地理编码
  if (ctx.isMainland && AMAP_KEY) {
    const json = await fetchJson(
      'https://restapi.amap.com/v3/geocode/geo?address=' + encodeURIComponent(addr) + '&key=' + AMAP_KEY + '&output=json'
    );
    const geo = json?.geocodes?.[0];
    const loc = geo?.location;
    const parts = String(loc || '').split(',');
    if (geo && parts.length === 2) {
      return { lng: parseFloat(parts[0]), lat: parseFloat(parts[1]), name: geo.formatted_address || addr };
    }
  }

  // 海外（或大陆但没配高德 key）且配了 Google key → Google Geocoding
  if (GOOGLE_KEY) {
    const json = await fetchJson(
      'https://maps.googleapis.com/maps/api/geocode/json?address=' + encodeURIComponent(addr) + '&key=' + GOOGLE_KEY
    );
    const res = json?.results?.[0];
    const loc = res?.geometry?.location;
    if (res && loc) {
      return { lat: Number(loc.lat), lng: Number(loc.lng), name: res.formatted_address || addr };
    }
  }

  // 兜底：Nominatim（免费、全球）
  const json = await fetchJson(
    'https://nominatim.openstreetmap.org/search?q=' + encodeURIComponent(addr) + '&format=json&limit=1&addressdetails=1',
    { Referer: 'https://myxiaoyu.com/' }
  );
  const first = Array.isArray(json) ? json[0] : null;
  if (first && Number(first.lat) && Number(first.lon)) {
    return { lat: Number(first.lat), lng: Number(first.lon), name: first.display_name || addr };
  }
  return null;
}

/** 解析 Open-Meteo 当前/多天预报，拼成可读摘要。 */
function formatWeather(loc: GeoPoint, data: any, date: string, lang: string): string {
  const cur = data?.current;
  const daily = data?.daily;
  const lines: string[] = [];
  lines.push('【天气】' + loc.name);
  if (date === 'today') {
    if (cur) {
      const t = Math.round(cur.temperature_2m);
      const app = cur?.apparent_temperature != null ? ' 体感' + Math.round(cur.apparent_temperature) + '°' : '';
      lines.push(
        '今天：' + wmoLabel(cur.weather_code, lang) +
        '，' + t + '°C' + app +
        (cur.relative_humidity_2m != null ? '，湿度' + Math.round(cur.relative_humidity_2m) + '%' : '') +
        (cur.precipitation ? '，降水' + cur.precipitation + 'mm' : '') +
        (cur.wind_speed_10m != null ? '，风速' + Math.round(cur.wind_speed_10m) + 'km/h' : '')
      );
    }
  } else if (date === 'tomorrow') {
    const i = 1;
    if (daily) {
      const hi = daily.temperature_2m_max?.[i];
      const lo = daily.temperature_2m_min?.[i];
      const code = daily.weather_code?.[i];
      const p = daily.precipitation_probability_max?.[i];
      lines.push(
        '明天：' + wmoLabel(code, lang) +
        (hi != null ? '，最高' + Math.round(hi) + '°' : '') +
        (lo != null ? ' / 最低' + Math.round(lo) + '°' : '') +
        (p != null ? '，降水概率' + Math.round(p) + '%' : '')
      );
    }
  }
  // 3 天概览
  if (daily) {
    const days = ['今天', '明天', '后天'];
    const slices: string[] = [];
    for (let i = 0; i < Math.min(3, (daily.time || []).length); i++) {
      slices.push(
        days[i] + ' ' + wmoLabel(daily.weather_code?.[i], lang) +
        ' ' + Math.round(daily.temperature_2m_min?.[i]) + '~' + Math.round(daily.temperature_2m_max?.[i]) + '°' +
        (daily.precipitation_probability_max?.[i] != null ? ' 降水' + Math.round(daily.precipitation_probability_max[i]) + '%' : '')
      );
    }
    if (slices.length) lines.push('未来：' + slices.join('；'));
  }
  return lines.join('\n');
}

/** 天气工具实现：location 缺省时用用户当前城市（IP/偏好兜底）；date=today|tomorrow。 */
export async function weatherNow(args: any, ctx: ToolCtx = {}): Promise<string> {
  const location = String(args?.location || '').trim() || ctx.city || '';
  const date = args?.date === 'tomorrow' ? 'tomorrow' : 'today';
  if (!location) {
    return '暂时无法确定你在哪个城市，请补充一下城市或位置（如「我在杭州」）。';
  }
  const loc = await geocode(location, ctx);
  if (!loc) return '没有找到「' + location + '」的位置，请换更具体的城市/地点名试试。';
  const url =
    'https://api.open-meteo.com/v1/forecast?latitude=' + loc.lat + '&longitude=' + loc.lng +
    '&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m' +
    '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code' +
    '&timezone=auto&forecast_days=3';
  const data = await fetchJson(url);
  if (!data) return '天气服务暂时不可用，稍后再试。';
  const lang = (ctx.lang || 'zh-CN') === 'en' ? 'en' : 'zh';
  return formatWeather(loc, data, date, lang);
}

/** 把 km 换算成人类可读距离。 */
function fmtKm(meters: number): string {
  const km = meters / 1000;
  return km >= 1 ? km.toFixed(1) + ' km' : Math.round(meters) + ' m';
}

function mapDeepLink(mode: string, dest: GeoPoint, from: GeoPoint | null, isMainland: boolean): string {
  const m = mode === 'walk' ? 'walk' : mode === 'transit' ? 'bus' : 'car';
  if (isMainland) {
    const to = dest.lng + ',' + dest.lat + ',' + encodeURIComponent(dest.name);
    const fromPart = from ? '&from=' + from.lng + ',' + from.lat + ',' + encodeURIComponent(from.name) : '';
    return 'https://uri.amap.com/navigation?to=' + to + fromPart + '&mode=' + m;
  }
  const to = dest.lat + ',' + dest.lng;
  const fromPart = from ? '&origin=' + from.lat + ',' + from.lng : '';
  const tm = mode === 'walk' ? 'walking' : mode === 'transit' ? 'transit' : 'driving';
  return 'https://www.google.com/maps/dir/?api=1' + fromPart + '&destination=' + to + '&travelmode=' + tm;
}

/** 路线工具实现：无 key 时给直线距离估算 + 高德/Google 深链；有 key 时用厂商路线 API。 */
/** OSRM（OpenStreetMap 数据）真实驾车路线：返回 {km, minutes}，失败/无结果返回 null。免费、无 key、全球。 */
async function osrmDrive(from: GeoPoint, to: GeoPoint): Promise<{ km: number; minutes: number } | null> {
  // OSRM 用 lon,lat 顺序
  const url =
    'https://router.project-osrm.org/route/v1/driving/' + from.lng + ',' + from.lat + ';' + to.lng + ',' + to.lat +
    '?overview=false&steps=false';
  const json = await fetchJson(url);
  const route = json?.routes?.[0];
  const distance = Number(route?.distance) || 0;
  const duration = Number(route?.duration) || 0;
  if (route && distance > 0) return { km: distance / 1000, minutes: Math.round(duration / 60) };
  return null;
}

export async function directions(args: any, ctx: ToolCtx = {}): Promise<string> {
  const destination = String(args?.destination || '').trim();
  const originStr = String(args?.origin || '').trim() || ctx.city || '';
  const mode = (args?.mode || 'driving').toLowerCase();
  const m = mode === 'walk' ? 'walk' : mode === 'transit' ? 'transit' : 'driving';
  if (!destination) return '请告诉我要去哪里（如「中环」「深圳湾」）。';

  const from = originStr ? await geocode(originStr, ctx) : null;
  const to = await geocode(destination, ctx);
  if (!to) return '没有找到「' + destination + '」的位置，请换更具体的地址试试。';

  const isMainland = !!ctx.isMainland;
  // 大陆 + 高德 key
  if (isMainland && AMAP_KEY && m !== 'transit') {
    const api = m === 'walk'
      ? 'https://restapi.amap.com/v3/direction/walking?origin=' + (from?.lng ?? '') + ',' + (from?.lat ?? '') + '&destination=' + to.lng + ',' + to.lat + '&key=' + AMAP_KEY
      : 'https://restapi.amap.com/v3/direction/driving?origin=' + (from?.lng ?? '') + ',' + (from?.lat ?? '') + '&destination=' + to.lng + ',' + to.lat + '&key=' + AMAP_KEY + '&extensions=base';
    const json = await fetchJson(api);
    const path = json?.route?.paths?.[0];
    if (path) {
      const km = fmtKm(Number(path.distance) || 0);
      const min = Math.round((Number(path.duration) || 0) / 60);
      return (
        '【路线】' + (from?.name || originStr || '当前位置') + ' → ' + to.name +
        '（' + m + '）\n· ' + km + '，约 ' + min + ' 分钟\n· 打开高德导航：' + mapDeepLink(m, to, from, true)
      );
    }
  }
  // 海外 / 大陆没高德 key + Google key
  if (GOOGLE_KEY) {
    const modeParam = m === 'walk' ? 'walking' : m === 'transit' ? 'transit' : 'driving';
    const o = from ? '&origin=' + from.lat + ',' + from.lng : '';
    const json = await fetchJson(
      'https://maps.googleapis.com/maps/api/directions/json?destination=' + to.lat + ',' + to.lng + o + '&mode=' + modeParam + '&key=' + GOOGLE_KEY
    );
    const leg = json?.routes?.[0]?.legs?.[0];
    if (leg) {
      return (
        '【路线】' + (leg.start_address || from?.name || originStr || '当前位置') + ' → ' + (leg.end_address || to.name) +
        '（' + m + '）\n· ' + (leg.distance?.text || '-') + '，约 ' + (leg.duration?.text || '-') +
        '\n· 打开 Google 地图：' + mapDeepLink(m, to, from, false)
      );
    }
  }
  // 免费：驾车用 OSRM 真实路线（更准），失败再退回直线估算
  if (from && to && m === 'driving') {
    const osrm = await osrmDrive(from, to);
    if (osrm) {
      const kmText = osrm.km >= 10 ? osrm.km.toFixed(0) + ' km' : osrm.km.toFixed(1) + ' km';
      const link = mapDeepLink(m, to, from, isMainland);
      return (
        '【路线】' + (from.name || originStr || '当前位置') + ' → ' + to.name + '（驾车）\n· 约 ' + kmText +
        ' / 约 ' + osrm.minutes + ' 分钟\n· 打开' + (isMainland ? '高德' : 'Google') + '导航：' + link
      );
    }
  }
  // 免费兜底：直线距离估算 + 深链
  if (from && to) {
    const meters = haversineMeters(from.lat, from.lng, to.lat, to.lng);
    // 直线距离约等于驾车距离的 ~1.2 倍，时速按城区 40km/h 粗略估算
    const driveKm = (meters / 1000) * 1.2;
    const min = Math.round((driveKm / 40) * 60);
    const link = mapDeepLink(m, to, from, isMainland);
    return (
      '【路线】' + (from.name || originStr) + ' → ' + to.name + '（' + m + '）\n· 直线约 ' + fmtKm(meters) +
      '，驾车粗略 ' + driveKm.toFixed(1) + ' km / 约 ' + min + ' 分钟（估算）\n· 打开' + (isMainland ? '高德' : 'Google') + '导航：' + link
    );
  }
  if (!from) {
    return '【路线】' + to.name + '\n· 打开' + (isMainland ? '高德' : 'Google') + '导航：' + mapDeepLink(m, to, null, isMainland);
  }
  return '没有找到「' + destination + '」的位置，请换更具体的地址试试。';
}

/** 地名 → 坐标（供模型回答「X 在哪 / 距离多远」等）。 */
export async function geocodeTool(args: any, ctx: ToolCtx = {}): Promise<string> {
  const address = String(args?.address || '').trim();
  if (!address) return '请告诉我要查询哪个地名/地址。';
  const loc = await geocode(address, ctx);
  if (!loc) return '没有找到「' + address + '」的位置，请换更具体的地名试试。';
  return '【坐标】' + loc.name + '\n· 纬度 ' + loc.lat.toFixed(5) + '，经度 ' + loc.lng.toFixed(5);
}

/**
 * 运行一个生活工具。name ∈ get_weather | get_directions | geocode。
 * 返回用户可读文本摘要；异常一律吞掉返回友好错误，绝不让聊天失败。
 */
export async function runLifeTool(name: string, rawArgs: any, ctx?: ToolCtx): Promise<string> {
  let args: any = {};
  if (typeof rawArgs === 'string') {
    try { args = JSON.parse(rawArgs || '{}'); } catch { args = {}; }
  } else if (rawArgs && typeof rawArgs === 'object') {
    args = rawArgs;
  }
  try {
    if (name === 'get_weather') return await weatherNow(args, ctx);
    if (name === 'get_directions') return await directions(args, ctx);
    if (name === 'geocode') return await geocodeTool(args, ctx);
    return '未知的工具：' + name;
  } catch (e) {
    console.warn('⚠️ [lifeTools] ' + name + ' 执行失败:', (e as Error)?.message || e);
    return '这项能力暂时不可用，请稍后再试。';
  }
}

// ===================== tool schemas（OpenAI function 格式） =====================

const getWeatherSchema = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: '查询某地/当前城市的天气实况与今明后三天预报（温度、天气现象、降水概率、湿度、风速）。查「今天天气/下雨吗/要不要带伞/明天冷不冷」时调用。location 传城市/地名；不传则用用户当前城市。',
    parameters: {
      type: 'object',
      properties: {
        location: { type: 'string', description: '城市或地名，如「北京」「尖沙咀」"Hong Kong"。可省略。' },
        date: { type: 'string', enum: ['today', 'tomorrow'], description: '今天或明天；缺省今天。' },
      },
      required: [],
    },
  },
};

const getDirectionsSchema = {
  type: 'function',
  function: {
    name: 'get_directions',
    description: '查询从起点到终点的路线（驾车/步行/公交），返回距离、耗时并给出打开高德/Google 地图导航的链接。查「怎么去/从A到B/多远/要多久」时调用。',
    parameters: {
      type: 'object',
      properties: {
        origin: { type: 'string', description: '起点城市/地名，如「尖沙咀」「深圳」；可省略（缺省用用户当前城市）。' },
        destination: { type: 'string', description: '目的地城市/地名，必填，如「中环」「北京南站」。' },
        mode: { type: 'string', enum: ['driving', 'walking', 'transit'], description: '出行方式：driving=驾车、walking=步行、transit=公交。' },
      },
      required: ['destination'],
    },
  },
};

const geocodeSchema = {
  type: 'function',
  function: {
    name: 'geocode',
    description: '把地名/地址解析为经纬度，用于回答「X 在哪 / 距离大概多远」。',
    parameters: {
      type: 'object',
      properties: {
        address: { type: 'string', description: '城市/地名/地址，如「杭州西湖」「Central Hong Kong」。' },
      },
      required: ['address'],
    },
  },
};

/** 暴露给聊一聊工具循环的工具清单。 */
export const LIFE_TOOLS = [getWeatherSchema, getDirectionsSchema, geocodeSchema];
