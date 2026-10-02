/**
 * 运营通知（adminNotifier）：UGC 投稿 / 待确认订单 / 新用户反馈邮件提醒测试
 * console 模式（默认）下 sendEmail 只写日志，不真实发送，适合断言 subject 是否生成。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';
import type { CustomScenario } from '../../api/services/customRoleplay.js';
import type { Order } from '../../api/services/payment.js';
import type { Feedback } from '../../api/services/feedback.js';

setupTempCwd();

// 设置一个明确的收件邮箱，走 sendEmail 的 console 模式（只打日志）
process.env.ADMIN_NOTIFY_EMAIL = 'ops@example.com';
const { notifyNewUgcSubmission, notifyNewOrderConfirm, notifyNewFeedback, __resetFeedbackMailQuota } =
  await import('../../api/services/adminNotifier.js');

function withLogs(run: () => void): string[] {
  const logs: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
  console.warn = (...args: unknown[]) => { logs.push('WARN:' + args.join(' ')); };
  try {
    run();
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }
  return logs;
}

test('notifyNewUgcSubmission：生成含剧本标题的邮件主题', async () => {
  const rec: CustomScenario = {
    id: 'custom_x', userId: 'u1', title: '测试剧本', aiName: '小愈',
    aiPersona: '', background: '', opening: '',
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  const logs = withLogs(() => { void notifyNewUgcSubmission(rec, { username: '作者A', email: 'a@b.com' }); });
  await new Promise((r) => setImmediate(r));
  assert.ok(logs.some((l) => l.includes('新 UGC 投稿') && l.includes('测试剧本')), '应包含 UGC 投稿且剧本标题 subject');
  assert.ok(logs.some((l) => l.includes('MAIL:console')), '应走邮件发送（console 模式日志）');
});

test('notifyNewOrderConfirm：生成含订单号的邮件主题', async () => {
  const order: Order = {
    orderId: '12345678', userId: 'u1', plan: 'plus', days: 30, purchase: 'monthly',
    price: 35, status: 'paid', source: 'paid', remark: '微信转账 1234', createdAt: Date.now(),
  };
  const logs = withLogs(() => { void notifyNewOrderConfirm(order, { username: '用户B', email: 'u@b.com' }); });
  await new Promise((r) => setImmediate(r));
  assert.ok(logs.some((l) => l.includes('订单待确认') && l.includes('12345678')), '应包含订单待确认且订单号 subject');
  assert.ok(logs.some((l) => l.includes('MAIL:console')), '应走邮件发送（console 模式日志）');
});

test('未配置收件邮箱：日志兜底且不崩溃', async () => {
  delete process.env.ADMIN_NOTIFY_EMAIL;
  delete process.env.MAIL_BCC;
  delete process.env.SMTP_FROM;
  delete process.env.SMTP_USER;
  const rec: CustomScenario = {
    id: 'c', userId: 'u', title: 'T', aiName: 'A', aiPersona: '', background: '', opening: '',
    createdAt: 0, updatedAt: 0,
  };
  const order: Order = {
    orderId: '9', userId: 'u', plan: 'plus', days: 30, purchase: 'monthly',
    price: 35, status: 'paid', source: 'paid', createdAt: 0,
  };
  const logs = withLogs(() => {
    void notifyNewUgcSubmission(rec);
    void notifyNewOrderConfirm(order);
  });
  await new Promise((r) => setImmediate(r));
  assert.ok(logs.some((l) => l.includes('未配置管理通知邮箱')), '未配置收件邮箱应日志兜底');
  assert.ok(!logs.some((l) => l.includes('MAIL:console')), '未配置收件邮箱不应尝试发邮件');
  process.env.ADMIN_NOTIFY_EMAIL = 'ops@example.com';
});

// 【新用户反馈提醒（控制台收到反馈即发邮件；含游客；每日上限防灌水）】

function fb(partial: Partial<Feedback> = {}): Feedback {
  return {
    id: 'fb1', userId: 'u1', type: 'issue', content: '剧情模式打不开，一直转圈',
    contact: 'user@x.com', createdAt: Date.now(), status: 'pending', reward: 0,
    ...partial,
  };
}

test('notifyNewFeedback：每条反馈发一封，主题带类型+内容摘要', async () => {
  process.env.ADMIN_NOTIFY_FEEDBACK_DAILY_CAP = '30';
  __resetFeedbackMailQuota();
  const logs = withLogs(() => {
    void notifyNewFeedback(fb(), { username: '阿明', email: 'ming@x.com' });
  });
  await new Promise((r) => setImmediate(r));
  assert.ok(logs.some((l) => l.includes('新反馈') && l.includes('问题') && l.includes('剧情模式打不开')), '主题应含类型与内容摘要');
  assert.ok(logs.some((l) => l.includes('MAIL:console') && l.includes('ops@example.com')), '应发到运营通知邮箱');
});

test('notifyNewFeedback：游客反馈同样提醒（用户显示为游客/设备）', async () => {
  __resetFeedbackMailQuota();
  const logs = withLogs(() => {
    void notifyNewFeedback(fb({ id: 'fb_guest', type: 'praise', content: '小愈很温柔', contact: undefined }));
  });
  await new Promise((r) => setImmediate(r));
  assert.ok(logs.some((l) => l.includes('新反馈') && l.includes('夸奖')), '游客反馈也应发提醒');
  assert.ok(logs.some((l) => l.includes('游客/设备')), '游客应显示为游客/设备而非空');
});

test('notifyNewFeedback：上下文进正文（便于直接定位问题）', async () => {
  __resetFeedbackMailQuota();
  const logs = withLogs(() => {
    void notifyNewFeedback(fb({ context: '用户：你好\n小愈：网络好像开小差了' }));
  });
  await new Promise((r) => setImmediate(r));
  assert.ok(logs.some((l) => l.includes('AI 对话上下文') && l.includes('网络好像开小差了')), '正文应带对话上下文');
});

test('notifyNewFeedback：超出每日上限只记日志，不再发邮件（反馈不丢）', async () => {
  process.env.ADMIN_NOTIFY_FEEDBACK_DAILY_CAP = '2';
  __resetFeedbackMailQuota();
  const logs = withLogs(() => {
    for (let i = 0; i < 3; i++) void notifyNewFeedback(fb({ id: 'fb' + i, content: '第' + i + '条反馈' }));
  });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(logs.filter((l) => l.includes('[MAIL:console] to=')).length, 2, '上限内应发 2 封');
  assert.ok(logs.some((l) => l.includes('已达上限') && l.includes('fb2')), '超限那条应记日志并标出反馈 id');
  process.env.ADMIN_NOTIFY_FEEDBACK_DAILY_CAP = '30';
  delete process.env.MAIL_BCC;
});

