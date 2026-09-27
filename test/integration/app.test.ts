import { test, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 数据隔离：必须在 import app 之前 chdir 并设置环境变量（store 单例在 import 时用 cwd 定位 data/）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cure-it-'));
process.chdir(tmp);
process.env.ADMIN_TOKEN = 'test-admin-token';
process.env.NODE_ENV = 'test';
// 预设邀请码在模块加载时解析（数据目录是临时目录，没有 .env）→ 必须在 import app 之前设好
process.env.INVITE_CODES = 'itestcode:20';

const { default: app } = await import('../../api/app.js');
const { emailCodeStore } = await import('../../api/services/email.js');
const { memoryStorage } = await import('../../api/storage/memory.js');
const { usageStore } = await import('../../api/services/usage.js');
const { subscriptionStore } = await import('../../api/services/subscription.js');
const { roleplaySessionStore } = await import('../../api/services/roleplaySessions.js');

let server: import('node:http').Server;
let baseUrl = '';

before(async () => {
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const addr = server.address() as { port: number };
  baseUrl = 'http://127.0.0.1:' + addr.port;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function req(method: string, path: string, opts: { body?: unknown; token?: string; headers?: Record<string, string> } = {}) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Device-Id': 'itest-device-1',
      ...(opts.token ? { Authorization: 'Bearer ' + opts.token } : {}),
      ...(opts.headers || {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let json: unknown = null;
  try { json = await res.json(); } catch { /* 非 JSON */ }
  // 测试助手的宽松类型：断言处按需访问字段
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, json: json as any };
}

test('注册 → 登录 → me 全链路', async () => {
  const email = 'itest@example.com';
  const code = emailCodeStore.generate(email, 'register'); // 进程内生成验证码，绕过 send-code 限流
  const reg = await req('POST', '/api/auth/register', { body: { username: 'itest', email, password: 'pass123', code } });
  assert.strictEqual(reg.status, 200, JSON.stringify(reg.json));
  assert.ok(reg.json.data.token, '注册应返回 token');
  const token = reg.json.data.token;

  const me = await req('GET', '/api/auth/me', { token });
  assert.strictEqual(me.status, 200);
  assert.strictEqual(me.json.data.user.username, 'itest');

  const login = await req('POST', '/api/auth/login', { body: { account: email, password: 'pass123' } });
  assert.strictEqual(login.status, 200);

  const bad = await req('POST', '/api/auth/login', { body: { account: email, password: 'wrong' } });
  assert.strictEqual(bad.status, 401);
});

test('未登录访问 me 返回 401', async () => {
  const r = await req('GET', '/api/auth/me');
  assert.strictEqual(r.status, 401);
});
// —— 注册后补填邀请码（2026-09）：路由全链路（未登录 / 无效码 / 到账 / 一人一次 / 入口标记）——
test('补填邀请码：注册后补填到账，重复与无效码被拒，quota 暴露 inviteCode', async () => {
  // 直接建账号发 token（不走 /api/auth/register，避免吃掉该 IP 每小时 15 次的注册限流额度）
  const { accountStore } = await import('../../api/services/accounts.js');
  const reg = accountStore.register({ username: 'itest-invite', email: 'itest-invite@example.com', password: 'pass123' });
  assert.ok(reg.user, JSON.stringify(reg));
  const token = accountStore.createToken(reg.user!.userId);

  // 补填前：quota 里 inviteCode=null（前端据此显示「有邀请码？」入口）
  const q1 = await req('GET', '/api/payment/quota', { token });
  assert.strictEqual(q1.status, 200);
  assert.strictEqual(q1.json.data.inviteCode, null, '未补填时 inviteCode 应为 null');

  // 无效码：400 + 业务码（前端据此出本地化文案）
  const bad = await req('POST', '/api/referral/invite-code', { token, body: { code: 'no-such-code' } });
  assert.strictEqual(bad.status, 400, JSON.stringify(bad.json));
  assert.strictEqual(bad.json.code, 'INVITE_CODE_INVALID');

  // 有效码：大小写不敏感，发放来自 INVITE_CODES，回写小写码
  const ok = await req('POST', '/api/referral/invite-code', { token, body: { code: 'ITESTCODE' } });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.json));
  assert.strictEqual(ok.json.data.bonus, 20, '额度取自 INVITE_CODES 配置');
  assert.strictEqual(ok.json.data.code, 'itestcode');

  // 到账 + 入口应立即隐藏（quota 暴露 inviteCode）
  const q2 = await req('GET', '/api/payment/quota', { token });
  assert.strictEqual(q2.json.data.inviteCode, 'itestcode', '补填后 quota 应暴露已用码 → 入口隐藏');
  assert.ok(q2.json.data.pendingReward && q2.json.data.pendingReward.count >= 20, '应入账待通知奖励');

  // 一人一次
  const dup = await req('POST', '/api/referral/invite-code', { token, body: { code: 'itestcode' } });
  assert.strictEqual(dup.status, 400, JSON.stringify(dup.json));
  assert.strictEqual(dup.json.code, 'INVITE_CODE_USED');

  // 未登录：游客补填不算（与「邀请人须为账号」同口径）
  const anon = await req('POST', '/api/referral/invite-code', { body: { code: 'itestcode' } });
  assert.strictEqual(anon.status, 401, JSON.stringify(anon.json));
  assert.strictEqual(anon.json.code, 'NOT_LOGGED_IN');
});

test('配额：游客获得 userId，聊一聊失败回滚不扣额度', async () => {
  const q1 = await req('GET', '/api/payment/quota');
  assert.strictEqual(q1.status, 200);
  assert.ok(q1.json.data.userId, '应返回解析后的 userId');
  const remainBefore = q1.json.data.chatFreeRemain;

  // 无 DEEPSEEK_API_KEY 时 chat 应失败，且回滚已扣额度
  const chat = await req('POST', '/api/analysis/chat', { body: { message: '你好' } });
  assert.strictEqual(chat.status, 500);

  const q2 = await req('GET', '/api/payment/quota');
  assert.strictEqual(q2.json.data.chatFreeRemain, remainBefore, '失败后应回滚额度');
});

test('聊一聊对话：置顶后列表排最前，取消置顶恢复时间排序', async () => {
  // 注册用户（会话归属用它的 userId）；用独立设备 ID，避免与前面游客测试的会话归并进来
  const dev = { 'X-Device-Id': 'pin-device-1' };
  const email = 'pin@example.com';
  const code = emailCodeStore.generate(email, 'register');
  const reg = await req('POST', '/api/auth/register', { body: { username: 'pinuser', email, password: 'pass123', code }, headers: dev });
  assert.strictEqual(reg.status, 200, JSON.stringify(reg.json));
  const token = reg.json.data.token;
  const quota = await req('GET', '/api/payment/quota', { token, headers: dev });
  const userId = quota.json.data.userId;
  assert.ok(userId, '应拿到 userId');

  // 直接向存储层塞两个会话（避免调用 AI）
  const mk = (sid: string, title: string, minutesAgo: number) => {
    memoryStorage.createSession(sid);
    memoryStorage.updateSession(sid, {
      userId,
      chatMessages: [{ role: 'user', content: title, timestamp: new Date(Date.now() - minutesAgo * 60000) }],
      chatTitle: title,
      chatUpdatedAt: new Date(Date.now() - minutesAgo * 60000),
    });
  };
  mk('pin-s1', '旧会话', 120);
  mk('pin-s2', '新会话', 10);

  const list1 = await req('GET', '/api/analysis/chats', { token, headers: dev });
  assert.strictEqual(list1.status, 200);
  assert.deepStrictEqual(list1.json.data.map((c: { sessionId: string }) => c.sessionId), ['pin-s2', 'pin-s1'], '默认按最近更新倒序');

  // 置顶旧会话 → 排到最前
  const pin = await req('PATCH', '/api/analysis/chats/pin-s1', { token, body: { pinned: true }, headers: dev });
  assert.strictEqual(pin.status, 200, JSON.stringify(pin.json));
  assert.strictEqual(pin.json.data.pinned, true);
  const list2 = await req('GET', '/api/analysis/chats', { token, headers: dev });
  assert.deepStrictEqual(list2.json.data.map((c: { sessionId: string }) => c.sessionId), ['pin-s1', 'pin-s2'], '置顶会话排最前');
  assert.strictEqual(list2.json.data[0].pinned, true, '置顶会话应带 pinned 标记');

  // 取消置顶 → 恢复按时间倒序
  const unpin = await req('PATCH', '/api/analysis/chats/pin-s1', { token, body: { pinned: false }, headers: dev });
  assert.strictEqual(unpin.status, 200, JSON.stringify(unpin.json));
  const list3 = await req('GET', '/api/analysis/chats', { token, headers: dev });
  assert.deepStrictEqual(list3.json.data.map((c: { sessionId: string }) => c.sessionId), ['pin-s2', 'pin-s1'], '取消置顶恢复时间排序');
  assert.strictEqual(list3.json.data[0].pinned, false);

  // 清理测试会话
  memoryStorage.deleteSession('pin-s1');
  memoryStorage.deleteSession('pin-s2');
});

test('支付：配置/下单/确认/状态查询', async () => {
  const cfg = await req('GET', '/api/payment/config');
  assert.strictEqual(cfg.status, 200);
  assert.ok(cfg.json.data.pricing.plans.plus.usd > 0);

  const order = await req('POST', '/api/payment/order', { body: { plan: 'plus' } });
  assert.strictEqual(order.status, 200);
  const orderId = order.json.data.orderId;
  assert.ok(orderId);

  const confirm = await req('POST', '/api/payment/confirm', { body: { orderId, remark: '集成测试' } });
  assert.strictEqual(confirm.status, 200);
  assert.strictEqual(confirm.json.data.status, 'paid');

  const status = await req('GET', '/api/payment/status/' + orderId);
  assert.strictEqual(status.status, 200);
  assert.strictEqual(status.json.data.status, 'paid');
});

test('公告列表可读', async () => {
  const r = await req('GET', '/api/announcement');
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.json.data));
});

test('角色剧情：剧本列表/标签/搜索（无 AI）', async () => {
  const s = await req('GET', '/api/roleplay/scenarios');
  assert.strictEqual(s.status, 200);
  assert.ok(Array.isArray(s.json.data));

  const t = await req('GET', '/api/roleplay/tags');
  assert.strictEqual(t.status, 200);
  assert.ok(t.json.data && Array.isArray(t.json.data.groups), 'tags 返回 { featured, groups }');
});

test('角色剧情会话：保存并读回（resume）', async () => {
  const sid = 'test-scenario-1';
  const msgs = [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好呀，我在' },
  ];
  const save = await req('POST', '/api/roleplay/session', { body: { scenarioId: sid, messages: msgs } });
  assert.strictEqual(save.status, 200, JSON.stringify(save.json));

  const load = await req('GET', '/api/roleplay/session?scenarioId=' + sid);
  assert.strictEqual(load.status, 200);
  assert.ok(Array.isArray(load.json.data.messages), '应返回消息数组');
  assert.strictEqual(load.json.data.messages.length, 2);
  assert.strictEqual(load.json.data.messages[1].content, '你好呀，我在');
});

test('角色剧情点赞：点赞/取消/计数/列表指标/未知剧本', async () => {
  const sid = 'guyushen-songzhi'; // 官方剧本（测试设备 itest-device-1 点赞）
  const like1 = await req('POST', '/api/roleplay/like', { body: { scenarioId: sid } });
  assert.strictEqual(like1.status, 200, JSON.stringify(like1.json));
  assert.strictEqual(like1.json.data.liked, true);
  assert.strictEqual(like1.json.data.count, 1); // 真实点赞数（去重后）= 1

  // 剧本列表应附带点赞数 + 当前用户点赞状态
  const list = await req('GET', '/api/roleplay/scenarios');
  assert.strictEqual(list.status, 200);
  const found = list.json.data.find((x: { id: string }) => x.id === sid);
  assert.ok(found, '官方剧本应在列表中');
  assert.strictEqual(found.likes, 1); // 真实点赞数
  assert.strictEqual(found.likedByMe, true);

  // 再点一次 = 取消点赞
  const like2 = await req('POST', '/api/roleplay/like', { body: { scenarioId: sid } });
  assert.strictEqual(like2.status, 200);
  assert.strictEqual(like2.json.data.liked, false);
  assert.strictEqual(like2.json.data.count, 0); // 取消后真实点赞数回到 0

  // 未知剧本 / 缺参数 → 400
  const bad = await req('POST', '/api/roleplay/like', { body: { scenarioId: 'no-such-scenario' } });
  assert.strictEqual(bad.status, 400);
  const noArg = await req('POST', '/api/roleplay/like', { body: {} });
  assert.strictEqual(noArg.status, 400);
});

test('角色剧情剧本按点赞数排序：点赞越多越靠前', async () => {
  const hot = 'guyushen-songzhi';
  const warm = 'luyan-sunian';
  // 用不同设备分别点赞：hot 点 3 次（3 个设备），warm 点 1 次
  for (const device of ['sort-dev-a', 'sort-dev-b', 'sort-dev-c']) {
    const r = await req('POST', '/api/roleplay/like', { body: { scenarioId: hot }, headers: { 'X-Device-Id': device } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  }
  const w = await req('POST', '/api/roleplay/like', { body: { scenarioId: warm }, headers: { 'X-Device-Id': 'sort-dev-d' } });
  assert.strictEqual(w.status, 200, JSON.stringify(w.json));

  const list = await req('GET', '/api/roleplay/scenarios', { headers: { 'X-Device-Id': 'sort-dev-reader' } });
  assert.strictEqual(list.status, 200);
  const arr = list.json.data as { id: string; likes: number }[];
  // 全列表应按点赞数降序
  for (let i = 0; i < arr.length - 1; i++) {
    assert.ok(arr[i].likes >= arr[i + 1].likes, '列表应按点赞数降序，位置 ' + i + '→' + (i + 1));
  }
  const hotIdx = arr.findIndex(x => x.id === hot);
  const warmIdx = arr.findIndex(x => x.id === warm);
  assert.ok(hotIdx >= 0 && warmIdx >= 0, '剧本应在列表中');
  // 展示点赞数 = 真实点赞数（已移除基础热度）
  assert.strictEqual(arr[hotIdx].likes, 3, 'hot 真实点赞 = 3');
  assert.strictEqual(arr[warmIdx].likes, 1, 'warm 真实点赞 = 1');
});

test('个性化偏好：保存并读回', async () => {
  const g1 = await req('GET', '/api/preferences');
  assert.strictEqual(g1.status, 200);

  const put = await req('PUT', '/api/preferences', { body: { region: 'dongbei', intensity: 'strong', mode: 'clarify' } });
  assert.strictEqual(put.status, 200, JSON.stringify(put.json));
  assert.strictEqual(put.json.data.region, 'dongbei');
  assert.strictEqual(put.json.data.intensity, 'strong');
  assert.strictEqual(put.json.data.mode, 'clarify');

  const g2 = await req('GET', '/api/preferences');
  assert.strictEqual(g2.json.data.region, 'dongbei', '保存后应读回 region');
  assert.strictEqual(g2.json.data.intensity, 'strong', '保存后应读回 intensity');
});

test('个性化偏好：新增地区（闽南/闽东/台湾腔）可保存读回', async () => {
  for (const region of ['minnan', 'mindong', 'taiwan']) {
    const put = await req('PUT', '/api/preferences', { body: { region } });
    assert.strictEqual(put.status, 200, JSON.stringify(put.json));
    assert.strictEqual(put.json.data.region, region, region + ' 应通过校验并读回');
  }
  const g = await req('GET', '/api/preferences');
  assert.strictEqual(g.json.data.region, 'taiwan');
});

test('个性化偏好：只改一项不丢其它项（回归）', async () => {
  await req('PUT', '/api/preferences', { body: { region: 'dongbei' } });
  await req('PUT', '/api/preferences', { body: { intensity: 'strong' } });
  const g = await req('GET', '/api/preferences');
  assert.strictEqual(g.json.data.region, 'dongbei', '改 intensity 后 region 应保留');
  assert.strictEqual(g.json.data.intensity, 'strong');
});

/**
 * 成人档思考模式**已移除**（2026-09-25 产品决定）——端到端钉住"移除干净"：
 *   ① `/api/roleplay/model-config` 不再下发任何 thinking 状态块；
 *   ② 就算客户端照旧提交 `roleplayThinking`，偏好里也不会出现这个字段（路由已不解构它）；
 *   ③ 就算 .env 里残留旧的思考旋钮，成人档请求体的 enable_thinking 仍是 false
 *     （③ 的请求体断言在 test/unit/roleplayModel.test.ts 里，这里只保证接口面干净）。
 */
test('成人档思考模式已移除：model-config 无 thinking 块，偏好里也写不进 roleplayThinking', async () => {
  const dev = { 'X-Device-Id': 'rp-thinking-removed-1' };
  // 模拟「配置残留」：旧的旋钮写回去也必须毫无作用
  const saved = { a: process.env.RP_ZH_THINKING, b: process.env.RP_THINKING_ROLLOUT, c: process.env.RP_THINKING };
  process.env.RP_ZH_THINKING = 'on';
  process.env.RP_THINKING = 'on';
  process.env.RP_THINKING_ROLLOUT = '100';
  try {
    const cfg = await req('GET', '/api/roleplay/model-config', { headers: dev });
    assert.strictEqual(cfg.status, 200, JSON.stringify(cfg.json));
    assert.strictEqual(cfg.json.data.thinking, undefined, 'model-config 不该再下发 thinking（功能已移除）');
    assert.strictEqual(cfg.json.data.routing.thinking, undefined, '路由概览里也不该再有 thinking');

    // 老客户端照旧提交这个字段 → 不该落盘（不报错、静默忽略即可，偏好接口是整包写入）
    const put = await req('PUT', '/api/preferences', { headers: dev, body: { roleplayThinking: true, region: 'dongbei' } });
    assert.strictEqual(put.status, 200, JSON.stringify(put.json));
    assert.strictEqual(put.json.data.roleplayThinking, undefined, '已移除的字段不该被写进偏好');
    assert.strictEqual(put.json.data.region, 'dongbei', '同一包里的其它字段照常生效');
    const g = await req('GET', '/api/preferences', { headers: dev });
    assert.strictEqual(g.json.data.roleplayThinking, undefined);
  } finally {
    if (saved.a === undefined) delete process.env.RP_ZH_THINKING; else process.env.RP_ZH_THINKING = saved.a;
    if (saved.b === undefined) delete process.env.RP_THINKING_ROLLOUT; else process.env.RP_THINKING_ROLLOUT = saved.b;
    if (saved.c === undefined) delete process.env.RP_THINKING; else process.env.RP_THINKING = saved.c;
  }
});

test('管理端：未带/错误 token 401，正确 token 放行', async () => {
  const noAuth = await req('GET', '/api/payment/admin/orders');
  assert.strictEqual(noAuth.status, 401);

  const bad = await req('GET', '/api/payment/admin/orders', { headers: { 'x-admin-token': 'wrong' } });
  assert.strictEqual(bad.status, 401);

  const ok = await req('GET', '/api/payment/admin/orders', { headers: { 'x-admin-token': 'test-admin-token' } });
  assert.strictEqual(ok.status, 200);
  assert.ok(Array.isArray(ok.json.data));
});

test('管理端订单列表：区分「用户付款」与「免费开通」，免费开通不算付费也不算收入', async () => {
  const admin = { headers: { 'x-admin-token': 'test-admin-token' } };
  const { paymentStore } = await import('../../api/services/payment.js');

  // ① 用户付款：下单 → 点「我已付款」→ 运营确认到账
  const paid = paymentStore.createOrder('itest-payer', 'plus', 30);
  paymentStore.confirmPaid(paid.orderId, '微信备注 123');
  paymentStore.markUnlocked(paid.orderId, Date.now() + 30 * 86400000);
  // ② 运营免费开通（试用/赠送）：不经过任何付款
  const free = paymentStore.createOrder('itest-free-user', 'plus', 30);
  paymentStore.markFree(free.orderId);
  paymentStore.markUnlocked(free.orderId, Date.now() + 30 * 86400000);
  // ③ 用户下单后没付款
  const unpaid = paymentStore.createOrder('itest-unpaid', 'pro', 30);

  const all = await req('GET', '/api/payment/admin/orders?status=all', admin);
  assert.strictEqual(all.status, 200, JSON.stringify(all.json));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rowOf = (id: string) => all.json.data.find((r: any) => r.orderId === id);
  assert.strictEqual(rowOf(paid.orderId).source, 'paid', '付费单应标 paid');
  assert.strictEqual(rowOf(free.orderId).source, 'free', '手动开通单应标 free');
  assert.strictEqual(rowOf(unpaid.orderId).status, 'pending', '没付款的单仍是 pending');

  // 小结口径：付费笔数/收入都不含免费开通
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const paidRows = all.json.data.filter((r: any) => r.status === 'unlocked' && r.source !== 'free');
  assert.strictEqual(all.json.summary.paidUnlocked, paidRows.length, '小结付费笔数应与逐行判定一致');
  assert.ok(all.json.summary.freeUnlocked >= 1, '免费开通应单独计数');
  assert.strictEqual(all.json.summary.revenueCny, paidRows.reduce((n: number, r: any) => n + r.price, 0), '付费口径收入 = 付费单合计');

  // 来源筛选（独立的第二个维度）
  const onlyFree = await req('GET', '/api/payment/admin/orders?status=all&source=free', admin);
  assert.ok(onlyFree.json.data.length >= 1, 'source=free 应有结果');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.ok(onlyFree.json.data.every((r: any) => r.source === 'free'), 'source=free 只返回免费开通');
  const onlyPaid = await req('GET', '/api/payment/admin/orders?status=all&source=paid', admin);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.ok(onlyPaid.json.data.every((r: any) => r.source !== 'free'), 'source=paid 不含免费开通');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.ok(onlyPaid.json.data.some((r: any) => r.orderId === paid.orderId), '付费单应在「仅用户付款」里');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.ok(!onlyPaid.json.data.some((r: any) => r.orderId === free.orderId), '免费开通不应出现在「仅用户付款」里');
});

test('管理端：把自测付费单改记为免费开通（不计收入 · 幂等 · 鉴权）', async () => {
  const admin = { headers: { 'x-admin-token': 'test-admin-token' } };
  const { paymentStore } = await import('../../api/services/payment.js');
  // 运营自测：走完整付款流程造一笔「付费单」
  const o = paymentStore.createOrder('itest-selftest', 'plus', 30);
  paymentStore.confirmPaid(o.orderId, '');
  paymentStore.markUnlocked(o.orderId, Date.now() + 30 * 86400000);

  const before = (await req('GET', '/api/payment/admin/stats', admin)).json.data;
  const r = await req('POST', '/api/payment/admin/orders/' + o.orderId + '/mark-free?remark=' + encodeURIComponent('运营自测单'), admin);
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.data.source, 'free', '改记后应归为免费开通');
  assert.strictEqual(r.json.data.changed, true);
  assert.ok(String(r.json.data.remark).includes('运营自测单'), '原因应写进备注');

  const after = (await req('GET', '/api/payment/admin/stats', admin)).json.data;
  assert.strictEqual(after.ordersCount, before.ordersCount - 1, '改记后「付费订单」笔数应 -1');
  assert.strictEqual(after.freeOrdersCount, before.freeOrdersCount + 1, '改记后「免费开通」笔数应 +1');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const paidInList = (await req('GET', '/api/payment/admin/orders?status=all&source=paid', admin)).json.data.some((x: any) => x.orderId === o.orderId);
  assert.strictEqual(paidInList, false, '改记后不应再出现在「仅用户付款」里');

  const again = await req('POST', '/api/payment/admin/orders/' + o.orderId + '/mark-free', admin);
  assert.strictEqual(again.status, 200);
  assert.strictEqual(again.json.data.changed, false, '已是免费开通时不应再改动（幂等）');

  const miss = await req('POST', '/api/payment/admin/orders/does-not-exist/mark-free', admin);
  assert.strictEqual(miss.status, 404, '订单不存在应 404');
  const noAuth = await req('POST', '/api/payment/admin/orders/' + o.orderId + '/mark-free');
  assert.strictEqual(noAuth.status, 401, '无 token 必须 401');
});

test('管理端：用户行为 /activity 区间视图（from/to）与经典全量视图并存', async () => {
  const admin = { headers: { 'x-admin-token': 'test-admin-token' } };

  // 经典无参：保持原结构（buckets、无 mode）
  const classic = await req('GET', '/api/payment/admin/activity', admin);
  assert.strictEqual(classic.status, 200, JSON.stringify(classic.json));
  assert.strictEqual(classic.json.success, true);
  assert.ok(classic.json.data.buckets, '经典视图应含 buckets');
  assert.ok(classic.json.data.totals, '经典视图应含 totals');
  assert.strictEqual(classic.json.data.mode, undefined, '经典视图不应有 mode 字段');

  // 造一个今天的注册 + 登录行为（注册接口会写 activity + 按日行为日志）
  const email = 'activity-range@example.com';
  const code = emailCodeStore.generate(email, 'register');
  const reg = await req('POST', '/api/auth/register', { body: { username: 'activityRange', email, password: 'pass123', code } });
  assert.strictEqual(reg.status, 200, JSON.stringify(reg.json));
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  const ranged = await req('GET', `/api/payment/admin/activity?from=${today}&to=${today}`, admin);
  assert.strictEqual(ranged.status, 200, JSON.stringify(ranged.json));
  assert.strictEqual(ranged.json.success, true);
  const rd = ranged.json.data;
  assert.strictEqual(rd.mode, 'range');
  assert.deepStrictEqual(rd.range, { from: today, to: today });
  assert.ok(rd.registered >= 1, '今日注册应计入区间注册');
  assert.ok(rd.totals.logins >= 1, '注册接口的 login 行为应写入按日日志并计入区间登录');
  const me = rd.users.find((u: any) => u.email === email);
  assert.ok(me, '区间注册用户应出现在区间用户表中');
  assert.ok(me.loginCount >= 1, '该用户区间登录数应 ≥1（来自注册事件）');
  assert.ok(me.cum && me.cum.loginCount >= 1, '区间行应携带 cum 全量（详情弹窗用）');

  // 非法日期 400
  const bad = await req('GET', '/api/payment/admin/activity?from=2026-99-99&to=2026-01-01', admin);
  assert.strictEqual(bad.status, 400);
});

test('管理端：查看用户完整聊天记录（聊一聊 + 角色扮演）', async () => {
  const admin = { headers: { 'x-admin-token': 'test-admin-token' } };
  const uid = 'chat-uid-test';

  // 造数：聊一聊会话 + 角色扮演会话
  memoryStorage.createSession('chat-sess-1');
  memoryStorage.updateSession('chat-sess-1', {
    userId: uid,
    chatTitle: '测试对话',
    chatMessages: [
      { role: 'user', content: '你好，今天有点难过', timestamp: new Date() },
      { role: 'assistant', content: '我在呢，陪着你。', timestamp: new Date() },
    ],
    chatUpdatedAt: new Date(),
  });
  roleplaySessionStore.save(uid, 'scenario-x', [
    { role: 'user', content: '开始剧情' },
    { role: 'assistant', content: '好的，请多指教' },
  ], '想要温柔一点');

  const noAuth = await req('GET', '/api/payment/admin/users/' + uid + '/chat');
  assert.strictEqual(noAuth.status, 401, '未带管理 token 应 401');

  const ok = await req('GET', '/api/payment/admin/users/' + uid + '/chat', admin);
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.json));
  assert.strictEqual(ok.json.success, true);
  assert.strictEqual(ok.json.data.userId, uid);
  assert.strictEqual(ok.json.data.chatSessions.length, 1);
  assert.strictEqual(ok.json.data.chatSessions[0].title, '测试对话');
  assert.strictEqual(ok.json.data.chatSessions[0].messages.length, 2);
  assert.strictEqual(ok.json.data.chatSessions[0].messages[0].role, 'user');
  assert.strictEqual(ok.json.data.chatSessions[0].messages[0].content, '你好，今天有点难过');
  assert.strictEqual(ok.json.data.chatSessions[0].messages[0].hasImage, false);
  assert.strictEqual(ok.json.data.chatSessions[0].messages[1].content, '我在呢，陪着你。');
  assert.strictEqual(ok.json.data.roleplaySessions.length, 1);
  assert.strictEqual(ok.json.data.roleplaySessions[0].userPreference, '想要温柔一点');
  assert.strictEqual(ok.json.data.roleplaySessions[0].messages.length, 2);
  assert.strictEqual(ok.json.data.roleplaySessions[0].messages[0].role, 'user');
  assert.ok(ok.json.data.roleplaySessions[0].messages[0].timestamp, '角色扮演消息应带时间戳');
  assert.ok(ok.json.data.roleplaySessions[0].messages[1].timestamp, '角色扮演消息应带时间戳');

});

test('管理端：游客角色扮演会话写入后端后可被控制台读取', async () => {
  const admin = { headers: { 'x-admin-token': 'test-admin-token' } };
  const dev = { headers: { 'X-Device-Id': 'itest-guest-rp-1' } };

  // 游客身份（无 token）：取解析出的 guest userId
  const q = await req('GET', '/api/payment/quota', dev);
  assert.strictEqual(q.status, 200, JSON.stringify(q.json));
  const guestId = q.json.data.userId;
  assert.ok(guestId, '游客应拿到 userId');

  // 游客（未登录）把剧情会话写到后端
  const save = await req('POST', '/api/roleplay/session', {
    headers: dev.headers,
    body: {
      scenarioId: 'scenario-guest-x',
      messages: [
        { role: 'user', content: '游客剧情开场' },
        { role: 'assistant', content: '好的，我们开始吧' },
      ],
      userPreference: '要轻松一点',
    },
  });
  assert.strictEqual(save.status, 200, JSON.stringify(save.json));
  assert.strictEqual(save.json.success, true);

  // 控制台按该游客 id 读聊天记录 → 能读到角色扮演
  const ok = await req('GET', '/api/payment/admin/users/' + guestId + '/chat', admin);
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.json));
  assert.strictEqual(ok.json.success, true);
  const rp = (ok.json.data.roleplaySessions || []).filter((r) => r.scenarioId === 'scenario-guest-x');
  assert.strictEqual(rp.length, 1, '应能读到游客的角色扮演记录');
  assert.strictEqual(rp[0].messages.length, 2);
  assert.strictEqual(rp[0].userPreference, '要轻松一点');
});

test('管理端：公告发布后可编辑更新（保留 id/创建时间，未编辑语言保留原值）', async () => {
  const admin = { headers: { 'x-admin-token': 'test-admin-token' } };

  const pub = await req('POST', '/api/payment/admin/announcement', {
    headers: admin.headers,
    body: { titleZh: '测试公告', contentZh: '正文', titleTw: '測試公告', contentTw: '正文', titleEn: 'Test', contentEn: 'Body' },
  });
  assert.strictEqual(pub.status, 200, JSON.stringify(pub.json));
  const id = pub.json.data.id;
  assert.ok(id, '发布返回 id');

  const noAuth = await req('POST', '/api/payment/admin/announcement/' + id + '/update', { body: { titleZh: 'x', contentZh: 'x' } });
  assert.strictEqual(noAuth.status, 401, '未带管理 token 应 401');

  const upd = await req('POST', '/api/payment/admin/announcement/' + id + '/update', {
    headers: admin.headers,
    body: { titleZh: '测试公告v2', contentZh: '正文v2', titleTw: '測試公告v2', contentTw: '正文v2' },
  });
  assert.strictEqual(upd.status, 200, JSON.stringify(upd.json));
  assert.strictEqual(upd.json.data.id, id, '更新保留 id');
  assert.strictEqual(upd.json.data.titleZh, '测试公告v2');
  assert.strictEqual(upd.json.data.contentEn, 'Body', '未传英文保留原值');
  assert.strictEqual(upd.json.data.titleEn, 'Test', '未传英文标题保留原值');

  const list = await req('GET', '/api/announcement');
  const item = list.json.data.find((x: any) => x.id === id);
  assert.ok(item, '更新后公告仍存在');
  assert.strictEqual(item.titleZh, '测试公告v2');
  assert.strictEqual(item.updatedAt, upd.json.data.createdAt, '创建时间不变（公开接口映射为 updatedAt）');

  const nf = await req('POST', '/api/payment/admin/announcement/ann-none/update', { headers: admin.headers, body: { titleZh: 'x', contentZh: 'x' } });
  assert.strictEqual(nf.status, 404, '不存在的公告应 404');
});

test('IDOR 防护：他人不能读/写/派生/确认他人会话与订单（P1-01 回归）', async () => {
  // 用户 A：拥有会话与订单
  const devA = { 'X-Device-Id': 'idor-dev-a' };
  const emailA = 'idor-a@example.com';
  const codeA = emailCodeStore.generate(emailA, 'register');
  const regA = await req('POST', '/api/auth/register', { body: { username: 'idora', email: emailA, password: 'pass123', code: codeA }, headers: devA });
  assert.strictEqual(regA.status, 200, JSON.stringify(regA.json));
  const tokenA = regA.json.data.token;
  const quotaA = await req('GET', '/api/payment/quota', { token: tokenA, headers: devA });
  const userIdA = quotaA.json.data.userId;
  assert.ok(userIdA, 'A 应拿到 userId');

  // 用户 B（攻击者，独立设备）
  const devB = { 'X-Device-Id': 'idor-dev-b' };
  const emailB = 'idor-b@example.com';
  const codeB = emailCodeStore.generate(emailB, 'register');
  const regB = await req('POST', '/api/auth/register', { body: { username: 'idorb', email: emailB, password: 'pass123', code: codeB }, headers: devB });
  assert.strictEqual(regB.status, 200, JSON.stringify(regB.json));
  const tokenB = regB.json.data.token;

  // A 的会话（直接播种，避免真实 AI 调用）
  const sid = 'idor-session-1';
  memoryStorage.createSession(sid);
  memoryStorage.updateSession(sid, {
    userId: userIdA,
    chatMessages: [{ role: 'user', content: '我的私密倾诉', timestamp: new Date() }],
  });
  const before = memoryStorage.getSession(sid)!;
  const beforeChatLen = before.chatMessages.length;
  const beforeQ = before.questions.length;

  // B 用 A 的 sessionId 访问 12 个会话端点 → 全部 404（不暴露存在性）
  const attempts: Array<[string, string, unknown?]> = [
    ['GET', '/api/analysis/session/' + sid],
    ['POST', '/api/analysis/chat', { sessionId: sid, message: '偷看' }],
    ['POST', '/api/analysis/chat/stream', { sessionId: sid, message: '偷看' }],
    ['POST', '/api/analysis/questions', { sessionId: sid }],
    ['POST', '/api/analysis/answers', { sessionId: sid, answers: [] }],
    ['POST', '/api/analysis/detailed-analysis', { sessionId: sid }],
    ['POST', '/api/analysis/story', { sessionId: sid }],
    ['POST', '/api/analysis/followup', { sessionId: sid, question: '你记得我倾诉过什么？' }],
    ['POST', '/api/analysis/video', { sessionId: sid }],
    ['POST', '/api/analysis/video/generate', { sessionId: sid }],
    ['GET', '/api/analysis/video/status/' + sid],
    ['POST', '/api/analysis/video/compose', { sessionId: sid }],
  ];
  for (const [method, p, body] of attempts) {
    const r = await req(method, p, { token: tokenB, headers: devB, body });
    assert.strictEqual(r.status, 404, method + ' ' + p + ' 应 404，实际 ' + r.status);
  }

  // A 的会话数据未被篡改（B 的请求被拒：未写入消息、未覆盖问题、未触发记忆提取）
  const after = memoryStorage.getSession(sid)!;
  assert.strictEqual(after.chatMessages.length, beforeChatLen, '聊天消息不应被追加');
  assert.strictEqual(after.questions.length, beforeQ, '问题不应被覆盖');
  assert.strictEqual(after.chatMessages[0].content, '我的私密倾诉', '会话内容应保持原样');

  // 订单归属：A 下单，B 不能确认/查询，A 可查询
  const orderA = await req('POST', '/api/payment/order', { token: tokenA, headers: devA, body: { plan: 'plus' } });
  assert.strictEqual(orderA.status, 200, JSON.stringify(orderA.json));
  const orderIdA = orderA.json.data.orderId;
  const cfB = await req('POST', '/api/payment/confirm', { token: tokenB, headers: devB, body: { orderId: orderIdA, remark: '冒认' } });
  assert.strictEqual(cfB.status, 404, '他人不能确认我的订单');
  const stB = await req('GET', '/api/payment/status/' + orderIdA, { token: tokenB, headers: devB });
  assert.strictEqual(stB.status, 404, '他人不能查询我的订单');
  const stA = await req('GET', '/api/payment/status/' + orderIdA, { token: tokenA, headers: devA });
  assert.strictEqual(stA.status, 200, '本人可查询订单');

  // 本人访问自己的会话 → 200（回归；chat 因无 DEEPSEEK 密钥返回 500，但绝不能是 404 越权）
  const own = await req('GET', '/api/analysis/session/' + sid, { token: tokenA, headers: devA });
  assert.strictEqual(own.status, 200, '本人可读自己的会话');
  const ownChat = await req('POST', '/api/analysis/chat', { token: tokenA, headers: devA, body: { sessionId: sid, message: '继续聊' } });
  assert.notStrictEqual(ownChat.status, 404, '本人会话不应被误判为越权');

  // 清理测试会话
  memoryStorage.deleteSession(sid);
});

test('注销账户：usage/subscription/emailcodes 无 PII 残留（P1-03 回归）', async () => {
  const dev = { 'X-Device-Id': 'del-dev-1' };
  const email = 'del@example.com';
  const code = emailCodeStore.generate(email, 'register');
  const reg = await req('POST', '/api/auth/register', { body: { username: 'deluser', email, password: 'pass123', code }, headers: dev });
  assert.strictEqual(reg.status, 200, JSON.stringify(reg.json));
  const token = reg.json.data.token;
  const quota = await req('GET', '/api/payment/quota', { token, headers: dev });
  const userId = quota.json.data.userId;
  assert.ok(userId);

  // 制造残留：用量记录 + 订阅记录 + 第二枚待用验证码
  usageStore.record(userId, { prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 0 } });
  subscriptionStore.upsert({
    id: 'sub-del-1', userId, plan: 'plus', stripeCustomerId: 'cus_del1', status: 'active',
    currentPeriodEnd: Date.now() + 30 * 86400000, cancelAtPeriodEnd: false, createdAt: Date.now(), updatedAt: Date.now(),
  });
  emailCodeStore.generate(email, 'register');

  // 注销
  const del = await req('DELETE', '/api/auth/account', { token, headers: dev });
  assert.strictEqual(del.status, 200, JSON.stringify(del.json));

  // usage：per-user 记录删除
  assert.strictEqual(usageStore.get(userId), undefined, 'usage 应删除');
  // subscription：记录保留（财务审计）但 PII 清空
  const subs = subscriptionStore.listAll().filter((s) => s.id === 'sub-del-1');
  assert.strictEqual(subs.length, 1, '订阅记录应保留（匿名化）');
  assert.notStrictEqual(subs[0].userId, userId, 'userId 应被清空');
  assert.strictEqual(subs[0].stripeCustomerId, '', 'stripeCustomerId 应被清空');
  // emailcodes：文件内无该邮箱待用码
  const codesFile = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'emailcodes.json'), 'utf8')) as Array<{ email: string }>;
  assert.ok(!codesFile.some((c) => c.email.toLowerCase() === email), '邮箱验证码应清除');
});

test('P1-07 内容降级：聊一聊高危输入返回引导且不扣配额', async () => {
  const dev = { 'X-Device-Id': 'safety-dev-1' };
  const email = 'safety1@example.com';
  const code = emailCodeStore.generate(email, 'register');
  const reg = await req('POST', '/api/auth/register', { body: { username: 'safety1', email, password: 'pass123', code }, headers: dev });
  assert.strictEqual(reg.status, 200, JSON.stringify(reg.json));
  const token = reg.json.data.token;
  const q1 = await req('GET', '/api/payment/quota', { token, headers: dev });
  const remainBefore = q1.json.data.chatFreeRemain;

  const crisis = await req('POST', '/api/analysis/chat', { token, headers: dev, body: { message: '我想自杀' } });
  assert.strictEqual(crisis.status, 200, JSON.stringify(crisis.json));
  assert.match(String(crisis.json.data.reply), /热线|援助|crisis|helpline/, '应返回危机引导');
  assert.match(String(crisis.json.data.reply), /第一|first/, '应包含「安全第一」');

  const boundary = await req('POST', '/api/analysis/chat', { token, headers: dev, body: { message: '教唆犯罪怎么判' } });
  assert.strictEqual(boundary.status, 200, JSON.stringify(boundary.json));
  assert.match(String(boundary.json.data.reply), /没法继续|cannot continue/, '应返回边界引导');

  const q2 = await req('GET', '/api/payment/quota', { token, headers: dev });
  assert.strictEqual(q2.json.data.chatFreeRemain, remainBefore, '降级回复不应扣配额');
});

// 说明：分流引导在配额/登录之前短路，游客即可命中；这里刻意用游客设备避免多消耗注册频率额度
// （/api/auth/register 有每 IP 每小时 15 次的限流，整个集成测试文件已接近该上限）
test('角色扮演指令分流：聊一聊里「来玩角色扮演 / 你扮演我的男友」引导去对应功能，且不扣配额', async () => {
  const dev = { 'X-Device-Id': 'rp-redirect-guest-1' };
  const q1 = await req('GET', '/api/payment/quota', { headers: dev });
  const remainBefore = q1.json.data.chatFreeRemain;

  // ① 功能指令 → 引导去「剧情演绎」，并告知那里能自己创建剧本
  const rp = await req('POST', '/api/analysis/chat', { headers: dev, body: { message: '我们来角色扮演吧' } });
  assert.strictEqual(rp.status, 200, JSON.stringify(rp.json));
  assert.strictEqual(rp.json.data.hint, 'roleplay', JSON.stringify(rp.json));
  assert.match(String(rp.json.data.reply), /剧情演绎/, '应指路「剧情演绎」');
  assert.match(String(rp.json.data.reply), /自己创建剧本/, '应告知可自己创建剧本');

  // ② 角色代入 → 引导在聊一聊「新建角色」
  const cc = await req('POST', '/api/analysis/chat', { headers: dev, body: { message: '你扮演我的男朋友' } });
  assert.strictEqual(cc.status, 200, JSON.stringify(cc.json));
  assert.strictEqual(cc.json.data.hint, 'chatCharacter', JSON.stringify(cc.json));
  assert.match(String(cc.json.data.reply), /新建角色/, '应指路聊一聊新建角色');
  assert.match(String(cc.json.data.reply), /记忆/, '应说明独立记忆等好处');

  // ③ 语言跟随：繁体请求 → 繁体引导
  const tw = await req('POST', '/api/analysis/chat', { headers: { ...dev, 'X-Lang': 'zh-TW' }, body: { message: '我們來角色扮演吧' } });
  assert.strictEqual(tw.json.data.hint, 'roleplay', JSON.stringify(tw.json));
  assert.match(String(tw.json.data.reply), /劇情演繹/, '繁体应返回繁体文案');

  // ④ 引导语会写进会话（用户能回看），但全程不扣配额、无 AI 调用
  assert.ok(Array.isArray(rp.json.data.messages) && rp.json.data.messages.length >= 2, '应写入会话消息');
  const q2 = await req('GET', '/api/payment/quota', { headers: dev });
  assert.strictEqual(q2.json.data.chatFreeRemain, remainBefore, '分流引导不应扣配额');
});

test('角色扮演指令分流：SSE 流式同样返回引导与 hint（无 delta）', async () => {
  const dev = { 'X-Device-Id': 'rp-redirect-guest-2' };
  const q1 = await req('GET', '/api/payment/quota', { headers: dev });

  const res = await fetch(baseUrl + '/api/analysis/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-Id': 'rp-redirect-guest-2' },
    body: JSON.stringify({ message: '进入剧情模式' }),
  });
  assert.strictEqual(res.status, 200);
  const text = await res.text();
  assert.match(text, /"hint":"roleplay"/, 'done 应带 hint=roleplay');
  assert.match(text, /剧情演绎/, 'done 应携带引导文案');
  assert.doesNotMatch(text, /"delta"/, '不应有 AI delta 输出');

  const q2 = await req('GET', '/api/payment/quota', { headers: dev });
  assert.strictEqual(q2.json.data.chatFreeRemain, q1.json.data.chatFreeRemain, 'SSE 分流也不应扣配额');
});

test('重试去重（2026-09-15 修复）：retry=true 且上一条正是这条未获回复的用户消息 → 不再写第二遍', async () => {
  const dev = { 'X-Device-Id': 'chat-retry-dedupe-1' };
  const sid = 'retry-dedupe-s1';
  memoryStorage.createSession(sid);
  memoryStorage.updateSession(sid, {
    chatMessages: [{ role: 'user', content: '进入剧情模式', timestamp: new Date() }],
  });

  const post = (body: unknown) => fetch(baseUrl + '/api/analysis/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...dev },
    body: JSON.stringify(body),
  });

  // ① 客户端「重试上一回合」：复用那条还没被回复的用户消息，只补上这一轮回复
  const r1 = await post({ sessionId: sid, message: '进入剧情模式', retry: true });
  assert.strictEqual(r1.status, 200);
  await r1.text();
  let msgs = memoryStorage.getSession(sid)!.chatMessages || [];
  assert.strictEqual(msgs.filter(m => m.role === 'user').length, 1, '重试不应把用户消息写第二遍');
  assert.strictEqual(msgs.length, 2, '应为 1 条用户消息 + 1 条回复');

  // ② 普通重复发言（不带 retry）：仍按用户真实发言记录两条——去重不能扩大化
  const r2 = await post({ sessionId: sid, message: '进入剧情模式' });
  assert.strictEqual(r2.status, 200);
  await r2.text();
  msgs = memoryStorage.getSession(sid)!.chatMessages || [];
  assert.strictEqual(msgs.filter(m => m.role === 'user').length, 2, '非重试的重复发言必须照常记录');

  memoryStorage.deleteSession(sid);
});

test('AI 失败埋点（2026-09-15 事故后加）：前端上报 → 运营端可见「失败次数 / 自动救回」', async () => {
  const dev = { 'X-Device-Id': 'ai-fail-probe-1' };
  const post = (body: unknown) => fetch(baseUrl + '/api/ai-failure', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...dev },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, json: await r.json() as any }));

  const r1 = await post({ feature: 'roleplay', code: 'NETWORK' }); // 没救回来
  assert.strictEqual(r1.status, 200);
  assert.strictEqual(r1.json.recorded, true);

  const r2 = await post({ feature: 'chat', code: 'TIMEOUT', recovered: true }); // 自动重试救回来了
  assert.strictEqual(r2.json.recorded, true);

  // 非法 feature / 空 body：静默忽略但仍 success（埋点绝不影响用户流程）
  const r3 = await post({ feature: 'bogus' });
  assert.strictEqual(r3.json.recorded, false);

  const noAuth = await req('GET', '/api/payment/admin/ai-failures');
  assert.strictEqual(noAuth.status, 401, '运营接口需要 token');
  const ok = await req('GET', '/api/payment/admin/ai-failures?days=1', { headers: { 'x-admin-token': 'test-admin-token' } });
  assert.strictEqual(ok.status, 200);
  const d = ok.json.data;
  assert.ok(d.total >= 2, '失败次数应含被救回的那次，实际 ' + d.total);
  assert.ok(d.recovered >= 1, '应记到 1 次自动救回');
  assert.ok(d.byCode.NETWORK >= 1 && d.byCode.TIMEOUT >= 1, '原因码分布');
  assert.ok(!/userId|content/.test(JSON.stringify(d)), '埋点里不得出现用户内容/身份字段');
});

test('AI 帮我写剧本：灵感不限字数——不再截断到 500 字（安全审核看全量，违规内容藏在 500 字后也拦）', async () => {
  // 直接建账号发 token（不走 /api/auth/register，避免吃掉该 IP 每小时 15 次的注册限流额度）
  const { accountStore } = await import('../../api/services/accounts.js');
  const reg = accountStore.register({ username: 'rplongidea', email: 'rplongidea@example.com', password: 'pass123' });
  assert.ok(reg.user, JSON.stringify(reg));
  const token = accountStore.createToken(reg.user!.userId);
  const dev = { 'X-Device-Id': 'rp-long-idea-1' };

  // 前 500 字干净、违规内容放在 500 字之后：若仍按 500 字截断就会漏检并继续调用 AI
  const longIdea = '雨夜的咖啡馆，她推门进来躲雨，他说了一句温柔的话。'.repeat(60) + '这段剧情里有谋杀的情节';
  assert.ok(longIdea.length > 500, '测试文本应超过 500 字，实际 ' + longIdea.length);
  const r = await req('POST', '/api/roleplay/custom/draft', { token, headers: dev, body: { idea: longIdea } });
  assert.strictEqual(r.status, 400, JSON.stringify(r.json));
  assert.strictEqual(r.json.code, 'CONTENT_REJECTED', JSON.stringify(r.json));
});

test('P1-07 内容降级：理一理高危输入返回降级分析且不扣配额', async () => {
  const dev = { 'X-Device-Id': 'safety-dev-2' };
  const email = 'safety2@example.com';
  const code = emailCodeStore.generate(email, 'register');
  const reg = await req('POST', '/api/auth/register', { body: { username: 'safety2', email, password: 'pass123', code }, headers: dev });
  assert.strictEqual(reg.status, 200, JSON.stringify(reg.json));
  const token = reg.json.data.token;
  const q1 = await req('GET', '/api/payment/quota', { token, headers: dev });
  const remainBefore = q1.json.data.remainFree;

  const r = await req('POST', '/api/analysis/analyze', { token, headers: dev, body: { emotionInput: '我想自杀' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.match(String(r.json.data.analysis.analysis), /热线|援助|crisis|helpline/, '分析应包含危机引导');
  const q2 = await req('GET', '/api/payment/quota', { token, headers: dev });
  assert.strictEqual(q2.json.data.remainFree, remainBefore, '降级分析不应扣配额');
});

test('理一理：使用自定义角色需登录（analyze 带自定义 characterId 未登录 → 401）', async () => {
  const dev = { 'X-Device-Id': 'structure-char-guest-1' };
  const r = await req('POST', '/api/analysis/analyze', { headers: dev, body: { emotionInput: '我最近有点乱', characterId: 'char-someone' } });
  assert.strictEqual(r.status, 401, JSON.stringify(r.json));
  assert.strictEqual(r.json.code, 'LOGIN_REQUIRED', JSON.stringify(r.json));
});

test('P1-07 内容降级：角色扮演高危输入返回引导（不调 AI）', async () => {
  const dev = { 'X-Device-Id': 'safety-dev-3' };
  const email = 'safety3@example.com';
  const code = emailCodeStore.generate(email, 'register');
  const reg = await req('POST', '/api/auth/register', { body: { username: 'safety3', email, password: 'pass123', code }, headers: dev });
  assert.strictEqual(reg.status, 200, JSON.stringify(reg.json));
  const token = reg.json.data.token;
  const list = await req('GET', '/api/roleplay/scenarios', { token, headers: dev });
  assert.ok(list.json.data && list.json.data.length > 0, '应有剧本');
  const sid = list.json.data[0].id;

  const r = await req('POST', '/api/roleplay/chat', { token, headers: dev, body: { scenarioId: sid, messages: [{ role: 'user', content: '我想自杀' }], lang: 'zh-CN' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.match(String(r.json.data.reply), /热线|援助|crisis|helpline/, '应返回危机引导而非 AI 回复');
});

test('AI 辅助建议：无 DEEPSEEK_API_KEY 时 500 且回滚已扣额度', async () => {
  const dev = { 'X-Device-Id': 'rp-suggest-dev-1' };
  const email = 'rpsuggest@example.com';
  const code = emailCodeStore.generate(email, 'register');
  const reg = await req('POST', '/api/auth/register', { body: { username: 'rpsuggest', email, password: 'pass123', code }, headers: dev });
  assert.strictEqual(reg.status, 200, JSON.stringify(reg.json));
  const token = reg.json.data.token;
  const list = await req('GET', '/api/roleplay/scenarios', { token, headers: dev });
  assert.ok(list.json.data && list.json.data.length > 0, '应有剧本');
  const sid = list.json.data[0].id;
  const quotaBefore = await req('GET', '/api/payment/quota', { token, headers: dev });
  assert.ok(quotaBefore.json.data.chatFreeRemain > 0, '注册后应有免费聊天额度');

  const saved = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = '';
  try {
    const r = await req('POST', '/api/roleplay/suggestions', {
      token, headers: dev,
      body: { scenarioId: sid, messages: [{ role: 'assistant', content: '你回来了。' }], lang: 'zh-CN' },
    });
    assert.strictEqual(r.status, 500, JSON.stringify(r.json));
  } finally {
    if (saved === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = saved;
  }

  const quotaAfter = await req('GET', '/api/payment/quota', { token, headers: dev });
  assert.strictEqual(quotaAfter.json.data.chatFreeRemain, quotaBefore.json.data.chatFreeRemain, '失败后应回滚额度');
});

test('P1-07 内容降级：SSE 流式高危输入返回引导（无 delta）', async () => {
  const dev = { 'X-Device-Id': 'safety-dev-4' };
  const email = 'safety4@example.com';
  const code = emailCodeStore.generate(email, 'register');
  const reg = await req('POST', '/api/auth/register', { body: { username: 'safety4', email, password: 'pass123', code }, headers: dev });
  assert.strictEqual(reg.status, 200, JSON.stringify(reg.json));
  const token = reg.json.data.token;

  const res = await fetch(baseUrl + '/api/analysis/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-Id': 'safety-dev-4', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ message: '我想自杀' }),
  });
  assert.strictEqual(res.status, 200);
  const text = await res.text();
  assert.match(text, /done/, '应返回 SSE done 事件');
  assert.match(text, /热线|援助|crisis|helpline/, 'done 应携带危机引导');
  assert.doesNotMatch(text, /"delta"/, '不应有 AI delta 输出');
});

test('P1-09b 记忆管理：本人可读/删记忆，越权不可（GET/DELETE /api/memory）', async () => {
  const dev = { 'X-Device-Id': 'mem-dev-1' };
  const email = 'mem1@example.com';
  const code = emailCodeStore.generate(email, 'register');
  const reg = await req('POST', '/api/auth/register', { body: { username: 'mem1', email, password: 'pass123', code }, headers: dev });
  assert.strictEqual(reg.status, 200, JSON.stringify(reg.json));
  const token = reg.json.data.token;
  const quota = await req('GET', '/api/payment/quota', { token, headers: dev });
  const userId = quota.json.data.userId;
  assert.ok(userId);

  // 直接向存储写入 2 条记忆
  const { longMemoryStore } = await import('../../api/services/longMemory.js');
  longMemoryStore.addFacts(userId, ['用户喜欢雨天', '用户在备考'], 10);

  // 本人读取
  const list = await req('GET', '/api/memory', { token, headers: dev });
  assert.strictEqual(list.status, 200, JSON.stringify(list.json));
  assert.deepStrictEqual(list.json.data.facts, ['用户喜欢雨天', '用户在备考']);

  // 删除索引 0 → 返回最新列表
  const del = await req('DELETE', '/api/memory/0', { token, headers: dev });
  assert.strictEqual(del.status, 200, JSON.stringify(del.json));
  assert.deepStrictEqual(del.json.data.facts, ['用户在备考']);

  // 越界索引 → 404
  const nf = await req('DELETE', '/api/memory/99', { token, headers: dev });
  assert.strictEqual(nf.status, 404, '越界索引应 404');

  // 角色维度删除：写入自定义角色记忆，按 ?characterId= 删除该维度（不影响小愈维度）
  longMemoryStore.addFacts(userId, ['TA 记得我喜欢雨天'], 10, 'char-a');
  assert.deepStrictEqual(longMemoryStore.getFacts(userId, 'char-a'), ['TA 记得我喜欢雨天']);
  const customDel = await req('DELETE', '/api/memory/0?characterId=char-a', { token, headers: dev });
  assert.strictEqual(customDel.status, 200, JSON.stringify(customDel.json));
  assert.deepStrictEqual(customDel.json.data.facts, [], '角色维度删除后该维度应清空');
  assert.deepStrictEqual(longMemoryStore.getFacts(userId), ['用户在备考'], '缺省（小愈）维度不应受影响');

  // 注销后记忆被清空（与 P1-03 互证）
  const delAcc = await req('DELETE', '/api/auth/account', { token, headers: dev });
  assert.strictEqual(delAcc.status, 200);
  assert.strictEqual(longMemoryStore.getFacts(userId).length, 0, '注销后记忆应清空');
});

test('AI 商业分析：未授权 401；未配置 API Key 时 503（优雅失败）', async () => {
  const noAuth = await req('POST', '/api/payment/admin/ai-summary', { body: {} });
  assert.strictEqual(noAuth.status, 401, '未带管理 token 应 401');

  const saved = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = '';
  try {
    const r = await req('POST', '/api/payment/admin/ai-summary', { headers: { 'x-admin-token': 'test-admin-token' }, body: {} });
    assert.strictEqual(r.status, 503, '未配置 API Key 应返回 503（而非 500/崩溃）');
    assert.match(String(r.json.error), /DEEPSEEK_API_KEY/);
  } finally {
    if (saved === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = saved;
  }
});

test('千世书剧本同步：未登录 401；登录后 PUT/GET 往返；违规内容拒绝', async () => {
  const email = 'wenyou1@example.com';
  const code = emailCodeStore.generate(email, 'register');
  const reg = await req('POST', '/api/auth/register', { body: { username: 'wenyou1', email, password: 'pass123', code } });
  assert.strictEqual(reg.status, 200, JSON.stringify(reg.json));
  const token = reg.json.data.token;

  // 未登录（游客）应 401——账号同步是登录用户功能
  const noAuth = await req('GET', '/api/wenyou/scenarios');
  assert.strictEqual(noAuth.status, 401, '未登录应 401');

  const sc = {
    id: 'itest-story',
    title: '测试剧本',
    intro: '一段测试简介。',
    attributes: [{ key: 'attr1', name: '勇气', initial: 5, max: 10 }],
    openings: [{ name: '开局', prompt: '开局描述' }],
    systemPrompt: '你是一个文字人生模拟器。',
    turnUnit: '回合',
    maxTurns: 20,
    endings: [{ condition: 'attr1<=0', tone: '结局', epilogue: '尾声' }],
  };

  const put = await req('PUT', '/api/wenyou/scenarios', { token, body: { scenarios: [sc] } });
  assert.strictEqual(put.status, 200, JSON.stringify(put.json));
  assert.strictEqual(put.json.data.scenarios.length, 1);

  const get = await req('GET', '/api/wenyou/scenarios', { token });
  assert.strictEqual(get.status, 200);
  assert.strictEqual(get.json.data.scenarios[0].id, 'itest-story', 'GET 应返回刚保存的剧本');

  // 内容安全：违规文本拒绝（红线：自伤/自杀类）
  const bad = await req('PUT', '/api/wenyou/scenarios', {
    token,
    body: { scenarios: [{ ...sc, id: 'bad1', intro: '我想自杀' }] },
  });
  assert.strictEqual(bad.status, 400, '违规内容应 400');
  assert.strictEqual(bad.json.error, 'content_violation');

  // 形状校验：缺必填字段拒绝
  const badShape = await req('PUT', '/api/wenyou/scenarios', { token, body: { scenarios: [{ id: 'x' }] } });
  assert.strictEqual(badShape.status, 400);

  // 注销后剧本应清空
  const del = await req('DELETE', '/api/auth/account', { token });
  assert.strictEqual(del.status, 200);
  const after = await req('GET', '/api/wenyou/scenarios', { token });
  assert.strictEqual(after.status, 401, '注销后 token 失效');
});

test('引荐（B 方案）：被邀人注册立刻 +50；邀请人奖励等「被邀人首次真实使用」才结算（含新账号 ×1.5）', async () => {
  const { accountStore } = await import('../../api/services/accounts.js');
  const { quotaStore } = await import('../../api/services/quota.js');
  const { activityStore } = await import('../../api/services/activity.js');

  // 邀请人：直接注册并回拨 createdAt 到 8 天前（超过加成窗口 → 无 ×1.5），记录其设备/IP
  const inv = accountStore.register({ username: 'referInv', email: 'refer-inv@example.com', password: 'pass123' });
  assert.ok(inv.user, '邀请人注册应成功');
  (inv.user as any).createdAt = Date.now() - 8 * 86400000;
  const invId = inv.user!.userId;
  quotaStore.noteDevice(invId, 'inv-device-x', '9.9.9.9');

  // 被邀人：经邀请人链接注册（不同设备/IP）
  const friendEmail = 'refer-friend@example.com';
  const code = emailCodeStore.generate(friendEmail, 'register');
  const reg = await req('POST', '/api/auth/register', {
    body: { username: 'referFriend', email: friendEmail, password: 'pass123', code, ref: invId },
    headers: { 'X-Device-Id': 'friend-device-y' },
  });
  assert.strictEqual(reg.status, 200, JSON.stringify(reg.json));
  const friendId = reg.json.data.user.userId;

  // 归属 + 被邀人侧立刻发（朋友侧承诺不变）
  assert.strictEqual(quotaStore.getRecord(friendId)?.invitedBy, invId, '应记录邀请归属');
  const fq = quotaStore.getQuota(friendId);
  assert.ok(fq.chatBonusFree >= 50, '被邀人应得引荐 +50 额度（叠加在注册奖励上）');
  // 邀请人侧：注册当刻**不发**，进入待激活（B 方案：门槛装在被邀人侧）
  assert.strictEqual(quotaStore.getRecord(invId)?.bonusFree || 0, 0, '注册当刻不应给邀请人发奖励（等被邀人开口）');
  assert.strictEqual(quotaStore.getRecord(invId)?.inviteCount || 0, 0, '邀请人数此时应为 0');
  assert.strictEqual(quotaStore.getRecord(friendId)?.invitePending, true, '应进入「待激活」');

  // 被邀人首次真实使用（任一功能成功跑通）→ 结算：邀请人 +50（新账号加成 ×1.5 → 75）
  activityStore.trackFeature(friendId, 'chat');
  const boost = quotaStore.inviteBoostFor(invId); // 邀请人 createdAt 回拨到 8 天前 → 无加成
  assert.strictEqual(boost, 1, '注册满 7 天的邀请人没有新账号加成');
  assert.strictEqual(quotaStore.getRecord(invId)?.bonusFree, 50, '结算后邀请人应得 +50 次数');
  assert.strictEqual(quotaStore.getRecord(invId)?.inviteCount, 1, '邀请人数应 +1');
  assert.strictEqual(quotaStore.getRecord(friendId)?.invitePending, false, '结算后不再是待激活');
  // 幂等：再跑一次功能不会重复发
  activityStore.trackFeature(friendId, 'chat');
  assert.strictEqual(quotaStore.getRecord(invId)?.inviteCount, 1, '重复使用不应重复结算');

  // 反套利：同一设备自邀应无效（同设备、不同账号）
  const sameDevEmail = 'refer-samedev@example.com';
  const code2 = emailCodeStore.generate(sameDevEmail, 'register');
  const reg2 = await req('POST', '/api/auth/register', {
    body: { username: 'referSameDev', email: sameDevEmail, password: 'pass123', code: code2, ref: invId },
    headers: { 'X-Device-Id': 'inv-device-x' },
  });
  assert.strictEqual(reg2.status, 200, JSON.stringify(reg2.json));
  const sameId = reg2.json.data.user.userId;
  const sameQ = quotaStore.getQuota(sameId);
  assert.strictEqual(quotaStore.getRecord(sameId)?.invitedBy, invId, '同设备注册仍记录归属（供审计）');
  assert.ok(sameQ.chatBonusFree < 50, '同设备自邀不应获得引荐 +50');
});

/* ---------------- AI 生成剧本（SSE 进度流）---------------- */

test('AI 生成剧本 ?stream=1：门控/校验失败仍是普通 JSON（不开流），错误码语义不变', async () => {
  // 主题为空 / 过长 → 400 JSON（都在开流之前校验）
  const empty = await req('POST', '/api/textgame/generate-scenario?stream=1', { body: { theme: '   ' } });
  assert.strictEqual(empty.status, 400);
  const tooLong = await req('POST', '/api/textgame/generate-scenario?stream=1', { body: { theme: 'x'.repeat(201) } });
  assert.strictEqual(tooLong.status, 400);

  // 游客（非 Pro、无生成额度）→ 402 GEN_PRO_ONLY JSON：前端据此弹 Pro 升级，而不是当成流式错误
  const res = await fetch(baseUrl + '/api/textgame/generate-scenario?stream=1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-Id': 'itest-gen-guest' },
    body: JSON.stringify({ theme: '武侠江湖' }),
  });
  assert.strictEqual(res.status, 402);
  assert.match(String(res.headers.get('content-type') || ''), /application\/json/, '门控失败不应返回 SSE 流');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = (await res.json()) as any;
  assert.strictEqual(json.code, 'GEN_PRO_ONLY');
  assert.strictEqual(json.data?.gen?.allowed, false, '应带上生成额度信息供前端展示');
});

// —— 剧情演绎三模式埋点：走真实路由验证「玩的是哪一个」真的落到了行为记录 ——
test('剧情模式埋点：狼人杀开局（真实路由 /api/wolfcha/credits/consume）写入 mode=werewolf', async () => {
  const { activityStore } = await import('../../api/services/activity.js');
  const { behaviorDailyStore } = await import('../../api/services/behaviorDaily.js');
  const { werewolfLedger } = await import('../../api/services/werewolfLedger.js');

  const wwBefore = werewolfLedger.userSummaries().reduce((s, u) => s + u.games, 0);

  /**
   * ⚠️ 2026-09-27 分档后必须用**注册账号**跑这个用例：
   * 游客档只有 5 条/天，而狼人杀开局准入是「一局预估价 80 点 vs 当日额度」取小
   * （测试进程无 .env → 免费档 30 点 → 准入 30 点）——游客档 10 点会被 402 拦在门外。
   * 那是**规则本身**（游客不该有 20 条去开一局），不是埋点坏了；本用例测的是埋点，故用注册账号。
   */
  const { accountStore } = await import('../../api/services/accounts.js');
  const wwReg = accountStore.register({ username: 'itest-ww-a', email: 'itest-ww-a@example.com', password: 'pass123' });
  const wwToken = accountStore.createToken(wwReg.user!.userId);

  // 全新设备指纹（不能以 test- 开头，否则会被 isTestRequest 跳过——那样就测不到埋点了）。
  // ⚠️ 用裸 fetch 而不是上面的 req()：req() 会先塞一个默认 X-Device-Id，同名不同大小写的两个头
  // 会被 fetch 合并成 "a, b"，deviceId 就不是我们想要的那个了（踩过一次）。
  const res = await fetch(baseUrl + '/api/credits/consume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-Id': 'itest-rpmode-ww', Authorization: 'Bearer ' + wwToken },
    body: JSON.stringify({}),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resJson = (await res.json()) as any;
  assert.strictEqual(res.status, 200, '注册免费档额度足够开局探测：' + JSON.stringify(resJson));

  const wwAfter = werewolfLedger.userSummaries().reduce((s, u) => s + u.games, 0);
  assert.strictEqual(wwAfter, wwBefore + 1, '台账应正好 +1 局');

  // 找出这一局新写进去的行为记录（游客 user id 由 quotaStore 派生，不写死）
  const hit = activityStore.listAll().find((a) => (a.rpModes?.werewolf ?? 0) > 0 && (a.recentActivity || []).some((i) => i.mode === 'werewolf'));
  assert.ok(hit, '应有用户被记上 werewolf 模式');
  assert.strictEqual(hit!.roleplayCount, hit!.rpModes!.werewolf, '狼人杀也计入「剧情演绎」合计（口径：合计 = 三模式之和）');
  assert.strictEqual(hit!.lastMode, 'werewolf', 'lastMode 应记下「最近在玩狼人杀」');
  const item = hit!.recentActivity.find((i) => i.mode === 'werewolf');
  assert.strictEqual(item?.feature, 'roleplay', 'feature 仍是 roleplay（合计口径不变）');
  assert.ok(item?.detail, 'detail 应带局型');

  // 按日日志：狼人杀局数 +1，且合计桶同步 +1（区间视图的「合计 = 三者之和」靠这条）
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const cell = behaviorDailyStore.getUserRange(hit!.userId, day, day);
  assert.strictEqual(cell?.werewolf, 1, '按日日志应记 1 局狼人杀');
  assert.strictEqual(cell?.roleplay, 1, '同一局的 roleplay 合计桶也要 +1');

  // 埋点与台账同源：两者都以同一动作为准，数字必然一致
  const summary = werewolfLedger.userSummaries().find((u) => u.userId === hit!.userId);
  assert.strictEqual(summary?.games, hit!.rpModes!.werewolf, '台账局数 ≡ 埋点局数（同一份口径）');
});

test('剧情模式埋点：测试设备（test- 前缀）只写台账、不进行为统计', async () => {
  const { activityStore } = await import('../../api/services/activity.js');
  const { werewolfLedger } = await import('../../api/services/werewolfLedger.js');
  const before = werewolfLedger.userSummaries().reduce((s, u) => s + u.games, 0);
  const beforeModes = activityStore.listAll().reduce((s, a) => s + (a.rpModes?.werewolf ?? 0), 0);

  // 同样用裸 fetch：deviceId 必须精确是 test- 前缀，isTestRequest 才认得出。
  // 账号同上（2026-09-27 分档：游客档 5 条不足以开一局）；本用例只验「测试设备不写行为统计」。
  const { accountStore } = await import('../../api/services/accounts.js');
  const wwReg2 = accountStore.register({ username: 'itest-ww-b', email: 'itest-ww-b@example.com', password: 'pass123' });
  const wwToken2 = accountStore.createToken(wwReg2.user!.userId);
  const res = await fetch(baseUrl + '/api/credits/consume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-Id': 'test-rpmode-ww', Authorization: 'Bearer ' + wwToken2 },
    body: JSON.stringify({}),
  });
  assert.strictEqual(res.status, 200, JSON.stringify(await res.json()));

  const after = werewolfLedger.userSummaries().reduce((s, u) => s + u.games, 0);
  const afterModes = activityStore.listAll().reduce((s, a) => s + (a.rpModes?.werewolf ?? 0), 0);
  assert.strictEqual(after, before + 1, '台账照旧记（既有行为，未改）');
  assert.strictEqual(afterModes, beforeModes, '测试设备不得污染运营端的行为统计');
});

/**
 * 狼人杀开局拦截：**两种人给两种出路**（2026-09-27 用户拍板 B：「注册才能玩」+ 拦截改成注册引导）。
 *
 * 游客档 5 条 < 开局准入（测试进程 = min(一局 80 点, 免费档 30 点) = 30 点 = 15 条）⇒ 一定开不了局。
 * 这不是"要修掉的 bug"，而是新口径的必然结果；要保证的是**用户看到的是可执行的出路**，不是通用失败：
 *  - 游客 → `reason=guest` + `registerHint=true`（前端据此弹注册）；
 *  - 注册账号（额度不足）→ `reason=insufficient` + `registerHint=false`（出路是等明天/获取额度/升级）。
 * 另外：余额接口必须下发 `minStartTiao`，前端才能**提前**拦住，而不是发一个注定 402 的请求。
 */
test('狼人杀开局拦截：游客 reason=guest/registerHint，注册账号 reason=insufficient（两种出路）', async () => {
  const { accountStore } = await import('../../api/services/accounts.js');
  const { quotaStore, UNIT_CREDIT } = await import('../../api/services/quota.js');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type GateJson = { code?: string; reason?: string; registerHint?: boolean; neededTiao?: number; error?: string };

  // ① 游客
  const guestRes = await fetch(baseUrl + '/api/credits/consume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-Id': 'itest-ww-gate-guest' },
    body: JSON.stringify({}),
  });
  const guestJson = (await guestRes.json()) as GateJson;
  assert.strictEqual(guestRes.status, 402, '游客档开不了局：' + JSON.stringify(guestJson));
  assert.strictEqual(guestJson.code, 'QUOTA_EXCEEDED');
  assert.strictEqual(guestJson.reason, 'guest', '游客 → 出路是注册');
  assert.strictEqual(guestJson.registerHint, true);
  assert.ok((guestJson.neededTiao ?? 0) > 0, '准入下限（条）要下发给前端做提前拦截');
  assert.match(String(guestJson.error), /注册/, '文案必须把注册这条出路说出来');

  // ② 注册账号：先把额度耗到准入之下
  const reg = accountStore.register({ username: 'itest-ww-gate', email: 'itest-ww-gate@example.com', password: 'pass123' });
  const token = accountStore.createToken(reg.user!.userId);
  const regId = reg.user!.userId;
  const cap = quotaStore.getCreditQuota(regId).dailyCap as number;
  const gatePoints = (guestJson.neededTiao ?? 0) * UNIT_CREDIT; // 与路由 MIN_START_CREDIT 同一算法
  const drain = cap - gatePoints + UNIT_CREDIT; // 留 gate - 1 条 ⇒ 差一点点，开不了
  assert.ok(drain > 0, '测试前提：注册账号的日额度必须高于准入');
  assert.strictEqual(quotaStore.reserveCredit(regId, 'chat', { credit: drain }).ok, true, '先把额度耗到准入之下');

  const regRes = await fetch(baseUrl + '/api/credits/consume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-Id': 'itest-ww-gate-reg', Authorization: 'Bearer ' + token },
    body: JSON.stringify({}),
  });
  const regJson = (await regRes.json()) as GateJson;
  assert.strictEqual(regRes.status, 402, '注册账号额度不足也应 402：' + JSON.stringify(regJson));
  assert.strictEqual(regJson.reason, 'insufficient');
  assert.strictEqual(regJson.registerHint, false, '注册账号的出路不是注册');
  assert.doesNotMatch(String(regJson.error), /游客|注册后每天/, '文案不应把注册账号说成游客');

  // ③ 余额接口下发准入下限（前端提前拦截的依据），且与 402 的 neededTiao 同源
  const balRes = await fetch(baseUrl + '/api/credits/balance', { headers: { 'X-Device-Id': 'itest-ww-gate-guest' } });
  const balJson = (await balRes.json()) as { minStartTiao?: number };
  assert.strictEqual(typeof balJson.minStartTiao, 'number', '余额接口必须带 minStartTiao');
  assert.strictEqual(balJson.minStartTiao, guestJson.neededTiao, '两处必须同源（否则前端提前拦截会与服务端判定打架）');
});

// ── 使用时长心跳：身份兜底（sendBeacon 无请求头）+ 测试/内网流量免计 ──
// 回归背景：兜底 flush 走 sendBeacon，带不了 X-Device-Id / Authorization → 旧版只能按 IP 认人，
// 每个出口 IP 变成一个「无设备身份」幽灵游客（真数据 259 个身份、占 13.5% 总时长）。
test('usage-time/hit：无请求头时用 body 里的 deviceId 认人（不再退化成纯 IP 幽灵身份）', async () => {
  const { usageTimeStore } = await import('../../api/services/usageTime.js');
  const { guestIdOf } = await import('../../api/services/session.js');
  process.env.USAGE_TIME_ALLOW_LOCAL = '1'; // 集成测试来自 127.0.0.1（内网），临时放行以便验证落账
  try {
    const dev = 'itest-beacon-dev';
    const expectedId = guestIdOf(dev, '127.0.0.1');
    const before = usageTimeStore.getUserLifetime(expectedId);

    // 模拟 sendBeacon：只带 body 身份，没有任何请求头
    const res = await fetch(baseUrl + '/api/usage-time/hit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seconds: 25, deviceId: dev, beacon: true, vis: true, focus: false, interaction: true }),
    });
    const json = await res.json() as { success: boolean; recorded?: boolean };
    assert.strictEqual(res.status, 200);
    assert.strictEqual(json.recorded, true, '应真的记到时长');
    assert.strictEqual(usageTimeStore.getUserLifetime(expectedId), before + 25, '时长应记在 body 声明的设备身份上');

    // 同一次请求也留下了诊断：可见但无焦点、靠交互判定为在用（WebView 场景）
    const { usageDiagStore } = await import('../../api/services/usageTime.js');
    const diag = usageDiagStore.snapshot();
    assert.ok((diag.reports || 0) >= 1, '诊断计数应有 reports');
    assert.ok((diag.focusFalseVisible || 0) >= 1, '应记下「可见但 hasFocus=false」这一情况');
  } finally {
    delete process.env.USAGE_TIME_ALLOW_LOCAL;
  }
});

test('usage-time/hit：测试设备（test- 前缀）即使走 body 兜底身份也免计', async () => {
  const { usageTimeStore } = await import('../../api/services/usageTime.js');
  const { guestIdOf } = await import('../../api/services/session.js');
  process.env.USAGE_TIME_ALLOW_LOCAL = '1';
  try {
    const dev = 'test-beacon-dev';
    const id = guestIdOf(dev, '127.0.0.1');
    const before = usageTimeStore.getUserLifetime(id);
    const res = await fetch(baseUrl + '/api/usage-time/hit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seconds: 60, deviceId: dev, beacon: true }),
    });
    const json = await res.json() as { recorded?: boolean };
    assert.strictEqual(json.recorded, false, 'test- 设备不得落账');
    assert.strictEqual(usageTimeStore.getUserLifetime(id), before);
  } finally {
    delete process.env.USAGE_TIME_ALLOW_LOCAL;
  }
});

test('usage-time/hit：内网/本地 IP 免计（本地自测/脚本流量不当成游客）', async () => {
  const { usageTimeStore } = await import('../../api/services/usageTime.js');
  const { guestIdOf } = await import('../../api/services/session.js');
  delete process.env.USAGE_TIME_ALLOW_LOCAL; // 生产口径：内网 IP 免计
  const dev = 'itest-local-dev';
  const id = guestIdOf(dev, '127.0.0.1');
  const before = usageTimeStore.getUserLifetime(id);
  const res = await fetch(baseUrl + '/api/usage-time/hit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-Id': dev },
    body: JSON.stringify({ seconds: 30 }),
  });
  const json = await res.json() as { recorded?: boolean };
  assert.strictEqual(json.recorded, false, '来自 127.0.0.1 的上报应免计');
  assert.strictEqual(usageTimeStore.getUserLifetime(id), before);
});

test('usage-time/hit：0 秒兜底诊断只计诊断、不落账（让整段没计到的情况线上可见）', async () => {
  const { usageDiagStore } = await import('../../api/services/usageTime.js');
  process.env.USAGE_TIME_ALLOW_LOCAL = '1';
  try {
    const before = usageDiagStore.snapshot().diagOnly || 0;
    const res = await fetch(baseUrl + '/api/usage-time/hit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seconds: 0, diag: true, deviceId: 'itest-diag-dev', beacon: true, vis: true, focus: false, interaction: false }),
    });
    const json = await res.json() as { recorded?: boolean };
    assert.strictEqual(res.status, 200);
    assert.strictEqual(json.recorded, false, '0 秒不落账');
    const after = usageDiagStore.snapshot();
    assert.strictEqual(after.diagOnly || 0, before + 1, '诊断计数 +1');
    assert.ok((after.gateClosedVisible || 0) >= 1, '应记下「可见但既无焦点也无交互」（WebView 特征）');
  } finally {
    delete process.env.USAGE_TIME_ALLOW_LOCAL;
  }
});

/**
 * 聊一聊「编辑重发」（2026-09，方案 1B + 2A）：服务端按 `editAt` 把历史**回到那条用户消息之前**。
 *
 * 为什么必须在这一层验：聊一聊的历史归服务端且是追加式（`chatMessages.push`），
 * 「改写」在客户端做不了 —— 只有服务端真的截断过，界面上的替换才是真的（否则会话里会出现两遍，
 * 而且 AI 会继续对着旧那句往下说）。
 *
 * 本用例走的是「无 DEEPSEEK_API_KEY → 生成失败」这条既有路径（与上面的配额回滚用例同一手法）：
 * 生成失败不影响我们要验的**历史改写**，而且正好顺带确认「改写 + 生成失败」时不会留下残留。
 */
test('聊一聊「编辑重发」：editAt 命中 → 旧回复被清掉、改写后的内容不重复', async () => {
  const dev = { 'X-Device-Id': 'edit-resend-dev' };
  const quota = await req('GET', '/api/payment/quota', { headers: dev });
  const userId = quota.json.data.userId as string;
  assert.ok(userId, '应拿到该设备的 userId');

  const sid = 'edit-resend-s1';
  const t1 = new Date(Date.now() - 60000);
  memoryStorage.createSession(sid);
  memoryStorage.updateSession(sid, {
    userId,
    chatMessages: [
      { role: 'user', content: '我有点累', timestamp: t1 },
      { role: 'assistant', content: '那就先歇一会儿。', timestamp: new Date(t1.getTime() + 1000) },
    ],
    chatTitle: '我有点累',
  });

  const r = await req('POST', '/api/analysis/chat', {
    headers: dev,
    body: { sessionId: sid, message: '我其实挺难过的', editAt: t1.getTime() },
  });
  assert.strictEqual(r.status, 500, '无 API key → 生成失败（与既有用例同口径）');

  const msgs = memoryStorage.getSession(sid)!.chatMessages!;
  assert.strictEqual(msgs.length, 1, '旧回复被清掉，且**没有**把新旧两句都留下');
  assert.strictEqual(msgs[0].role, 'user');
  assert.strictEqual(msgs[0].content, '我其实挺难过的');
});

test('聊一聊「编辑重发」：editAt 对不上 / 指向的不是最后一条用户消息 → 按普通新消息处理（绝不清历史）', async () => {
  const dev = { 'X-Device-Id': 'edit-resend-dev2' };
  const quota = await req('GET', '/api/payment/quota', { headers: dev });
  const userId = quota.json.data.userId as string;

  const sid = 'edit-resend-s2';
  const t1 = new Date(Date.now() - 60000);
  memoryStorage.createSession(sid);
  memoryStorage.updateSession(sid, {
    userId,
    chatMessages: [
      { role: 'user', content: '第一句', timestamp: t1 },
      { role: 'assistant', content: '第一句的回复', timestamp: new Date(t1.getTime() + 1000) },
      { role: 'user', content: '第二句', timestamp: new Date(t1.getTime() + 2000) },
    ],
  });

  // ① 时间戳对不上（客户端传了个不存在的值）→ 不动历史，照常追加
  await req('POST', '/api/analysis/chat', { headers: dev, body: { sessionId: sid, message: '新的一句', editAt: t1.getTime() + 999 } });
  let msgs = memoryStorage.getSession(sid)!.chatMessages!;
  assert.strictEqual(msgs.length, 4, '对不上 = 普通新消息（老的 3 条都还在）');
  assert.strictEqual(msgs[3].content, '新的一句');

  // ② editAt 指向**更早**那条用户消息（2A 不允许改历史）→ 同样不动历史
  await req('POST', '/api/analysis/chat', { headers: dev, body: { sessionId: sid, message: '又想改第一句', editAt: t1.getTime() } });
  msgs = memoryStorage.getSession(sid)!.chatMessages!;
  assert.strictEqual(msgs.length, 5, '改历史这条请求按普通新消息处理（不做对话树）');
  assert.strictEqual(msgs[0].content, '第一句', '更早的历史原样保留');
  assert.strictEqual(msgs[4].content, '又想改第一句');
});
