import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// 让 lifeTools 以「未配 key」状态加载（决定数据源/降级），保证测试确定性
process.env.AMAP_API_KEY = '';
process.env.GOOGLE_MAPS_API_KEY = '';

let lifeTools: typeof import('../../api/services/lifeTools.js');

// mock fetch：按 URL 返回对应 JSON，用于覆盖 geocode / 天气 / 未知地名
const ORIGINAL_FETCH = globalThis.fetch;
function mockFetch(routes: (url: string) => any) {
  (globalThis as any).fetch = async (url: string) => {
    const data = routes(String(url));
    if (data === null || data === undefined) return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => data };
  };
}

before(async () => {
  lifeTools = await import('../../api/services/lifeTools.js');
});
after(() => {
  (globalThis as any).fetch = ORIGINAL_FETCH;
});

const NOMINATIM = [{
  lat: '39.9', lon: '116.4', display_name: '北京市 东城区',
}];

const OPEN_METEO = {
  current: { temperature_2m: 25, relative_humidity_2m: 50, apparent_temperature: 26, precipitation: 0, weather_code: 0, wind_speed_10m: 12 },
  daily: {
    time: ['2026-09-02', '2026-09-03', '2026-09-04'],
    temperature_2m_min: [18, 19, 20],
    temperature_2m_max: [26, 27, 28],
    precipitation_probability_max: [10, 20, 30],
    weather_code: [0, 1, 2],
  },
};

test('weatherNow 用 Nominatim 定位 + Open-Meteo 返回天气摘要', async () => {
  const urls: string[] = [];
  mockFetch((url) => {
    urls.push(url);
    if (url.includes('nominatim.openstreetmap.org')) return NOMINATIM;
    if (url.includes('api.open-meteo.com')) return OPEN_METEO;
    return null;
  });
  const out = await lifeTools.weatherNow({ location: '北京' }, { isMainland: true, city: '', lang: 'zh-CN' });
  assert.match(out, /天气/);
  assert.match(out, /北京市|北京/);
  assert.match(out, /今天/);
  assert.ok(urls.some((u) => u.includes('open-meteo')), '应请求 Open-Meteo');
});

test('weatherNow 未提供城市且无兜底 → 提示补城市', async () => {
  const out = await lifeTools.weatherNow({}, { isMainland: true, city: '', lang: 'zh-CN' });
  assert.match(out, /城市|位置/);
});

test('directions 无 key → 给出直线估算 + 高德深链（大陆）', async () => {
  mockFetch((url) => (url.includes('nominatim.openstreetmap.org') ? NOMINATIM : null));
  const out = await lifeTools.directions({ origin: '北京', destination: '上海', mode: 'driving' }, { isMainland: true, city: '', lang: 'zh-CN' });
  assert.match(out, /路线/);
  assert.match(out, /高德/);
  assert.match(out, /uri\.amap\.com/);
});

test('directions 无 key → 给出 Google 深链（海外）', async () => {
  mockFetch((url) => (url.includes('nominatim.openstreetmap.org') ? NOMINATIM : null));
  const out = await lifeTools.directions({ origin: 'Central', destination: 'Causeway Bay', mode: 'transit' }, { isMainland: false, city: '', lang: 'en' });
  assert.match(out, /Google/);
  assert.match(out, /google\.com\/maps/);
});

test('geocode 未找到地名 → 友好提示', async () => {
  mockFetch(() => []);
  const out = await lifeTools.geocodeTool({ address: '不存在的地方xyz' }, { isMainland: true });
  assert.match(out, /没有找到|换更具体/);
});

test('runLifeTool 未知工具名 → 友好提示', async () => {
  const out = await lifeTools.runLifeTool('foo', {}, {});
  assert.match(out, /未知的工具/);
});

test('directions 无 key → 驾车用 OSRM 真实距离（不再直线估算）', async () => {
  mockFetch((url) => {
    if (url.includes('nominatim.openstreetmap.org')) return NOMINATIM;
    if (url.includes('router.project-osrm.org')) return { routes: [{ distance: 8200, duration: 660 }] };
    return null;
  });
  const out = await lifeTools.directions({ origin: '北京', destination: '上海', mode: 'driving' }, { isMainland: true, city: '', lang: 'zh-CN' });
  assert.match(out, /路线/);
  assert.match(out, /8\.2\s*km/);   // OSRM 距离 8.2km
  assert.match(out, /11\s*分钟/);    // OSRM 时长 11min
  assert.match(out, /高德/);
});
