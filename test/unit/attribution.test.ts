/**
 * 来源归因单元测试
 *
 * 覆盖两条链路：
 *  ① 客户端纯函数（referrer 分类 / 触点解析 / 触点路径去重截断）——归因最容易脏的地方
 *  ② 服务端 store（first-touch 不被覆盖 / 注册时按设备 stitch 到账号 / 聚合口径 / 不写假数据）
 * 数据隔离遵循仓库约定：先 setupTempCwd() 再动态 import store（store 在 import 时按 cwd 定位 data/）。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';
import {
  classifyReferrer,
  parseTouch,
  mergeTouchPath,
  touchKey,
  TOUCH_PATH_CAP,
} from '../../src/lib/attribution.js';

setupTempCwd();
const { attributionStore } = await import('../../api/services/attribution.js');

const SELF = 'myxiaoyu.com';

test('classifyReferrer：自家域 / OAuth / 结账 / 本地 → 空（记 direct），外部站 → 主机名', () => {
  assert.strictEqual(classifyReferrer('https://myxiaoyu.com/faq', SELF), '');
  assert.strictEqual(classifyReferrer('https://www.myxiaoyu.com/x', SELF), '');
  assert.strictEqual(classifyReferrer('https://accounts.google.com/o/oauth2', SELF), '');
  assert.strictEqual(classifyReferrer('https://checkout.stripe.com/c/pay', SELF), '');
  assert.strictEqual(classifyReferrer('http://localhost:5173/', SELF), '');
  assert.strictEqual(classifyReferrer('', SELF), '');
  assert.strictEqual(classifyReferrer('not a url', SELF), '');
  assert.strictEqual(classifyReferrer('https://www.reddit.com/r/selfimprovement', SELF), 'www.reddit.com');
  assert.strictEqual(classifyReferrer('https://l.instagram.com/?u=x', SELF), 'l.instagram.com');
});

test('parseTouch：utm_source 优先，其次 referrer 主机，都没有则 direct；全部小写', () => {
  const withUtm = parseTouch({ search: '?utm_source=IG&utm_medium=Social&utm_campaign=Launch', referrer: 'https://www.reddit.com/x', path: '/ai-roleplay', now: 1700000000000 });
  assert.strictEqual(withUtm.source, 'ig');
  assert.strictEqual(withUtm.medium, 'social');
  assert.strictEqual(withUtm.campaign, 'launch');
  assert.strictEqual(withUtm.refHost, 'www.reddit.com');
  assert.strictEqual(withUtm.path, '/ai-roleplay');
  assert.strictEqual(withUtm.at, 1700000000000);

  const refOnly = parseTouch({ search: '', referrer: 'https://news.ycombinator.com/item?id=1' });
  assert.strictEqual(refOnly.source, 'news.ycombinator.com');
  assert.strictEqual(refOnly.medium, '');

  // 无任何线索（DM/群聊/截图会剥掉 referrer）→ direct，这是垃圾桶但也必须如实记
  const nothing = parseTouch({ search: '', referrer: '' });
  assert.strictEqual(nothing.source, 'direct');
  assert.strictEqual(nothing.refHost, '');
});

test('mergeTouchPath：同触点不重复追加、保序、超上限截断', () => {
  const a = parseTouch({ search: '?utm_source=ig', referrer: '', path: '/', now: 1 });
  const b = parseTouch({ search: '?utm_source=xhs', referrer: '', path: '/zh/ai-roleplay', now: 2 });
  let list: ReturnType<typeof parseTouch>[] = [];
  list = mergeTouchPath(list, a);
  list = mergeTouchPath(list, a); // 同一触点（刷新页面）不应变成两条
  list = mergeTouchPath(list, b);
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].source, 'ig');
  assert.strictEqual(list[1].source, 'xhs');
  assert.strictEqual(touchKey(a), touchKey({ ...a, at: 999 })); // 时间不参与判重

  for (let i = 0; i < TOUCH_PATH_CAP + 5; i++) {
    list = mergeTouchPath(list, parseTouch({ search: `?utm_source=s${i}`, referrer: '', path: `/p${i}` }));
  }
  assert.strictEqual(list.length, TOUCH_PATH_CAP);
  assert.strictEqual(list[list.length - 1].source, `s${TOUCH_PATH_CAP + 4}`);
});

test('serve：first-touch 一旦确立就不再被后续触点覆盖，路径逐条累积', () => {
  const dev = 'dev-alpha';
  attributionStore.recordTouch(dev, { source: 'ig', medium: 'social', campaign: 'launch', refHost: 'l.instagram.com', path: '/', at: 1 });
  attributionStore.recordTouch(dev, { source: 'direct', medium: '', campaign: '', refHost: '', path: '/zh/ai-roleplay', at: 2 });

  const agg = attributionStore.aggregates();
  const ig = agg.rows.find((r) => r.source === 'ig');
  assert.ok(ig, '设备 first-touch 应归到 ig');
  assert.strictEqual(ig!.devices, 1);
  // direct 只作为「第二个触点」存在时，不应被算成一台新设备的来源
  assert.strictEqual(agg.rows.find((r) => r.source === 'direct')?.devices ?? 0, 0);
});

test('serve：注册时把设备 first-touch stitch 到账号（客户端 first 优先）', () => {
  attributionStore.recordTouch('dev-beta', { source: 'xhs', medium: 'social', campaign: 'note-01', path: '/', at: 1 });
  const rec = attributionStore.recordSignup('user-beta', 'dev-beta');
  assert.ok(rec, '有设备触点时应能为账号建立归因');
  assert.strictEqual(rec!.first.source, 'xhs');
  assert.strictEqual(rec!.heardFrom, null);

  // 客户端带来的 first 优先于服务端记录（它在落地那一刻就记下了，最可信）
  const rec2 = attributionStore.recordSignup('user-gamma', 'dev-gamma', {
    first: { source: 'ig', medium: 'social', campaign: 'reel-3', path: '/talk-to-someone-at-night' },
    path: [{ source: 'ig', medium: 'social', campaign: 'reel-3', path: '/talk-to-someone-at-night' }],
  });
  assert.strictEqual(rec2!.first.source, 'ig');
  assert.strictEqual(rec2!.first.campaign, 'reel-3');

  // 既无设备记录、又无客户端数据 → 不写记录（宁缺勿假，不制造 direct 噪音）
  assert.strictEqual(attributionStore.recordSignup('user-nothing', 'dev-unknown'), null);
  assert.strictEqual(attributionStore.getByUser('user-nothing'), null);
});

test('serve：聚合口径 —— 注册/付费按 first-touch 归因，付费集由订单传入', () => {
  const agg = attributionStore.aggregates(new Set(['user-beta']));
  assert.strictEqual(agg.totals.devices >= 2, true);
  const xhs = agg.rows.find((r) => r.source === 'xhs');
  assert.ok(xhs, 'xhs 行应存在');
  assert.strictEqual(xhs!.signups, 1);
  assert.strictEqual(xhs!.paidUsers, 1);
  const ig = agg.rows.find((r) => r.source === 'ig');
  assert.strictEqual(ig!.signups, 1);
  assert.strictEqual(ig!.paidUsers, 0);
  // 行按注册数降序：有人注册的渠道排在没有注册的渠道前面
  const firstNoSignup = agg.rows.findIndex((r) => r.signups === 0);
  const lastWithSignup = agg.rows.map((r) => r.signups > 0).lastIndexOf(true);
  if (firstNoSignup !== -1) assert.ok(lastWithSignup < firstNoSignup, '有注册的行应排在无注册行之前');
});

test('serve：清洗 —— 注入字符/超长字段被剥离，且不存任何 PII 字段', () => {
  attributionStore.recordTouch('dev-dirty', {
    source: '<script>alert(1)</script>IG',
    medium: 'x'.repeat(200),
    campaign: 'a\nb\tc',
    path: '/ok?token=secret',
    email: 'someone@example.com',
    ip: '1.2.3.4',
  });
  const agg = attributionStore.aggregates();
  const row = agg.rows.find((r) => r.source.includes('ig'));
  assert.ok(row, '清洗后仍应保留可读的来源标识');
  assert.ok(!row!.source.includes('<') && !row!.source.includes('>'), '尖括号应被剥离');
  assert.ok(row!.medium.length <= 32, 'medium 应被截断');
  assert.ok(!row!.campaign.includes('\n') && !row!.campaign.includes('\t'), '控制字符应被剥离');
  // 记录里不应出现 email / ip 字段（本模块只存渠道维度）
  const raw = JSON.stringify(attributionStore.aggregates());
  assert.ok(!raw.includes('someone@example.com'), '不应存邮箱');
  assert.ok(!raw.includes('1.2.3.4'), '不应存 IP');
});

test('serve：四维度 —— first-touch / last-touch / 首次落地页（并排看，差额即结论）', () => {
  const dev = 'dev-dim';
  attributionStore.recordTouch(dev, { source: 'ig', medium: 'social', campaign: 'reel-1', path: '/ai-roleplay', at: 1 });
  attributionStore.recordTouch(dev, { source: 'google', medium: 'organic', campaign: '', path: '/can-ai-be-a-therapist', at: 2 });
  const rec = attributionStore.recordSignup('user-dim', dev);
  assert.strictEqual(rec!.first!.source, 'ig', 'first-touch 应是第一次落地那个渠道');

  const agg = attributionStore.aggregates();
  const first = agg.rows.find((r) => r.source === 'ig' && r.campaign === 'reel-1');
  const last = agg.lastTouchRows.find((r) => r.source === 'google');
  assert.ok(first && first.signups === 1, 'first-touch 维度应把这次注册归到 ig');
  assert.ok(last && last.signups === 1, 'last-touch 维度应把同一次注册归到 google');
  assert.ok(
    !agg.rows.some((r) => r.source === 'google' && r.signups > 0),
    'first-touch 维度不应把这次注册算给 google（两个口径必须分开）'
  );

  const landing = agg.landingRows.find((r) => r.path === '/ai-roleplay');
  assert.ok(landing && landing.signups === 1, '首次落地页维度应记到 /ai-roleplay');
  assert.strictEqual(landing!.devices >= 1, true);
});

test('serve：自报来源（无任何旅程数据也能记，basis=self-report）', () => {
  const rec = attributionStore.recordSignup('user-heard', 'dev-heard-unknown', { heardFrom: 'friend' });
  assert.ok(rec, '只有自报来源时也应记一条');
  assert.strictEqual(rec!.basis, 'self-report');
  assert.strictEqual(rec!.first, null, '没有旅程数据时 first 应为 null（不编造 direct）');

  const agg = attributionStore.aggregates();
  assert.strictEqual(agg.heardFromRows.find((r) => r.label === 'friend')?.accounts, 1);
  assert.strictEqual(agg.totals.selfReportedSignups >= 1, true);
  assert.ok(!agg.rows.some((r) => r.source === 'friend'), '自报来源不能混进 first-touch 渠道表');

  // 既没旅程也没自报 → 依然不写
  assert.strictEqual(attributionStore.recordSignup('user-none-2', 'dev-none-2'), null);
});

test('serve：noteHeardFrom 可给已有旅程记录补自报来源，且不降级 basis', () => {
  attributionStore.recordSignup('user-later', 'dev-dim');
  assert.strictEqual(attributionStore.noteHeardFrom('user-later', 'xiaohongshu'), true);
  assert.strictEqual(attributionStore.getByUser('user-later')?.heardFrom, 'xiaohongshu');
  assert.strictEqual(attributionStore.getByUser('user-later')?.basis, 'journey', '旅程数据仍在，依据不应被降级');
  assert.strictEqual(attributionStore.noteHeardFrom('user-nope', 'x'), false, '不存在的账号应返回 false');
});
