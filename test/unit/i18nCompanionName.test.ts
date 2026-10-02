/**
 * 内置小愈显示名 + 界面语言一致性的**守卫测试**（2026-09-27 立）。
 *
 * 背景（用户原话：「帮我检查全局并修复确保这类问题不再出现」）：
 * 内置角色的**记录名**恒为「小愈」（后端数据），所以
 *   ① 把角色名直接渲染出来（`{c.name}`），或
 *   ② 写死中文字面量，
 * 在英文界面都会显示成中文。同类 bug 已出现过：聊一聊顶栏、**消息列表行**、
 * 语音设置 aria/title、狼人杀角色名、理一理预填文案、英文词典里的半翻译。
 *
 * 三道守卫：
 *   A. 真源函数按语言返回正确名字（src/lib/companionName.ts）；
 *   B. **英文词典里不许出现中文**（漏翻 / 半翻）；
 *   C. 组件/页面里不许再出现 `小愈` 字面量（注释除外），除非该文件是「中文本体」
 *      （中文语种内容 / 中文 key → 英文 value 的映射表），或该行本身就引用了语言。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CJK = /[\u4e00-\u9fff]/;
const { companionShortName, displayNameForCharacter, isBuiltinCompanion } =
  await import('../../src/lib/companionName.js');

test('A. 内置小愈的显示名跟随界面语言（唯一真源）', () => {
  assert.equal(companionShortName('en'), 'Xiaoyu');
  assert.equal(companionShortName('zh-CN'), '小愈');
  assert.equal(companionShortName('zh-TW'), '小愈');
  // 内置角色的记录名就是「小愈」，但**显示名**必须跟随语言，这就是当初的 bug
  const builtin = { id: 'xiaoyu', isDefault: true, name: '小愈' };
  assert.equal(displayNameForCharacter(builtin, 'en'), 'Xiaoyu');
  assert.equal(displayNameForCharacter(builtin, 'zh-TW'), '小愈');
  // 自定义角色始终用自己的名字
  assert.equal(displayNameForCharacter({ id: 'c1', isDefault: false, name: '哥哥' }, 'en'), '哥哥');
  assert.equal(isBuiltinCompanion(undefined), true);
  assert.equal(isBuiltinCompanion(builtin), true);
  assert.equal(isBuiltinCompanion({ id: 'c1', isDefault: false }), false);
});

test('B. 英文词典里不允许出现中文（漏翻 / 半翻）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/i18n/index.ts'), 'utf8').split(/\r?\n/);
  const enStart = src.findIndex((l) => /^\s{2,}en:\s*\{/.test(l));
  assert.ok(enStart > 0, '找不到英文词典段落（i18n/index.ts 结构变了？）');
  const offenders: string[] = [];
  let inBlock = false;
  for (let i = enStart; i < src.length; i++) {
    let line = src[i];
    // 跳过注释（含多行 JSDoc）：只看真正会渲染的字符串
    if (inBlock) { const close = line.indexOf('*/'); if (close < 0) continue; line = line.slice(close + 2); inBlock = false; }
    const open = line.indexOf('/*');
    if (open >= 0) { const close = line.indexOf('*/', open); if (close < 0) { inBlock = true; line = line.slice(0, open); } else line = line.slice(0, open) + line.slice(close + 2); }
    const slash = line.indexOf('//');
    if (slash >= 0) line = line.slice(0, slash);
    if (!line.trim()) continue;
    // 结尾的语言映射表（'zh-CN': '…'）是有意保留的，跳过
    if (/'zh-(CN|TW)':/.test(line)) continue;
    // 按语言取值的三元（如 lang === 'en' ? 'Xiaoyu' : '小愈'）不算漏翻
    if (/lang ===|getLang|isEn|companionShortName/.test(line)) continue;
    if (CJK.test(line)) offenders.push(`  i18n/index.ts:${i + 1}: ${src[i].trim().slice(0, 120)}`);
  }
  assert.equal(offenders.length, 0, '英文词典里有中文：\n' + offenders.join('\n'));
});

test('C. 组件/页面里不许再写死「小愈」（注释除外）', () => {
  // 这些文件的「中文」是本体内容，不是漏翻：中文语种分支 / 中文 key→英文映射 / 给模型看的提示词
  const ALLOW = [
    'src/i18n/index.ts',
    'src/faqContent.ts',
    'src/seo/zhTw.ts',
    'src/lib/companionName.ts',
    'src/components/FaqPage.tsx',
    'src/components/SeoPage.tsx',
    'src/components/ShareEntryPage.tsx',
    'src/wolfcha/lib/llm.ts',                    // 内部 marker 文案；UI 展示自己翻译过的 toast
    'src/wolfcha/lib/deepseek-prompt-scope.ts',  // 发给模型的提示词，不是界面文案
  ];
  const isAllowed = (rel: string) => ALLOW.includes(rel) || rel.startsWith('src/wenyou/');
  // 该行本身已经引用了语言/真源函数 → 属于「按语言分支」的正当写法
  const speaksLanguage = (line: string) => /getLang|isEn|companionShortName|displayNameForCharacter|displayName\(|wyT\(/.test(line);

  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.tsx?$/.test(e.name)) continue;
      const rel = path.relative(ROOT, p).split(path.sep).join('/');
      if (isAllowed(rel)) continue;
      const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
      let inBlock = false;
      lines.forEach((raw, idx) => {
        let line = raw;
        if (inBlock) { const e2 = line.indexOf('*/'); if (e2 < 0) return; line = line.slice(e2 + 2); inBlock = false; }
        const b = line.indexOf('/*');
        if (b >= 0) { const e2 = line.indexOf('*/', b); if (e2 < 0) { inBlock = true; line = line.slice(0, b); } else line = line.slice(0, b) + line.slice(e2 + 2); }
        const c = line.indexOf('//'); if (c >= 0) line = line.slice(0, c);
        if (!line.includes('小愈')) return;
        if (speaksLanguage(line)) return;
        offenders.push(`  ${rel}:${idx + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
  };
  walk(path.join(ROOT, 'src'));
  assert.equal(
    offenders.length, 0,
    '写死的「小愈」（英文界面会显示中文）。改用 src/lib/companionName.ts 的 companionShortName()/displayNameForCharacter()；' +
    '若该处确实是有意的中文，请把文件加进本测试的 ALLOW 清单：\n' + offenders.join('\n'),
  );
});
