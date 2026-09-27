import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';

setupTempCwd();

test('buildAuthUrl：生成 Meta OAuth 授权地址（含 app id/redirect/state/scope）', async () => {
  process.env.IG_APP_ID = 'test_app_id';
  process.env.IG_APP_SECRET = 'test_secret';
  // 重新 import 以让模块顶层的 IG_APP_ID 读取到刚才设置的值
  const { buildAuthUrl } = await import('../../api/services/instagram.js');
  const url = new URL(buildAuthUrl('https://myxiaoyu.com/ig/callback', 'state123'));
  assert.strictEqual(url.origin + url.pathname, 'https://www.facebook.com/v21.0/dialog/oauth');
  assert.strictEqual(url.searchParams.get('client_id'), 'test_app_id');
  assert.strictEqual(url.searchParams.get('redirect_uri'), 'https://myxiaoyu.com/ig/callback');
  assert.strictEqual(url.searchParams.get('state'), 'state123');
  assert.strictEqual(url.searchParams.get('response_type'), 'code');
  assert.ok((url.searchParams.get('scope') || '').includes('instagram_business_content_publish'));
});

test('InstagramStore：连接/草稿 CRUD + 发布标记', async () => {
  const { instagramStore } = await import('../../api/services/instagram.js');
  assert.strictEqual(instagramStore.getConnection(), null);

  instagramStore.setConnection({
    igUserId: '178414', igUsername: 'your_xiaoyu', fbPageId: '123', fbPageName: 'Xiaoyu',
    accessToken: 'TOKEN', tokenExpiresAt: Date.now() + 86400000, connectedAt: Date.now(),
  });
  const conn = instagramStore.getConnection()!;
  assert.strictEqual(conn.igUsername, 'your_xiaoyu');
  assert.strictEqual(conn.accessToken, 'TOKEN');

  const draft = instagramStore.addDraft({ type: 'image', caption: '今日心情', mediaUrls: ['https://example.com/1.jpg'] });
  assert.match(draft.id, /-/);
  assert.strictEqual(draft.status, 'draft');
  assert.strictEqual(instagramStore.listDrafts().length, 1);
  assert.strictEqual(instagramStore.getDraft(draft.id)?.caption, '今日心情');

  instagramStore.markPublished(draft.id, { containerId: 'container_1', permalink: 'https://ig.com/p/1' });
  const pub = instagramStore.getDraft(draft.id)!;
  assert.strictEqual(pub.status, 'published');
  assert.strictEqual(pub.containerId, 'container_1');
  assert.ok(pub.publishedAt);

  assert.strictEqual(instagramStore.removeDraft(draft.id), true);
  assert.strictEqual(instagramStore.removeDraft(draft.id), false);
  assert.strictEqual(instagramStore.listDrafts().length, 0);

  instagramStore.clearConnection();
  assert.strictEqual(instagramStore.getConnection(), null);
});
