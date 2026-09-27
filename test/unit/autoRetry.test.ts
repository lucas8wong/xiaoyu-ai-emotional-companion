import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldAutoRetry, failCodeOf, AUTO_RETRY_MAX, AUTO_RETRY_DELAY_MS } from '../../src/lib/autoRetry';

test('自动重试：网络断 / 等超时 / 上游报错 → 值得自动再 call 一次', () => {
  assert.equal(shouldAutoRetry({ code: 'NETWORK' }, false), true);
  assert.equal(shouldAutoRetry({ code: 'TIMEOUT' }, false), true);
  assert.equal(shouldAutoRetry({ code: 'UPSTREAM' }, false), true);
  assert.equal(shouldAutoRetry({}, false), true); // 拿不到原因（老版本/空 code）也按瞬时处理
});

test('自动重试：用户自己取消 → 不能背着用户偷偷再调一次', () => {
  assert.equal(shouldAutoRetry({ code: 'ABORTED' }, false), false);
});

test('自动重试：HTTP 业务错误（额度/未登录/参数）→ 不重试', () => {
  assert.equal(shouldAutoRetry({ code: 'CHAT_QUOTA_EXCEEDED', status: 402 }, false), false);
  assert.equal(shouldAutoRetry({ status: 401 }, false), false);
  assert.equal(shouldAutoRetry({ status: 400 }, false), false);
  // 5xx 是上游/服务端问题 → 值得再试一次
  assert.equal(shouldAutoRetry({ status: 500 }, false), true);
});

test('自动重试：已经收到过内容 → 不重试（重试会把这一段剧情接乱）', () => {
  assert.equal(shouldAutoRetry({ code: 'NETWORK' }, true), false);
  assert.equal(shouldAutoRetry({}, true), false);
});

test('失败原因码归类：code 优先，其次按 HTTP 状态，最后兜底 NETWORK', () => {
  assert.equal(failCodeOf({ code: 'TIMEOUT' }), 'TIMEOUT');
  assert.equal(failCodeOf({ code: '', status: 500 }), 'UPSTREAM');
  assert.equal(failCodeOf({ status: 403 }), 'HTTP_403');
  assert.equal(failCodeOf({}), 'NETWORK');
  assert.equal(failCodeOf(null), 'NETWORK');
});

test('重试预算：立即重 call、且每次用户动作最多自动再试一次', () => {
  assert.equal(AUTO_RETRY_MAX, 1);
  // 用户要求「出问题基本要马上重 call 而不是等」：瞬时失败是连接已坏，等再久那条连接也不会好
  assert.equal(AUTO_RETRY_DELAY_MS, 0, '自动重试必须立即发起（不引入等待）');
});
