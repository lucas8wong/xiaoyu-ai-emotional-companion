/**
 * 运营账号功能覆盖（2026-09-18 用户要求）单测。
 *
 * 需求原话：「管理员账号是 dev-owner@example.com，我需要在控制台可以单独控制这个账号的所有功能」
 * 用户口径：1A（一个「全功能开放」总开关，默认 Pro、可切 Plus/Free）+ 2A（单独一张卡，不进统计）+ 3A（不过期）。
 *
 * 这里钉住的是**底层口径**：开启后 getPlan() 直接返回所选档位、isUnlocked() 视为会员中（不看到期时间），
 * 因此下游全部额度/功能判断（无限点数、每日不限额、上下文窗口、长期记忆…）一处生效；
 * 关闭后原样回到账号自己的 plan / unlockUntil 记录，且**不影响任何别的账号**。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';

setupTempCwd();

// 线上 .env 开着统一点数口径（CREDIT_QUOTA_ENABLED=1）→ Pro 的点数是**无限**。
// 测试进程没有 .env，必须显式打开，否则量到的是旧口径（Pro 也有每日上限），断言会与线上不一致。
process.env.CREDIT_QUOTA_ENABLED = '1';

const { accountStore } = await import('../../api/services/accounts.js');
const { quotaStore, CONTEXT_PRO_COUNT, CONTEXT_PLUS_COUNT, CONTEXT_FREE_COUNT, MEMORY_PRO_COUNT, CHAT_DAILY_LIMIT_COUNT } =
  await import('../../api/services/quota.js');

/** 取该账号的配额记录（不存在则先建：注册本身不建 quota 记录） */
function rec(uid: string) {
  quotaStore.getQuota(uid);
  return quotaStore.getRecord(uid)!;
}

let seq = 0;
function reg(tag: string): string {
  seq += 1;
  const r = accountStore.register({ username: tag + seq, email: tag + seq + '@example.com', password: 'pw123456' });
  assert.ok(r.user, '注册失败: ' + r.error);
  return r.user!.userId;
}

test('运营账号覆盖：默认档位 pro，全功能开放且不看到期时间', () => {
  const uid = reg('ops_pro');
  // 先造成一个「已过期」的普通账号：plan=plus + 到期在过去
  quotaStore.setPlan(uid, 'plus');
  rec(uid).unlockUntil = Date.now() - 86400000;
  assert.strictEqual(quotaStore.getPlan(rec(uid)), 'plus', '前置：过期后按 plus 算（老用户口径）');

  quotaStore.setOpsMode(uid, true, 'pro');
  assert.strictEqual(quotaStore.getOpsState(uid).enabled, true);
  assert.strictEqual(quotaStore.getPlan(rec(uid)), 'pro', '开启后档位锁为 Pro，不受过期影响');
  assert.strictEqual(quotaStore.isUnlocked(rec(uid)), true, '过期也应视为会员中（不过期）');

  const q = quotaStore.getQuota(uid);
  assert.strictEqual(q.plan, 'pro');
  assert.strictEqual(q.unlocked, true);
  assert.strictEqual(q.creditUnlimited, true, 'Pro = 点数无限');
  assert.strictEqual(q.chatLimitPerDay, null, 'Pro = 聊一聊不限条数');
  assert.strictEqual(q.lifetime, true, '对外表现为永久会员（App 侧不显示已过期）');
  assert.ok(Number(q.unlockUntil) > Date.now() + 3000 * 86400000, 'unlockUntil 对外给远期时间');
  assert.strictEqual(quotaStore.getContextWindow(uid), CONTEXT_PRO_COUNT, '上下文窗口按 Pro');
  assert.strictEqual(quotaStore.getMaxMemoryFacts(uid), MEMORY_PRO_COUNT, '长期记忆按 Pro');
});

test('运营账号覆盖：可切成 Plus（保留每日限额，但不过期）与 Free（真的回到免费体验）', () => {
  const uid = reg('ops_switch');
  rec(uid).unlockUntil = Date.now() - 86400000; // 原始记录是过期的

  quotaStore.setOpsMode(uid, true, 'plus');
  let q = quotaStore.getQuota(uid);
  assert.strictEqual(q.plan, 'plus');
  assert.strictEqual(q.unlocked, true, 'Plus 档也不过期');
  assert.strictEqual(q.chatLimitPerDay, CHAT_DAILY_LIMIT_COUNT, 'Plus 仍有每日条数上限');
  assert.strictEqual(q.creditUnlimited, false, 'Plus 不是无限点数');
  assert.strictEqual(quotaStore.getContextWindow(uid), CONTEXT_PLUS_COUNT, '上下文窗口按 Plus');

  quotaStore.setOpsMode(uid, true, 'free');
  q = quotaStore.getQuota(uid);
  assert.strictEqual(q.plan, 'free', 'Free 档要真的按免费算（用于体验用户看到的）');
  assert.strictEqual(q.unlocked, false);
  assert.strictEqual(q.lifetime, false);
  assert.strictEqual(quotaStore.getContextWindow(uid), CONTEXT_FREE_COUNT);
  assert.strictEqual(quotaStore.isUnlocked(rec(uid)), false);
});

test('运营账号覆盖：关闭后原样回到账号自己的记录（历史不丢）', () => {
  const uid = reg('ops_off');
  quotaStore.setPlan(uid, 'plus');
  const until = Date.now() + 5 * 86400000;
  rec(uid).unlockUntil = until;

  quotaStore.setOpsMode(uid, true, 'pro');
  assert.strictEqual(quotaStore.getPlan(rec(uid)), 'pro');
  // 覆盖不改动底层记录
  assert.strictEqual(rec(uid).plan, 'plus', '底层 plan 不被覆盖改动');
  assert.strictEqual(rec(uid).unlockUntil, until, '底层 unlockUntil 不被覆盖改动');

  quotaStore.setOpsMode(uid, false);
  const st = quotaStore.getOpsState(uid);
  assert.strictEqual(st.enabled, false);
  assert.strictEqual(quotaStore.getPlan(rec(uid)), 'plus', '关闭后回到原本的 plus');
  assert.strictEqual(quotaStore.isUnlocked(rec(uid)), true, '原本的有效期仍在');
});

test('运营账号覆盖：只影响自己，别的账号一点不受影响', () => {
  const ops = reg('ops_only');
  const normalA = reg('normal_a');
  const normalB = reg('normal_b');
  quotaStore.setOpsMode(ops, true, 'pro');

  assert.strictEqual(quotaStore.getPlan(rec(ops)), 'pro');
  assert.strictEqual(quotaStore.getPlan(rec(normalA)), 'free');
  assert.strictEqual(quotaStore.getPlan(rec(normalB)), 'free');
  assert.strictEqual(quotaStore.getQuota(normalA).creditUnlimited, false);
  assert.strictEqual(quotaStore.getOpsState(normalA).enabled, false);
  assert.strictEqual(quotaStore.getQuota(normalA).chatLimitPerDay, 0, '普通免费账号仍是 0（免费池口径）');
});
