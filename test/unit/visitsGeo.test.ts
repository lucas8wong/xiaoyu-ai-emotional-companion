/**
 * visits v5 单元测试（访问地区分布）
 * - v4 → v5 迁移：geoDaily 缺省为空，daily/hourly 原样保留
 * - recordVisit 携带 geo：落盘 v5 geoDaily，getGeoVisits 按设备返回一行
 * - 多天聚合：同设备跨天取最近一天快照；无 geo 的设备不进地区统计
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJson, readJson } from '../../api/storage/persistence.js';
import { VisitStore } from '../../api/services/visits.js';
import { selfExcludeStore } from '../../api/services/selfExclude.js';

/** 与 visits.ts 一致的香港时区日期键（UTC+8，无夏令时） */
function hkDateKey(offsetDays = 0): string {
  const t = new Date(Date.now() + 8 * 3600 * 1000 + offsetDays * 86400000);
  const y = t.getUTCFullYear();
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function tmpFile(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'visits-')), name);
}

test('v4 → v5 迁移：geoDaily 缺省为空，daily/hourly 原样保留', () => {
  const file = tmpFile('visits-v4.json');
  const today = hkDateKey();
  const yesterday = hkDateKey(-1);
  writeJson(file, {
    version: 4,
    visitors: [{ id: 'devA', firstDate: yesterday }, { id: 'devB', firstDate: today }],
    daily: { [yesterday]: ['devA'], [today]: ['devB'] },
    hourly: { [yesterday]: { '10': ['devA'] } },
  });
  const store = new VisitStore(file);
  assert.strictEqual(store.getVisitCount(), 2);
  const daily = store.getDailyVisits(1);
  assert.strictEqual(daily[daily.length - 1].count, 1, 'daily 应原样保留（今天 1 台设备）');
  assert.strictEqual(store.getGeoVisits(30).length, 0, 'v4 无 geoDaily，地区统计应为空');
});

test('recordVisit 携带 geo：落盘 v5 geoDaily，getGeoVisits 按设备返回一行', () => {
  const file = tmpFile('visits-v5.json');
  const store = new VisitStore(file);
  store.recordVisit('devA', { ip: '1.2.3.4', country: '香港', region: '', city: '香港', isp: 'HKBN' });
  store.recordVisit('devB', { ip: '8.8.8.8', country: '美国', region: '', city: '', isp: 'Google' });
  const rows = store.getGeoVisits(1);
  assert.strictEqual(rows.length, 2, '两台设备各一行');
  const a = rows.find(r => r.deviceId === 'devA')!;
  assert.strictEqual(a.ip, '1.2.3.4');
  assert.strictEqual(a.country, '香港');
  assert.strictEqual(a.isp, 'HKBN');
  // 落盘格式 v5 + geoDaily
  const saved = readJson<any>(file, null);
  assert.strictEqual(saved.version, 5);
  assert.ok(saved.geoDaily && typeof saved.geoDaily === 'object');
});

test('多天聚合：同设备跨天取最近一天快照；无 geo 的设备不进地区统计', () => {
  const file = tmpFile('visits-v5b.json');
  const today = hkDateKey();
  const yesterday = hkDateKey(-1);
  // 手工构造 v5：devX 昨天在香港、今天在美国 → 取今天；devY 有 daily 但无 geo → 不统计
  writeJson(file, {
    version: 5,
    visitors: [{ id: 'devX', firstDate: yesterday }, { id: 'devY', firstDate: yesterday }],
    daily: { [yesterday]: ['devX', 'devY'], [today]: ['devX'] },
    hourly: {},
    geoDaily: {
      [yesterday]: { devX: { ip: '1.2.3.4', country: '香港', region: '', city: '', isp: '' } },
      [today]: { devX: { ip: '9.9.9.9', country: '美国', region: '', city: '', isp: 'Google' } },
    },
  });
  const store = new VisitStore(file);
  const rows = store.getGeoVisits(7);
  assert.strictEqual(rows.length, 1, 'devY 无 geo 不进统计；devX 跨天去重为 1');
  assert.strictEqual(rows[0].deviceId, 'devX');
  assert.strictEqual(rows[0].country, '美国', '应取最近一天（今天）的快照');
  assert.strictEqual(rows[0].ip, '9.9.9.9');
});

test('recordVisit 不带 geo：仅计设备数，不进 geoDaily', () => {
  const file = tmpFile('visits-nogeo.json');
  const store = new VisitStore(file);
  store.recordVisit('devZ');
  assert.strictEqual(store.getVisitCount(), 1);
  assert.strictEqual(store.getGeoVisits(1).length, 0);
});

test('recordVisit 命中自排除 IP：不计访客/地区；未排除的正常计入', () => {
  const file = tmpFile('visits-selfexclude.json');
  const store = new VisitStore(file);
  selfExcludeStore.reset();
  selfExcludeStore.add('9.9.9.9'); // 公开、非测试/内网 IP，仅因自排除而跳过
  try {
    store.recordVisit('devSelf', { ip: '9.9.9.9', country: '美国', region: '', city: '', isp: 'Google' });
    assert.strictEqual(store.getVisitCount(), 0, '自排除 IP 不计独立访客');
    assert.strictEqual(store.getGeoVisits(1).length, 0, '自排除 IP 不进地区统计');
    // 未排除的公开 IP 正常计入
    store.recordVisit('devReal', { ip: '8.8.8.8', country: '美国', region: '', city: '', isp: 'Google' });
    assert.strictEqual(store.getVisitCount(), 1, '未排除 IP 仍正常计入');
    assert.strictEqual(store.getGeoVisits(1).length, 1);
  } finally {
    selfExcludeStore.reset();
  }
});
