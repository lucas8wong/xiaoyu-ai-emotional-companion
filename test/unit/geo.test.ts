/**
 * geo 修复单元测试（P1：国家码优先识别海外）
 * - countryCodeToName：ISO → 中文
 * - lookupIp：国家码优先（海外不再依赖 ip2region 错标）、大陆码走省份细分、未知/内网语义
 * - getClientCountry：Cloudflare/Vercel 国家头
 * - getClientIp：代理/CDN 头优先取真实公网 IP（解决地区分布显示「本地/内网」）
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { lookupIp, countryCodeToName, getClientCountry, getClientIp } from '../../api/services/geo.js';

test('countryCodeToName：ISO 码 → 中文名（未收录返回原码）', () => {
  assert.strictEqual(countryCodeToName('US'), '美国');
  assert.strictEqual(countryCodeToName('gb'), '英国'); // 大小写不敏感
  assert.strictEqual(countryCodeToName('HK'), '香港');
  assert.strictEqual(countryCodeToName('TW'), '台湾');
  assert.strictEqual(countryCodeToName('XX'), 'XX');
  assert.strictEqual(countryCodeToName(''), '');
});

test('lookupIp：国家码优先（海外准确，不依赖 ip2region 海外错标）', () => {
  // 1.1.1.1 在 ip2region 中被错标为澳大利亚；带 US 码时必须为美国
  const us = lookupIp('1.1.1.1', 'US');
  assert.strictEqual(us.country, '美国');
  assert.strictEqual(us.isPrivate, false);
  // UK IPv6 在 ip2region 中被错标为德国；带 GB 码必须为英国
  assert.strictEqual(lookupIp('2a00:1450:4001:820::200e', 'GB').country, '英国');
  // 港澳台
  assert.strictEqual(lookupIp('1.2.3.4', 'HK').country, '香港');
  assert.strictEqual(lookupIp('1.2.3.4', 'TW').country, '台湾');
});

test('lookupIp：中国大陆码走 ip2region 省份细分', () => {
  const cn = lookupIp('114.114.114.114', 'CN');
  assert.strictEqual(cn.country, '中国大陆');
  assert.strictEqual(cn.region, '江苏', '应细分为省份（去「省」后缀）');
});

test('lookupIp：内网/空值/未知语义', () => {
  assert.strictEqual(lookupIp('192.168.1.1', 'US').country, '本地/内网');
  const empty = lookupIp('', 'US');
  assert.strictEqual(empty.country, '未知');
  assert.strictEqual(empty.isPrivate, false, '未知不应标记为私网（统计需保留为桶）');
});

test('getClientCountry：读取代理国家头（优先 cf-ipcountry）', () => {
  assert.strictEqual(getClientCountry({ headers: { 'cf-ipcountry': 'gb' } } as any), 'GB');
  assert.strictEqual(getClientCountry({ headers: { 'x-vercel-ip-country': 'us' } } as any), 'US');
  assert.strictEqual(getClientCountry({ headers: {} } as any), undefined);
});

test('getClientIp：代理头优先取第一个公网地址（地区分布修复）', () => {
  // x-forwarded-for = 客户公网 + 代理内网 → 取公网
  assert.strictEqual(
    getClientIp({ headers: { 'x-forwarded-for': '8.8.8.8, 192.168.1.1' }, ip: '192.168.1.10', socket: { remoteAddress: '192.168.1.10' } } as any),
    '8.8.8.8'
  );
  // cf-connecting-ip 优先于 x-forwarded-for
  assert.strictEqual(
    getClientIp({ headers: { 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '9.9.9.9' }, ip: '' } as any),
    '1.1.1.1'
  );
  // ::ffff: 前缀应被剥掉
  assert.strictEqual(
    getClientIp({ headers: { 'x-forwarded-for': '::ffff:8.8.8.8' }, ip: '' } as any),
    '8.8.8.8'
  );
});

test('getClientIp：全部内网时回退 req.ip（不再当作真实访客公网）', () => {
  const req = { headers: { 'x-forwarded-for': '192.168.1.5, 10.0.0.1' }, ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' } } as any;
  const ip = getClientIp(req);
  // 无公网地址 → 回退第一个（内网）地址，交由 lookupIp 判为「本地/内网」
  assert.strictEqual(ip, '192.168.1.5');
  assert.strictEqual(ip.includes('.'), true);
});

test('getClientIp：无代理头时用 req.ip / socket 兜底', () => {
  assert.strictEqual(getClientIp({ headers: {}, ip: '1.2.3.4', socket: { remoteAddress: '1.2.3.4' } } as any), '1.2.3.4');
  assert.strictEqual(getClientIp({ headers: {}, ip: '', socket: {} } as any), '');
});
