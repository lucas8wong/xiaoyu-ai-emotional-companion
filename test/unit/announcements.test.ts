import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';

setupTempCwd();
const { announcementStore } = await import('../../api/services/announcements.js');

test('add：单语公告三语同值，最多 3 条（新在前）', () => {
  announcementStore.add('公告一', '内容一');
  announcementStore.add('公告二', '内容二');
  announcementStore.add('公告三', '内容三');
  announcementStore.add('公告四', '内容四');

  const list = announcementStore.list();
  assert.strictEqual(list.length, 3, '最多保留 3 条');
  assert.strictEqual(list[0].titleZh, '公告四', '新公告在前');
  assert.strictEqual(list[0].titleEn, '公告四');
  assert.strictEqual(list[0].titleTw, '公告四');
});

test('addLangs：语言缺省回退到中文/任一可用', () => {
  const a = announcementStore.addLangs({ zhCN: { title: '标题', content: '正文' } });
  assert.strictEqual(a.titleZh, '标题');
  assert.strictEqual(a.titleTw, '标题', '缺省回退简体');
  assert.strictEqual(a.titleEn, '标题');

  const b = announcementStore.addLangs({ zhTW: { title: '繁題', content: '繁文' } });
  assert.strictEqual(b.titleZh, '繁題', '缺简体回退到繁体');
  assert.strictEqual(b.titleTw, '繁題');
});

test('update：保留 id/createdAt，语言缺省保留原值', () => {
  const a = announcementStore.addLangs({ zhCN: { title: '中', content: '中C' }, zhTW: { title: '繁', content: '繁C' }, en: { title: 'En', content: 'EnC' } });
  const updated = announcementStore.update(a.id, { zhTW: { title: '新繁', content: '新繁C' } })!;
  assert.strictEqual(updated.id, a.id);
  assert.strictEqual(updated.createdAt, a.createdAt);
  assert.strictEqual(updated.titleZh, '中');
  assert.strictEqual(updated.titleTw, '新繁');
  assert.strictEqual(updated.contentEn, 'EnC');

  assert.strictEqual(announcementStore.update('no-such', {}), null, '不存在返回 null');
});

test('remove', () => {
  const a = announcementStore.add('删我', 'x');
  announcementStore.remove(a.id);
  assert.strictEqual(announcementStore.list().some(x => x.id === a.id), false);
});
