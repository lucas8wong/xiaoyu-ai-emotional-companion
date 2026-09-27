import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';

setupTempCwd();
const { customRoleplayStore } = await import('../../api/services/customRoleplay.js');

function make(u: string, title: string) {
  return customRoleplayStore.create(u, { title, aiName: 'AI', aiPersona: '人设', background: '背景', opening: '开场' });
}

test('create：id/默认标题/裁剪', () => {
  const c = make('uCreate', '我的剧本');
  assert.match(c.id, /^custom_/);
  assert.strictEqual(c.title, '我的剧本');
  assert.strictEqual(c.userId, 'uCreate');

  const blank = customRoleplayStore.create('uCreate', { title: '   ' });
  assert.strictEqual(blank.title, '自定义剧情', '空标题回退默认');
});

test('归属隔离：listByUser/get 只看本人', () => {
  const a = make('uA', 'A的');
  make('uB', 'B的');
  assert.strictEqual(customRoleplayStore.listByUser('uA').length, 1);
  assert.strictEqual(customRoleplayStore.get('uA', a.id)?.title, 'A的');
  assert.strictEqual(customRoleplayStore.get('uB', a.id), undefined, '跨用户不可见');
  assert.strictEqual(customRoleplayStore.listByUser('uA')[0].id, a.id);
});

test('listByUser 按最近更新倒序', async () => {
  const first = make('uOrder', '旧');
  await new Promise((r) => setTimeout(r, 3));
  const second = make('uOrder', '新');
  const list = customRoleplayStore.listByUser('uOrder');
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].id, second.id, '最近更新的在前');
  assert.strictEqual(list[1].id, first.id);
});

test('投稿状态机：pending/approved/featured/rejected 流转与公开可见', () => {
  const c = make('uState', '作品');
  assert.strictEqual(customRoleplayStore.getPublished(c.id), undefined, '未投稿不可见');

  // 投稿 → pending（不公开）
  let pub = customRoleplayStore.setPublished('uState', c.id, true);
  assert.strictEqual(pub!.status, 'pending');
  assert.strictEqual(pub!.published, true);
  assert.strictEqual(customRoleplayStore.getPublished(c.id), undefined, '待审核不公开');

  // 运营通过 → approved（公开）
  pub = customRoleplayStore.approve(c.id);
  assert.strictEqual(pub!.status, 'approved');
  assert.ok(customRoleplayStore.getPublished(c.id), '通过后 getPublished 可查到');

  // 设为精选 → featured（公开 + featuredAt）
  pub = customRoleplayStore.setFeatured(c.id, true);
  assert.strictEqual(pub!.status, 'featured');
  assert.strictEqual(pub!.featured, true);
  assert.ok(pub!.featuredAt, '精选应记录 featuredAt');
  assert.ok(customRoleplayStore.getPublished(c.id), '精选仍公开');

  // 取消精选 → 回 approved
  pub = customRoleplayStore.setFeatured(c.id, false);
  assert.strictEqual(pub!.status, 'approved');
  assert.strictEqual(pub!.featured, undefined);

  // 撤回 → pending（不公开，清精选/反馈）
  pub = customRoleplayStore.withdraw(c.id);
  assert.strictEqual(pub!.status, 'pending');
  assert.strictEqual(customRoleplayStore.getPublished(c.id), undefined, '撤回后不公开');

  // 驳回 → rejected + 反馈（不公开）
  pub = customRoleplayStore.reject(c.id, '人设和背景矛盾，请完善');
  assert.strictEqual(pub!.status, 'rejected');
  assert.strictEqual(pub!.reviewNote, '人设和背景矛盾，请完善');
  assert.strictEqual(customRoleplayStore.getPublished(c.id), undefined, '已驳回不公开');

  // 驳回后可通过 → approved（清反馈）
  pub = customRoleplayStore.approve(c.id);
  assert.strictEqual(pub!.status, 'approved');
  assert.strictEqual(pub!.reviewNote, undefined);

  // 取消投稿 → 回 draft
  pub = customRoleplayStore.setPublished('uState', c.id, false);
  assert.strictEqual(pub!.published, false);
  assert.strictEqual(pub!.status, undefined);
  assert.strictEqual(pub!.featured, undefined);
  assert.strictEqual(customRoleplayStore.getPublished(c.id), undefined);

  // 非归属者不可投稿他人剧本
  assert.strictEqual(customRoleplayStore.setPublished('u2', c.id, true), undefined);
});

test('setFeatured 仅允许已投稿剧本', () => {
  const unpub = make('uFeatOnly', '未投稿');
  assert.strictEqual(customRoleplayStore.setFeatured(unpub.id, true), undefined, '未投稿不可精选');

  const pub = make('uFeatOnly', '已投稿');
  customRoleplayStore.setPublished('uFeatOnly', pub.id, true);
  const feat = customRoleplayStore.setFeatured(pub.id, true);
  assert.strictEqual(feat!.status, 'featured');
  assert.strictEqual(feat!.featured, true);
});

test('listPublished / listFeatured（用增量断言避免污染）', () => {
  const beforePub = customRoleplayStore.listPublished().length;
  const a = make('uPubList', 'A');
  const b = make('uPubList', 'B');
  customRoleplayStore.setPublished('uPubList', a.id, true);
  customRoleplayStore.setPublished('uPubList', b.id, true);
  assert.strictEqual(customRoleplayStore.listPublished().length, beforePub + 2);

  const beforeFeat = customRoleplayStore.listFeatured().length;
  customRoleplayStore.setFeatured(a.id, true);
  const featured = customRoleplayStore.listFeatured();
  assert.strictEqual(featured.length, beforeFeat + 1);
  assert.ok(featured.some((x) => x.id === a.id));
  assert.ok(!featured.some((x) => x.id === b.id), '未精选的 b 不进精选');
});

test('listApproved / listPending / listRejected 分层', () => {
  const p = make('uLayers', '待审');
  customRoleplayStore.setPublished('uLayers', p.id, true);
  assert.ok(customRoleplayStore.listPending().some((x) => x.id === p.id), '投稿进入待审核');

  const app = make('uLayers', '已通过');
  customRoleplayStore.setPublished('uLayers', app.id, true);
  customRoleplayStore.approve(app.id);
  assert.ok(customRoleplayStore.listApproved().some((x) => x.id === app.id));
  assert.ok(!customRoleplayStore.listApproved().some((x) => x.id === p.id), '待审核不进一般');

  const rej = make('uLayers', '已驳回');
  customRoleplayStore.setPublished('uLayers', rej.id, true);
  customRoleplayStore.reject(rej.id, '请补充背景');
  assert.ok(customRoleplayStore.listRejected().some((x) => x.id === rej.id));
});

test('delete / deleteByUser', () => {
  const c = make('uDel', '待删');
  assert.strictEqual(customRoleplayStore.delete('uDel', c.id), true);
  assert.strictEqual(customRoleplayStore.delete('uDel', c.id), false);

  const keep = make('uDelUser', 'K');
  customRoleplayStore.deleteByUser('uDelUser');
  assert.strictEqual(customRoleplayStore.get('uDelUser', keep.id), undefined);
  assert.strictEqual(customRoleplayStore.listByUser('uDelUser').length, 0);
});

test('update：本人编辑字段、updatedAt 刷新', () => {
  const rec = make('u-edit', '原标题');
  const updated = customRoleplayStore.update('u-edit', rec.id, { title: '新标题', aiName: '新AI', aiPersona: '新人设', background: '新背景', opening: '新开场' });
  assert.ok(updated);
  assert.strictEqual(updated!.title, '新标题');
  assert.strictEqual(updated!.aiName, '新AI');
  assert.strictEqual(updated!.aiPersona, '新人设');
  assert.ok(updated!.updatedAt >= rec.updatedAt);
  // 读回持久化数据一致
  assert.strictEqual(customRoleplayStore.get('u-edit', rec.id)!.background, '新背景');
});

test('update：他人不可编辑、不存在返回 undefined', () => {
  const rec = make('u-owner', '我的');
  assert.strictEqual(customRoleplayStore.update('u-other', rec.id, { title: '抢' }), undefined);
  assert.strictEqual(customRoleplayStore.update('u-owner', 'no-such', { title: 'x' }), undefined);
  // 原内容未被他人改动
  assert.strictEqual(customRoleplayStore.get('u-owner', rec.id)!.title, '我的');
});

test('update：编辑已投稿剧本 → 投稿/精选/驳回状态复位（防公开副本被静默改写）', () => {
  const rec = make('u-pub', '投稿前');
  customRoleplayStore.setPublished('u-pub', rec.id, true);
  customRoleplayStore.setFeatured(rec.id, true);
  assert.ok(customRoleplayStore.get('u-pub', rec.id)!.featured);
  let updated = customRoleplayStore.update('u-pub', rec.id, { title: '改后' });
  assert.ok(updated);
  assert.strictEqual(updated!.published, false);
  assert.strictEqual(updated!.status, undefined);
  assert.strictEqual(updated!.featured, undefined);

  // 已驳回剧本改稿 → 同样复位为草稿（需重新投稿）
  const rej = make('u-rej', '被驳回');
  customRoleplayStore.setPublished('u-rej', rej.id, true);
  customRoleplayStore.reject(rej.id, '请补充背景');
  updated = customRoleplayStore.update('u-rej', rej.id, { title: '改了再投' });
  assert.strictEqual(updated!.status, undefined);
  assert.strictEqual(updated!.reviewNote, undefined, '改稿后清驳回反馈');
});

test('reassignUser：游客自建剧本并入账号，账号可再读到（标题不再丢）', () => {
  const rec = make('guest_merge', '我的剧本');
  // 游客期间会话/剧本在 guest 名下
  assert.strictEqual(customRoleplayStore.get('guest_merge', rec.id)?.title, '我的剧本');
  customRoleplayStore.reassignUser('guest_merge', 'acc_merge');
  // 并入后：账号能读到标题；游客名下不再有
  assert.strictEqual(customRoleplayStore.get('acc_merge', rec.id)?.title, '我的剧本');
  assert.strictEqual(customRoleplayStore.get('guest_merge', rec.id), undefined);
});

test('findById：跨用户按 id 找（仅标题解析兜底用，不做权限判断）', () => {
  const a = make('uOwner', 'TA 的剧本');
  // 他人用 findById 能取到标题（用于「与你的旅程」解析已游玩剧本的标题）
  assert.strictEqual(customRoleplayStore.findById(a.id)?.title, 'TA 的剧本');
  // 但 get（权限判定）仍跨用户不可见
  assert.strictEqual(customRoleplayStore.get('uOther', a.id), undefined);
});
