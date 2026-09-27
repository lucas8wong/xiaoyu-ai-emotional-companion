/**
 * 角色剧情扮演 · AI 角色头像 回归测试
 * 核心契约：每个官方剧本的 avatar 都派生为 /img/roleplay/<id>.jpg?v=<内容hash8>（内容 hash 版本化，
 * 配合 immutable 缓存，换图即换 URL 自动失效），且对应图片文件存在；头像文件与剧本 id 一一对应；
 * avatar 只接受受控的站内路径。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENARIOS, listScenarios } from '../../api/services/roleplay.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMG_DIR = path.resolve(__dirname, '../../public/img/roleplay');
const AVATAR_RE = /^\/img\/roleplay\/[A-Za-z0-9-]+\.(jpg|jpeg|png|webp)(\?v=[a-f0-9]{8})?$/;
const fileHash = (id: string) => createHash('md5').update(readFileSync(path.join(IMG_DIR, id + '.jpg'))).digest('hex').slice(0, 8);

test('角色扮演：剧本 avatar 派生正确——有头像文件→?v=内容hash；暂无头像→回退裸站内路径', () => {
  const flat = listScenarios('zh');
  assert.strictEqual(flat.length, SCENARIOS.length, 'listScenarios 数量应与 SCENARIOS 一致');
  for (const s of SCENARIOS) {
    const exists = existsSync(path.join(IMG_DIR, s.id + '.jpg'));
    const expected = exists ? '/img/roleplay/' + s.id + '.jpg?v=' + fileHash(s.id) : '/img/roleplay/' + s.id + '.jpg';
    const item = flat.find((f) => f.id === s.id);
    assert.ok(item, '剧本 id 存在：' + s.id);
    assert.strictEqual(item.avatar, expected, 'avatar 应为 ' + expected);
  }
});

test('角色扮演：头像文件与剧本 id 一一对应（无孤儿文件；暂无头像剧本走 emoji 回退）', () => {
  const ids = new Set(SCENARIOS.map((s) => s.id));
  const files = readdirSync(IMG_DIR).filter((f) => f.endsWith('.jpg')).map((f) => f.replace(/\.jpg$/, ''));
  for (const f of files) {
    assert.ok(ids.has(f), '多余头像文件（无对应剧本）：' + f);
  }
  const withAvatar = SCENARIOS.filter((s) => existsSync(path.join(IMG_DIR, s.id + '.jpg'))).length;
  assert.strictEqual(withAvatar, files.length, '有头像文件的剧本数应等于头像文件数');
});

test('角色扮演：avatar 只接受受控站内路径（防御注入/外链/版本化查询串）', () => {
  for (const item of listScenarios('zh')) {
    assert.match(item.avatar, AVATAR_RE, 'avatar 应为受控站内路径：' + item.avatar);
  }
});
